"use client";
/**
 * Approve and post (update-0091, CHRIS Nov 27): saves a running promo's post photos, makes its posting calendar,
 * readies the All staff announcement, then publishes the launch to the 4 Facebook pages (once Meta is connected).
 * Used by the builder's "Approve and post" and by "Post this promo" on a running promo.
 */
import { createClient } from "@/lib/supabase/browser";
import { drawPromo, type PromoArt } from "@/lib/promoImage";
import { captions } from "@/lib/promoRules";
import { announceText, payLine, postingCalendar, pricingText, serviceLogHow, slotStoryCaption, type PayOptions } from "@/lib/promoPay";
import { postToMeta } from "./meta";

const uuid = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`);
const jpg = (c: HTMLCanvasElement) => new Promise<Blob>((ok, bad) => c.toBlob((b) => (b ? ok(b) : bad(new Error("no image"))), "image/jpeg", 0.95));

export type KitPromo = { id: string; art: PromoArt; pay: PayOptions | null; maxPayments: number | null };
export type KitResult = { ok?: string; error?: string };

export async function sendToPost(k: KitPromo, o: { fonts: { sans: string; serif: string }; today: string; me: string; allRoom: string | null }): Promise<KitResult> {
  const supabase = createClient();
  const p = { title: k.art.title, tagline: k.art.tagline, items: k.art.items, price: k.art.price, months: k.art.months, endsOn: k.art.endsOn ?? null, pay: k.pay, maxPayments: k.maxPayments };
  const caps = captions({ ...p, payNote: k.pay === "INSTALLMENT" ? payLine(p.price, k.pay, k.maxPayments) : null });
  const cal = postingCalendar(o.today, p.endsOn);
  try {
    // 1. Photos: the FB post, the Story, and a Story with its ribbon for each reminder.
    const feed = await drawPromo("feed", k.art, o.fonts);
    const up = async (name: string, c: HTMLCanvasElement) => {
      const path = `${k.id}/${name}-${uuid().slice(0, 8)}.jpg`;
      const { error } = await supabase.storage.from("promo-posts").upload(path, await jpg(c), { contentType: "image/jpeg", upsert: true });
      if (error) throw new Error("upload");
      return path;
    };
    const feedPath = await up("feed", feed);
    const stories = new Map<string, string>();
    for (const r of cal) {
      const key = r.badge ?? "";
      if (!stories.has(key)) stories.set(key, await up(r.badge ? `story-${r.slot.toLowerCase().replace(/_/g, "-")}` : "story", await drawPromo("story", { ...k.art, badge: r.badge }, o.fonts)));
    }
    // 2. The announcement photo goes in the All staff chat folder (only chat members can see it).
    let announcePhoto: string | null = null;
    if (o.allRoom) {
      const path = `${o.allRoom}/${o.me}/${uuid()}.jpg`;
      const { error } = await supabase.storage.from("chat").upload(path, await jpg(feed), { contentType: "image/jpeg" });
      if (!error) announcePhoto = path;
    }
    const installment = k.pay === "INSTALLMENT" && (k.maxPayments ?? 0) >= 2;
    const posts = cal.map((r) => ({
      slot: r.slot, due_on: r.due_on, feed_path: r.feed ? feedPath : null, story_path: stories.get(r.badge ?? "")!,
      feed_caption: r.feed ? caps.feed : null, story_caption: slotStoryCaption(r.slot, caps.story),
    }));
    const { data, error } = await supabase.rpc("promo_post_ready", {
      p_promo: k.id, p_posts: posts, p_pricing: pricingText(p),
      p_announce: announceText({ ...p, serviceLog: serviceLogHow(p.title, installment) }), p_announce_photo: announcePhoto,
    });
    if (error?.code === "PGRST202") return { error: "The owner needs to run update-0091 in Supabase first." };
    if (error || !data?.ok) return { error: "Approved, but the posts couldn't be set up. Open Promo posts and try again." };
    // 3. Publish the launch to the 4 pages, when Meta is connected; otherwise the CSRs post it.
    const { data: launch } = await supabase.from("promo_posts").select("id").eq("promo_id", k.id).eq("slot", "LAUNCH").eq("state", "READY").maybeSingle();
    if (!launch) return { ok: "Posting calendar saved. The launch is already up." };
    const m = await postToMeta(launch.id);
    if (m.notConnected) return { ok: "Approved. The CSRs got the FB post and Story to post on all 4 pages (Clinic › Promo posts). Once they tap Posted, All staff gets the announcement. Connect Meta to post automatically." };
    if (m.error) return { error: `Approved, but Facebook posting didn't finish: ${m.error} Open Promo posts to try again.` };
    return { ok: m.ok ?? "Posted on all 4 pages and announced in All staff." };
  } catch {
    return { error: "Approved, but the post photos couldn't be saved. Check the connection and tap \"Post this promo\" on it below." };
  }
}
