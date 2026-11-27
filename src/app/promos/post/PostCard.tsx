"use client";
import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/browser";
import { savePhoto } from "@/lib/canvasShare";
import { postToMeta } from "../meta";

export type Post = {
  id: string; promo_id: string; title: string; slot: string; due_on: string; state: "READY" | "POSTED" | "SKIPPED"; via: string | null;
  feed_caption: string | null; story_caption: string | null; pricing_text: string | null; posted_at: string | null;
  story_url: string | null; feed_url: string | null; meta_result?: Record<string, { error?: string }> | null;
};

const slug = (t: string) => t.replace(/[^A-Za-z0-9]+/g, "-");

/** One post to put up: photos to save, captions to copy, then Posted (or one tap to Facebook for management). */
export function PostCard({ p, mgmt, metaOn, label, when }: { p: Post; mgmt: boolean; metaOn: boolean; label: string; when: string }) {
  const router = useRouter();
  const [msg, setMsg] = useState<{ ok?: string; error?: string } | null>(null);
  const [pending, start] = useTransition();
  const [files, setFiles] = useState<{ story?: File; feed?: File }>({});
  // Photos are fetched ahead of the tap so iPhone's share sheet opens right away (Save Image = Photos).
  useEffect(() => {
    let live = true;
    const get = async (u: string | null, name: string) => {
      if (!u) return undefined;
      const b = await fetch(u).then((r) => r.blob()).catch(() => null);
      return b ? new File([b], `${name}.jpg`, { type: "image/jpeg" }) : undefined;
    };
    Promise.all([get(p.story_url, `${slug(p.title)}-Story`), get(p.feed_url, `${slug(p.title)}-FB-post`)]).then(([story, feed]) => { if (live) setFiles({ story, feed }); });
    return () => { live = false; };
  }, [p.story_url, p.feed_url, p.title]);

  async function save(k: "story" | "feed") {
    const f = files[k];
    if (f) { await savePhoto(f); return; }
    setMsg({ error: "The photo is still loading. Try again in a moment." });
  }
  async function copy(t: string | null, what: string) {
    if (!t) return;
    try { await navigator.clipboard.writeText(t); setMsg({ ok: `${what} copied.` }); } catch { setMsg({ error: "Could not copy. Select the text and copy it." }); }
  }
  function done() {
    if (!confirm(`Is "${p.title}" (${label}) up on all 4 pages: QC Main, Fairview, Sta. Maria and Marikina?`)) return;
    start(async () => {
      const { data, error } = await createClient().rpc("promo_post_done", { p_post: p.id, p_via: "CSR", p_result: null });
      setMsg(error || !data?.ok ? { error: "Could not save. Try again." } : { ok: data.announced ? "Marked posted. All staff got the announcement." : "Marked posted." });
      router.refresh();
    });
  }
  function meta() {
    if (!confirm(`Post "${p.title}" (${label}) on all 4 Facebook pages now?`)) return;
    start(async () => { setMsg(await postToMeta(p.id)); router.refresh(); });
  }
  function skip() {
    if (!confirm(`Skip the ${label} Story for "${p.title}"?`)) return;
    start(async () => { await createClient().rpc("promo_post_skip", { p_post: p.id }); router.refresh(); });
  }
  const failed = Object.values(p.meta_result ?? {}).filter((r) => r?.error).length;

  return (
    <div className="card promo-post">
      <div className="row-between"><strong>{p.title}</strong><span className="tag">{label}</span></div>
      <p className="small muted">{p.feed_url ? "FB post + Story" : "Story"} on all 4 pages · {when}{failed ? ` · ${failed} page${failed === 1 ? "" : "s"} still to retry` : ""}</p>
      <div className="promo-post-shots">
        {p.story_url && (
          <figure>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={p.story_url} alt={`${p.title} Story`} />
            <figcaption className="row-buttons">
              <button type="button" className="secondary small" onClick={() => save("story")}>Save Story</button>
              <button type="button" className="secondary small" onClick={() => copy(p.story_caption, "Story text")}>Copy text</button>
            </figcaption>
          </figure>
        )}
        {p.feed_url && (
          <figure>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={p.feed_url} alt={`${p.title} FB post`} />
            <figcaption className="row-buttons">
              <button type="button" className="secondary small" onClick={() => save("feed")}>Save FB post</button>
              <button type="button" className="secondary small" onClick={() => copy(p.feed_caption, "FB caption")}>Copy caption</button>
            </figcaption>
          </figure>
        )}
      </div>
      {p.pricing_text && (
        <details className="small">
          <summary>Reply for clients who ask (price, payments, branches)</summary>
          <pre className="promo-pricing">{p.pricing_text}</pre>
          <button type="button" className="secondary small" onClick={() => copy(p.pricing_text, "Reply")}>Copy reply</button>
        </details>
      )}
      <div className="row-buttons">
        {mgmt && metaOn && <button type="button" disabled={pending} onClick={meta}>{pending ? "Posting…" : "Post on all 4 pages now"}</button>}
        <button type="button" className={mgmt && metaOn ? "secondary" : ""} disabled={pending} onClick={done}>Posted on all 4 pages</button>
        {mgmt && p.slot !== "LAUNCH" && <button type="button" className="secondary small" disabled={pending} onClick={skip}>Skip</button>}
      </div>
      {msg?.ok && <div className="notice ok small">{msg.ok}</div>}
      {msg?.error && <div className="notice error small">{msg.error}</div>}
    </div>
  );
}

/** A copy button for one text (the pricing reply on the promo tracker). */
export function CopyText({ text, label }: { text: string; label: string }) {
  const [done, setDone] = useState(false);
  return (
    <button type="button" className="secondary small" onClick={async () => {
      try { await navigator.clipboard.writeText(text); setDone(true); setTimeout(() => setDone(false), 2000); } catch { window.prompt("Copy this:", text); }
    }}>{done ? "Copied" : label}</button>
  );
}
