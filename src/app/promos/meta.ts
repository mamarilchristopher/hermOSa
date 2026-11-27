"use server";
/**
 * Facebook posting for promos (update-0091, CHRIS Nov 27: "Connect Meta directly").
 * Uses a Meta system-user token (Cloudflare secret META_SYSTEM_TOKEN) with pages_manage_posts for the 4 Hermosa pages only.
 * Launch = FB feed photo with its caption + a Page Story on each page; reminders = a Story. Only owners and the GM can publish.
 */
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { can, requireAccess } from "@/lib/access";

const GRAPH = "https://graph.facebook.com/v23.0";
/** The 4 Hermosa pages, never any other page on the same login. */
const HERMOSA_PAGES: { id: string; name: string }[] = [
  { id: "103117851723422", name: "QC Main" },
  { id: "101404945363588", name: "Fairview" },
  { id: "112393681804031", name: "Sta. Maria" },
  { id: "257589974108824", name: "Marikina" },
];
type PageResult = { feed?: string; story?: string; error?: string };
export type MetaResult = { ok?: string; error?: string; notConnected?: boolean };

export async function metaConnected(): Promise<boolean> {
  return !!process.env.META_SYSTEM_TOKEN;
}

async function graph(path: string, params: Record<string, string>, method: "GET" | "POST" = "POST") {
  const body = new URLSearchParams(params);
  const r = method === "GET" ? await fetch(`${GRAPH}/${path}?${body}`) : await fetch(`${GRAPH}/${path}`, { method: "POST", body });
  const j = (await r.json().catch(() => ({}))) as { id?: string; post_id?: string; access_token?: string; success?: boolean; error?: { message?: string } };
  if (!r.ok || j.error) throw new Error(j.error?.message?.slice(0, 160) || `Facebook said ${r.status}`);
  return j;
}

/** Publish one promo post (launch or reminder) to the 4 pages. Pages already done are skipped, so it is safe to retry. */
export async function postToMeta(postId: string): Promise<MetaResult> {
  if (!z.uuid().safeParse(postId).success) return { error: "Refresh the page and try again." };
  const token = process.env.META_SYSTEM_TOKEN;
  if (!token) return { notConnected: true };
  const { supabase, access } = await requireAccess();
  // Only owners and the GM publish to the pages (the database checks again when it's marked done).
  if (!(can(access, ["OWNER"], null) || can(access, ["MANAGER"], null))) return { error: "Only owners and the GM can post to Facebook." };
  const { data: post } = await supabase.from("promo_posts").select("*").eq("id", postId).maybeSingle();
  if (!post) return { error: "That post wasn't found." };
  if (post.state !== "READY") return { ok: "Already posted." };

  const sign = async (path: string | null) => {
    if (!path) return null;
    const { data } = await supabase.storage.from("promo-posts").createSignedUrl(path, 900);
    return data?.signedUrl ?? null;
  };
  const [feedUrl, storyUrl] = await Promise.all([sign(post.feed_path), sign(post.story_path)]);
  if ((post.feed_path && !feedUrl) || (post.story_path && !storyUrl)) return { error: "The post photos couldn't be opened." };

  const prev = (post.meta_result ?? {}) as Record<string, PageResult>;
  const result: Record<string, PageResult> = { ...prev };
  await Promise.all(HERMOSA_PAGES.map(async (pg) => {
    const r: PageResult = { ...(prev[pg.id] ?? {}) };
    delete r.error;
    try {
      const page = await graph(pg.id, { fields: "access_token", access_token: token }, "GET");
      const pt = page.access_token;
      if (!pt) throw new Error("no page access (check the system user's page permissions)");
      if (feedUrl && !r.feed) {
        const f = await graph(`${pg.id}/photos`, { url: feedUrl, caption: post.feed_caption ?? "", published: "true", access_token: pt });
        r.feed = f.post_id ?? f.id;
      }
      if (storyUrl && !r.story) {
        const ph = await graph(`${pg.id}/photos`, { url: storyUrl, published: "false", access_token: pt });
        const st = await graph(`${pg.id}/photo_stories`, { photo_id: String(ph.id), access_token: pt });
        r.story = st.post_id ?? st.id ?? "ok";
      }
    } catch (e) {
      r.error = (e as Error).message;
    }
    result[pg.id] = r;
  }));

  const failed = HERMOSA_PAGES.filter((pg) => result[pg.id]?.error);
  revalidatePath("/promos/post");
  if (failed.length) {
    await supabase.rpc("promo_post_result", { p_post: postId, p_result: result });
    return { error: `${failed.map((pg) => `${pg.name}: ${result[pg.id].error}`).join("; ")}.${failed.length < HERMOSA_PAGES.length ? " The other pages are done." : ""}` };
  }
  const { data: done, error } = await supabase.rpc("promo_post_done", { p_post: postId, p_via: "META", p_result: result });
  if (error || !done?.ok) return { error: "Posted on all 4 pages, but the app couldn't mark it done. Tap Posted on Promo posts." };
  return { ok: `Posted on all 4 pages${done.announced ? " and announced in All staff" : ""}.` };
}
