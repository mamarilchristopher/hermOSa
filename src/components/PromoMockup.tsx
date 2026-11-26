"use client";
import { useEffect, useRef, useState } from "react";
import { drawPromo, type PromoArt } from "@/lib/promoImage";
import { modelSrc, modelsFor } from "@/lib/promoModels";
import { fontsOf } from "@/lib/canvasShare";
import type { PromoItem } from "@/lib/promoRules";

/** The post photo a promo idea would make, shown on its card (CHRIS Nov 27): drawn once the card scrolls into view.
 *  Tap or click it to see it large, with the Story version beside it. Works the same on PC and phones. */
export type MockupIdea = { title: string; tagline: string; items: PromoItem[]; price: number; months: number; season?: string };

const artOf = (idea: MockupIdea, endsOn: string): PromoArt => ({
  title: idea.title, tagline: idea.tagline, items: idea.items, price: idea.price, months: idea.months, endsOn,
  photo: modelSrc(modelsFor(idea.items.map((i) => i.name), idea.season)[0]?.m ?? "M01"),
});

function shrink(c: HTMLCanvasElement, w: number) {
  const s = document.createElement("canvas");
  s.width = w; s.height = Math.round((c.height * w) / c.width);
  s.getContext("2d")!.drawImage(c, 0, 0, s.width, s.height);
  return s.toDataURL("image/jpeg", 0.85);
}

export function PromoMockup({ idea, endsOn, serif }: { idea: MockupIdea; endsOn: string; serif: string }) {
  const box = useRef<HTMLButtonElement>(null);
  const dlg = useRef<HTMLDialogElement>(null);
  const [thumb, setThumb] = useState<string | null>(null);
  const [big, setBig] = useState<{ feed?: string; story?: string }>({});
  const [kind, setKind] = useState<"feed" | "story">("feed");
  const [failed, setFailed] = useState(false);
  const key = JSON.stringify([idea, endsOn]);

  // Draw the FB post photo once the card is near the screen.
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    let live = true;
    const go = async () => {
      try {
        const c = await drawPromo("feed", artOf(idea, endsOn), await fontsOf(serif));
        if (!live) return;
        setThumb(shrink(c, 540)); setBig({ feed: c.toDataURL("image/jpeg", 0.9) });
      } catch { if (live) setFailed(true); }
    };
    if (!("IntersectionObserver" in window)) { go(); return () => { live = false; }; }
    const io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) { io.disconnect(); go(); } }, { rootMargin: "300px" });
    io.observe(el);
    return () => { live = false; io.disconnect(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, serif]);

  async function show(k: "feed" | "story") {
    setKind(k);
    if (!dlg.current?.open) dlg.current?.showModal();
    if (big[k]) return;
    const c = await drawPromo(k, artOf(idea, endsOn), await fontsOf(serif)).catch(() => null);
    if (c) setBig((b) => ({ ...b, [k]: c.toDataURL("image/jpeg", 0.9) }));
  }

  const label = `See the ${idea.title} post photo larger`;
  return (
    <>
      <button ref={box} type="button" className="promo-mock" onClick={() => show("feed")} aria-label={label} title="Tap to enlarge" disabled={failed}>
        {thumb ? <img src={thumb} alt="" /> : <span className="promo-mock-wait">{failed ? "Photo unavailable" : ""}</span>}
        {thumb && <span className="promo-mock-zoom" aria-hidden>⤢</span>}
      </button>
      <dialog ref={dlg} className="promo-lightbox" aria-label={`${idea.title} post photo`}
        onClick={(e) => { if (e.target === dlg.current) dlg.current?.close(); }}>
        <div className="promo-lightbox-bar">
          <span className="promo-lightbox-tabs" role="group" aria-label="Photo size">
            <button type="button" className={kind === "feed" ? "on" : ""} aria-pressed={kind === "feed"} onClick={() => show("feed")}>FB post</button>
            <button type="button" className={kind === "story" ? "on" : ""} aria-pressed={kind === "story"} onClick={() => show("story")}>Story</button>
          </span>
          <button type="button" className="promo-lightbox-x" onClick={() => dlg.current?.close()} aria-label="Close">✕</button>
        </div>
        <div className="promo-lightbox-img" onClick={() => dlg.current?.close()}>
          {big[kind] ? <img src={big[kind]} alt={`${idea.title}: ${kind === "feed" ? "FB post" : "Story"} photo`} onClick={(e) => e.stopPropagation()} /> : <span className="promo-mock-wait" />}
        </div>
      </dialog>
    </>
  );
}
