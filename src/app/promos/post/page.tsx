import Link from "next/link";
import { can, requireAccess } from "@/lib/access";
import { TopBar } from "@/components/TopBar";
import { manilaToday } from "@/lib/dates";
import { SLOT_LABEL, type PostSlot } from "@/lib/promoPay";
import { PostCard, type Post } from "./PostCard";

const day = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString("en-PH", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });

/** Promo posts (update-0091, CHRIS Nov 27): every approved promo's posting calendar. Owners, the GM, CSRs and marketing.
 *  With Meta connected, management posts with one tap; otherwise CSRs post by hand and tap "Posted on all 4 pages". */
export default async function PromoPosts() {
  const { supabase, access } = await requireAccess();
  const mgmt = can(access, ["OWNER"], null) || can(access, ["MANAGER"], null);
  const poster = mgmt || access.grants.some((g) => g.role === "CSR" || g.role === "MARKETING");
  if (!poster) {
    return (<><TopBar access={access} /><main><h1>Promo posts</h1><div className="notice info">Only owners, the GM and CSRs post promos.</div></main></>);
  }
  const today = manilaToday();
  const since = new Date(Date.parse(`${today}T00:00:00Z`) - 14 * 86400000).toISOString().slice(0, 10);
  const { data, error } = await supabase.from("promo_posts").select("*").or(`state.eq.READY,due_on.gte.${since}`).order("due_on").order("slot").limit(80);
  if (error) {
    return (<><TopBar access={access} /><main><h1>Promo posts</h1><div className="notice info">The owner needs to run update-0091 in Supabase first.</div></main></>);
  }
  const rows = (data ?? []) as (Post & { story_path: string | null; feed_path: string | null })[];
  const paths = [...new Set(rows.flatMap((r) => [r.story_path, r.feed_path]).filter((x): x is string => !!x))];
  const { data: signed } = paths.length ? await supabase.storage.from("promo-posts").createSignedUrls(paths, 3600) : { data: [] };
  const url = new Map((signed ?? []).map((s) => [s.path, s.signedUrl]));
  const posts: Post[] = rows.map((r) => ({ ...r, story_url: r.story_path ? url.get(r.story_path) ?? null : null, feed_url: r.feed_path ? url.get(r.feed_path) ?? null : null }));
  const due = posts.filter((p) => p.state === "READY" && p.due_on <= today);
  const later = posts.filter((p) => p.state === "READY" && p.due_on > today);
  const done = posts.filter((p) => p.state !== "READY").reverse();
  const metaOn = !!process.env.META_SYSTEM_TOKEN;

  return (
    <>
      <TopBar access={access} />
      <main className="promos">
        {mgmt && <p className="small"><Link href="/promos">← Promos</Link></p>}
        <h1>Promo posts</h1>
        <p className="muted small">
          Each approved promo has a posting calendar: on launch day the FB post and the Story go up on all 4 pages (QC Main, Fairview, Sta. Maria, Marikina), then a reminder Story, &quot;Last 3 days&quot; and &quot;Last day&quot;.
          {metaOn ? " Owners and the GM can post straight to the 4 pages with one tap." : " Save the photos, post them on each page with the caption, then tap Posted on all 4 pages."}
          {" "}When the launch is up, All staff gets the announcement automatically.
        </p>

        <h2>To post today{due.length ? ` (${due.length})` : ""}</h2>
        {due.length === 0 && <p className="small muted">Nothing to post today.</p>}
        <div className="promo-posts">{due.map((p) => <PostCard key={p.id} p={p} mgmt={mgmt} metaOn={metaOn} label={SLOT_LABEL[p.slot as PostSlot]} when={p.due_on < today ? `was due ${day(p.due_on)}` : "today"} />)}</div>

        {later.length > 0 && (
          <>
            <h2>Coming up</h2>
            <div className="table-wrap">
              <table>
                <thead><tr><th>Date</th><th>Promo</th><th>Post</th></tr></thead>
                <tbody>{later.map((p) => <tr key={p.id}><td>{day(p.due_on)}</td><td>{p.title}</td><td>{SLOT_LABEL[p.slot as PostSlot]}{p.feed_url ? " · FB post + Story" : " · Story"}</td></tr>)}</tbody>
              </table>
            </div>
          </>
        )}

        {done.length > 0 && (
          <>
            <h2>Posted (last 2 weeks)</h2>
            <ul className="small">
              {done.map((p) => <li key={p.id}>{day(p.due_on)} · {p.title} · {SLOT_LABEL[p.slot as PostSlot]}: {p.state === "SKIPPED" ? "skipped" : p.via === "META" ? "posted by the app" : "posted by hand"}{p.posted_at ? `, ${new Date(p.posted_at).toLocaleString("en-PH", { timeZone: "Asia/Manila", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}` : ""}</li>)}
            </ul>
          </>
        )}
      </main>
    </>
  );
}
