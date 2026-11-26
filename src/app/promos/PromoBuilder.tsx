"use client";
import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import {
  adIssues, organicOnly, captions, commissionPerSession, defaultPrice, isBundle, peso, safetyFor, safetyIssues, sessionsOf, thinItems, titleIdeas, usualCount,
  valueOf, SEASONS, type Pkg, type PromoItem, type Suggestion,
} from "@/lib/promoRules";
import { modelSrc, modelsFor } from "@/lib/promoModels";
import { drawPromo } from "@/lib/promoImage";
import { approvePromo, endPromo, savePromo, type PromoInput } from "./actions";

export type Svc = { id: string; name: string; price: number };
export type SavedPromo = {
  id: string; title: string; tagline: string | null; items: { service_id: string; name: string; paid: number; free: number; unit_cents: number }[];
  price_cents: number; value_cents: number; sessions: number; valid_months: number; ends_on: string | null; model: string | null;
  source: "MANUAL" | "SUGGESTED"; state: "DRAFT" | "APPROVED" | "ENDED"; created_at: string; approved_at: string | null;
};

type Draft = { id: string | null; title: string; tagline: string; items: PromoItem[]; price: number; auto: boolean; months: number; endsOn: string; model: string; season: string; source: "MANUAL" | "SUGGESTED" };

const addDays = (d: string, n: number) => new Date(new Date(`${d}T00:00:00Z`).getTime() + n * 86400000).toISOString().slice(0, 10);
const KIND: Record<Suggestion["kind"], string> = { SEASON: "Season", SLOW: "Slow seller", PROGRAM: "Year-long program" };

function blank(today: string): Draft {
  return { id: null, title: "", tagline: "", items: [], price: 0, auto: true, months: 3, endsOn: addDays(today, 13), model: "", season: "", source: "MANUAL" };
}
const php = (c: number) => String(Math.round(c / 100));

/** The promo builder (update-0086): +/− sessions, live price and images, captions, save and approve. */
export function PromoBuilder({ services, ideas, seasons, today, saved, serif, serifClass, pkgs = [] }: {
  pkgs?: Pkg[]; services: Svc[]; ideas: Suggestion[]; seasons: string[]; today: string; saved: SavedPromo[]; serif: string; serifClass: string;
}) {
  const [d, setD] = useState<Draft>(() => blank(today));
  const [story, setStory] = useState<string | null>(null);
  const [feed, setFeed] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok?: string; error?: string } | null>(null);
  const [pending, start] = useTransition();
  const builderRef = useRef<HTMLDivElement>(null);
  const canvases = useRef<{ story?: HTMLCanvasElement; feed?: HTMLCanvasElement }>({});

  const n = sessionsOf(d.items);
  const value = valueOf(d.items);
  const price = d.auto ? defaultPrice(d.items, pkgs) : d.price;
  const season = SEASONS.find((s) => s.name === d.season);
  const models = useMemo(() => modelsFor(d.items.map((i) => i.name), d.season), [d.items, d.season]);
  const model = d.model || models[0]?.m || "M01";
  const issues = safetyIssues(d.items, d.months);
  const off = value > 0 ? 1 - price / value : 0;
  const ideasForTitle = titleIdeas(d.items, season);
  const caps = d.items.length ? captions({ title: d.title || "Your promo title", tagline: d.tagline, items: d.items, price, months: d.months, endsOn: d.endsOn || null }) : null;
  const thin = thinItems(d.items, d.months);
  const ads = caps ? [...organicOnly(d.items), ...adIssues(d.title, d.tagline, caps.story, caps.feed)] : [];
  const change = (p: Partial<Draft>) => { setD((x) => ({ ...x, ...p })); setMsg(null); };

  // Live images: redrawn a moment after every change.
  useEffect(() => {
    if (!d.items.length) { setStory(null); setFeed(null); return; }
    let live = true;
    const t = setTimeout(async () => {
      await document.fonts.load(`700 80px ${serif}`).catch(() => null);
      await document.fonts.ready;
      const art = { title: d.title || "Your promo title", tagline: d.tagline, items: d.items, price, months: d.months, endsOn: d.endsOn || null, photo: modelSrc(model) };
      const fonts = { sans: getComputedStyle(document.body).fontFamily || "sans-serif", serif };
      const [s, f] = await Promise.all([drawPromo("story", art, fonts), drawPromo("feed", art, fonts)]);
      if (!live) return;
      canvases.current = { story: s, feed: f };
      setStory(s.toDataURL("image/jpeg", 0.85)); setFeed(f.toDataURL("image/jpeg", 0.85));
    }, 150);
    return () => { live = false; clearTimeout(t); };
  }, [d, price, model, serif]);

  function open(next: Draft) {
    setD(next); setMsg(null);
    setTimeout(() => builderRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
  }
  function openIdea(s: Suggestion) {
    open({ ...blank(today), title: s.title, tagline: s.tagline, items: s.items.map((i) => ({ ...i })), price: s.price, auto: s.price === defaultPrice(s.items, pkgs), months: s.months, season: s.season ?? "", source: "SUGGESTED" });
  }
  function openSaved(p: SavedPromo) {
    const items = p.items.map((i) => ({ service_id: i.service_id, name: i.name, unit: i.unit_cents, paid: i.paid, free: i.free }));
    open({ id: p.state === "DRAFT" ? p.id : null, title: p.title, tagline: p.tagline ?? "", items, price: p.price_cents, auto: p.price_cents === defaultPrice(items, pkgs),
      months: p.valid_months, endsOn: p.ends_on ?? "", model: p.model ?? "", season: "", source: p.source });
  }
  function setItem(k: number, p: Partial<PromoItem>) {
    change({ items: d.items.map((it, i) => (i === k ? { ...it, ...p } : it)) });
  }
  function addService(id: string) {
    const s = services.find((x) => x.id === id);
    if (!s || d.items.some((i) => i.service_id === id) || d.items.length >= 8) return;
    const items = [...d.items, { service_id: s.id, name: s.name, unit: s.price, paid: d.items.length ? 6 : 5, free: d.items.length ? 0 : 1 }];
    change({ items, title: d.title || titleIdeas(items, season)[0] || "" });
  }
  const input = (): PromoInput => ({
    id: d.id, title: d.title.trim(), tagline: d.tagline.trim(), items: d.items.map((i) => ({ service_id: i.service_id, paid: i.paid, free: i.free })),
    price, months: d.months, endsOn: d.endsOn || null, model, source: d.source,
  });
  function save(approve: boolean) {
    if (approve && !confirm(`Approve "${d.title}" at ${peso(price)}? It will be added to the Service log so staff can log it.`)) return;
    start(async () => {
      const r = approve ? await approvePromo(input()) : await savePromo(input());
      setMsg(r);
      if (r.id && !approve) setD((x) => ({ ...x, id: r.id ?? null }));
      if (r.ok && approve) setD((x) => ({ ...x, id: null }));
    });
  }
  function end(p: SavedPromo) {
    if (!confirm(p.state === "DRAFT" ? `Delete the draft "${p.title}"?` : `End "${p.title}"? Its Service log item will be hidden.`)) return;
    start(async () => setMsg(await endPromo(p.id)));
  }
  const fileName = (title: string, kind: "story" | "feed") => `${(title || "Promo").replace(/[^A-Za-z0-9]+/g, "-")}-${kind === "story" ? "Story" : "FB-post"}.png`;
  async function download(kind: "story" | "feed") {
    const c = canvases.current[kind];
    if (c) await saveCanvas(Promise.resolve(c), fileName(d.title, kind));
  }
  async function copyImage(kind: "story" | "feed") {
    const c = canvases.current[kind];
    if (!c) return;
    setMsg((await copyCanvas(Promise.resolve(c))) ? { ok: `${kind === "story" ? "Story" : "FB post"} copied. Paste it in a chat or post.` } : { error: COPY_FAIL });
  }
  async function copy(text: string) {
    try { await navigator.clipboard.writeText(text); setMsg({ ok: "Caption copied." }); } catch { setMsg({ error: "Could not copy. Select the text and copy it." }); }
  }

  const drafts = saved.filter((p) => p.state === "DRAFT");
  const live = saved.filter((p) => p.state === "APPROVED");
  const ended = saved.filter((p) => p.state === "ENDED").slice(0, 10);

  return (
    <div>
      {/* loads the serif used on the images */}
      <span className={serifClass} aria-hidden style={{ position: "absolute", opacity: 0, pointerEvents: "none" }}>Aa</span>

      <div className="card">
        <h2>This week&apos;s promo ideas</h2>
        {seasons.length > 0 && <p className="small muted">Coming up: {seasons.join(", ")}.</p>}
        {ideas.length === 0 && <p className="small muted">No ideas yet: there isn&apos;t enough Service log history. Build one below.</p>}
        <div className="promo-ideas">
          {ideas.map((s) => (
            <div key={s.id} className="promo-idea">
              <span className="tag">{KIND[s.kind]}</span>
              <strong>{s.title}</strong>
              <span className="small">{s.items.length === 1 ? `${s.items[0].name} ${s.items[0].paid}+${s.items[0].free}` : s.items.map((i) => `${i.paid} ${i.name}`).join(", ")}</span>
              <span className="small"><strong>{peso(s.price)}</strong> · {sessionsOf(s.items)} sessions · {peso(Math.round(s.price / sessionsOf(s.items)))} each</span>
              <span className="small muted">{s.why}</span>
              <button type="button" className="secondary small" onClick={() => openIdea(s)}>Open in builder</button>
            </div>
          ))}
        </div>
      </div>

      <div className="card" ref={builderRef}>
        <div className="row-between">
          <h2>{d.id ? "Edit draft" : "Build a promo"}</h2>
          {d.items.length > 0 && <button type="button" className="secondary small" onClick={() => open(blank(today))}>Start over</button>}
        </div>
        <div className="promo-grid">
          <div className="promo-form">
            <label>Add a service
              <select value="" onChange={(e) => addService(e.target.value)}>
                <option value="">Choose a service…</option>
                {services.filter((s) => !d.items.some((i) => i.service_id === s.id)).map((s) => (
                  <option key={s.id} value={s.id}>{s.name} ({peso(s.price)}){safetyFor(s.name).bundleOk ? "" : " · not for bundles"}</option>
                ))}
              </select>
            </label>

            {d.items.map((it, k) => (
              <div key={it.service_id} className="promo-item">
                <div className="row-between"><strong>{it.name}</strong><button type="button" className="link small" onClick={() => change({ items: d.items.filter((_, i) => i !== k) })}>Remove</button></div>
                <div className="promo-counts">
                  <span className="promo-count-box"><span className="small">Paid</span><Stepper label="Paid sessions" v={it.paid} min={1} max={50} onChange={(v) => setItem(k, { paid: v })} /></span>
                  <span className="promo-plus">+</span>
                  <span className="promo-count-box"><span className="small">FREE</span><Stepper label="Free sessions" v={it.free} min={0} max={50} onChange={(v) => setItem(k, { free: v })} /></span>
                  <span className="small muted promo-note"><strong>Usual: {safetyFor(it.name).usual}.</strong> {peso(it.unit)} each on the price list · {safetyFor(it.name).note}</span>
                  {usualCount(it.name, d.months) > it.paid + it.free && (
                    <button type="button" className="secondary small" onClick={() => setItem(k, { paid: Math.max(1, usualCount(it.name, d.months) - it.free) })}>
                      Match the usual pace: {usualCount(it.name, d.months)} in {d.months} month{d.months === 1 ? "" : "s"}
                    </button>
                  )}
                </div>
              </div>
            ))}

            {d.items.length > 0 && (
              <>
                <div className="promo-price">
                  <label>Promo price ₱
                    <span className="promo-stepper">
                      <button type="button" className="secondary" onClick={() => change({ auto: false, price: Math.max(100, price - 50000) })} aria-label="₱500 less">−</button>
                      <input inputMode="numeric" value={php(price)} onChange={(e) => { const v = Number(e.target.value.replace(/[^\d]/g, "")); change({ auto: false, price: v * 100 }); }} />
                      <button type="button" className="secondary" onClick={() => change({ auto: false, price: Math.min(value, price + 50000) })} aria-label="₱500 more">+</button>
                    </span>
                  </label>
                  {!d.auto && <button type="button" className="link-button small" onClick={() => change({ auto: true })}>Use the suggested price ({peso(defaultPrice(d.items, pkgs))})</button>}
                  <p className="small">
                    <strong>{n} sessions</strong> for <strong>{peso(price)}</strong> = {peso(Math.round(price / Math.max(1, n)))} per session.
                    {" "}The sessions are worth {peso(value)} on the price list, so the client saves {Math.round(off * 100)}% <span className="muted">(for you only; posts never show a regular price)</span>.
                  </p>
                  <p className="small">Commission: {isBundle(d.items)
                    ? `${peso(commissionPerSession(d.items, price))} per session, every session (5% of the bundle price spread over ${n})`
                    : `${peso(commissionPerSession(d.items, price))} once, when it's sold (5% of the program price)`}.</p>
                  {price > value && <div className="notice warn small">The price is more than the sessions are worth. Lower it.</div>}
                  {off > 0.3 && <div className="notice warn small">That&apos;s {Math.round(off * 100)}% off. Over 30% cuts deep into profit: try fewer free sessions, or a free add-on (like L-Carnitine) instead of a lower price.</div>}
                </div>

                <div className="promo-row">
                  <label>Use within (months)
                    <Stepper label="Months" v={d.months} min={1} max={24} onChange={(v) => change({ months: v })} />
                  </label>
                  <label>Promo ends on
                    <input type="date" value={d.endsOn} min={today} onChange={(e) => change({ endsOn: e.target.value })} />
                  </label>
                  <label>Season
                    <select value={d.season} onChange={(e) => change({ season: e.target.value })}>
                      <option value="">None</option>
                      {SEASONS.map((s) => <option key={s.key} value={s.name}>{s.name}</option>)}
                    </select>
                  </label>
                </div>
                {thin.length > 0 && (
                  <div className="notice warn small"><strong>Not enticing enough:</strong><ul>{thin.map((t) => <li key={t}>{t}</li>)}</ul></div>
                )}
                <div className={`notice ${ads.length ? "warn" : "ok"} small`}>
                  <strong>Ad rules check (Meta, PH FDA, Ad Standards):</strong>{" "}
                  {ads.length ? <ul>{ads.map((t) => <li key={t}>{t}</li>)}</ul> : "title, tagline and captions look OK."}
                  <div className="muted">When boosting: set the audience to ages 18+, and don&apos;t use before/after photos for body or skin-tone results.</div>
                </div>
                {issues.length > 0 && (
                  <div className="notice warn small"><strong>Check for the client&apos;s safety:</strong><ul>{issues.map((t) => <li key={t}>{t}</li>)}</ul></div>
                )}

                <label>Title
                  <input value={d.title} maxLength={80} onChange={(e) => change({ title: e.target.value })} placeholder="e.g. Snatched by Summer" />
                </label>
                <div className="chips">
                  {ideasForTitle.slice(0, 8).map((t) => <button key={t} type="button" className={`chip${t === d.title ? " on" : ""}`} onClick={() => change({ title: t })}>{t}</button>)}
                </div>
                <label>Tagline
                  <input value={d.tagline} maxLength={160} onChange={(e) => change({ tagline: e.target.value })} placeholder={season?.angle ?? "One line on why it's worth it"} />
                </label>

                <div>
                  <span className="small">Model photo (approved AI models, best fit first)</span>
                  <div className="promo-models">
                    {models.slice(0, 24).map((m) => (
                      <button key={m.m} type="button" className={`promo-model${m.m === model ? " on" : ""}`} onClick={() => change({ model: m.m })} title={`${m.m} ${m.tag}`}>
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={modelSrc(m.m)} alt={`${m.m} ${m.tag}`} loading="lazy" />
                        <span>{m.m}</span>
                      </button>
                    ))}
                  </div>
                </div>

                <div className="row-buttons">
                  <button type="button" className="secondary" disabled={pending} onClick={() => save(false)}>{pending ? "Saving…" : "Save draft"}</button>
                  <button type="button" disabled={pending || price > value || !d.title.trim()} onClick={() => save(true)}>Approve and add to the Service log</button>
                </div>
              </>
            )}
            {msg?.ok && <div className="notice ok small">{msg.ok}</div>}
            {msg?.error && <div className="notice error small">{msg.error}</div>}
          </div>

          <div className="promo-preview">
            {!d.items.length && <p className="small muted">Open an idea or add a service to see the story and FB post here.</p>}
            {story && feed && (
              <>
                <div className="promo-shots">
                  <figure>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={story} alt="Story preview" />
                    <figcaption className="row-buttons"><button type="button" className="secondary small" onClick={() => download("story")}>Save as photo</button><button type="button" className="secondary small" onClick={() => copyImage("story")}>Copy as photo</button></figcaption>
                  </figure>
                  <figure>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={feed} alt="FB post preview" />
                    <figcaption className="row-buttons"><button type="button" className="secondary small" onClick={() => download("feed")}>Save as photo</button><button type="button" className="secondary small" onClick={() => copyImage("feed")}>Copy as photo</button></figcaption>
                  </figure>
                </div>
                {caps && (
                  <>
                    <CaptionBox label="Story caption" text={caps.story} onCopy={copy} />
                    <CaptionBox label="FB post caption" text={caps.feed} onCopy={copy} />
                  </>
                )}
              </>
            )}
          </div>
        </div>
      </div>

      <div className="card">
        <h2>Promos</h2>
        {saved.length === 0 && <p className="small muted">None yet.</p>}
        {[["Running", live], ["Drafts", drafts], ["Ended", ended]].map(([label, list]) => (list as SavedPromo[]).length > 0 && (
          <div key={label as string}>
            <h3>{label as string}</h3>
            <div className="promo-list">
              {(list as SavedPromo[]).map((p) => (
                <div key={p.id} className="promo-saved">
                  <div><strong>{p.title}</strong></div>
                  <div className="small muted">{p.items.map((i) => `${i.paid}${i.free ? `+${i.free}` : ""} ${i.name}`).join(", ")}</div>
                  <div className="small"><strong>{peso(p.price_cents)}</strong> · {p.sessions} sessions{p.ends_on ? ` · ends ${p.ends_on}` : ""}</div>
                  {p.state === "APPROVED" && <PromoPhotos p={p} serif={serif} fileName={fileName} />}
                  <span className="row-buttons">
                    <button type="button" className="secondary small" onClick={() => openSaved(p)}>{p.state === "DRAFT" ? "Open" : "Copy into builder"}</button>
                    {p.state !== "ENDED" && <button type="button" className="secondary small" disabled={pending} onClick={() => end(p)}>{p.state === "DRAFT" ? "Delete" : "End"}</button>}
                  </span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

const COPY_FAIL = "This browser can't copy photos. Use Save as photo instead.";
const fontsOf = async (serif: string) => {
  await document.fonts.load(`700 80px ${serif}`).catch(() => null);
  await document.fonts.ready;
  return { sans: getComputedStyle(document.body).fontFamily || "sans-serif", serif };
};
const pngOf = (c: HTMLCanvasElement) => new Promise<Blob>((ok, bad) => c.toBlob((b) => (b ? ok(b) : bad(new Error("no image"))), "image/png"));
async function saveCanvas(c: Promise<HTMLCanvasElement>, name: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(await pngOf(await c));
  a.download = name; document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
/** Safari needs the clipboard write to start right away, so it gets a promise of the image. */
async function copyCanvas(c: Promise<HTMLCanvasElement>): Promise<boolean> {
  try {
    if (!navigator.clipboard || typeof ClipboardItem === "undefined") return false;
    await navigator.clipboard.write([new ClipboardItem({ "image/png": c.then(pngOf) })]);
    return true;
  } catch { return false; }
}

/** Save as photo / Copy as photo (story and FB post) and Copy caption for an approved, running promo (CHRIS Nov 27). */
function PromoPhotos({ p, serif, fileName }: { p: SavedPromo; serif: string; fileName: (t: string, k: "story" | "feed") => string }) {
  const [note, setNote] = useState<string | null>(null);
  const items: PromoItem[] = p.items.map((i) => ({ service_id: i.service_id, name: i.name, unit: i.unit_cents, paid: i.paid, free: i.free }));
  const model = p.model || modelsFor(items.map((i) => i.name))[0]?.m || "M01";
  const art = { title: p.title, tagline: p.tagline ?? "", items, price: p.price_cents, months: p.valid_months, endsOn: p.ends_on, photo: modelSrc(model) };
  const draw = (kind: "story" | "feed") => fontsOf(serif).then((f) => drawPromo(kind, art, f));
  const caps = captions({ title: p.title, tagline: p.tagline ?? "", items, price: p.price_cents, months: p.valid_months, endsOn: p.ends_on });
  const label = (k: "story" | "feed") => (k === "story" ? "Story" : "FB post");
  async function copyText(t: string, what: string) {
    try { await navigator.clipboard.writeText(t); setNote(`${what} copied.`); } catch { setNote("Could not copy. Try again."); }
  }
  return (
    <div className="promo-photos">
      {(["story", "feed"] as const).map((k) => (
        <span key={k} className="row-buttons">
          <span className="small"><strong>{label(k)}:</strong></span>
          <button type="button" className="secondary small" onClick={() => saveCanvas(draw(k), fileName(p.title, k)).catch(() => setNote("Could not make the photo. Try again."))}>Save as photo</button>
          <button type="button" className="secondary small" onClick={async () => setNote((await copyCanvas(draw(k))) ? `${label(k)} copied. Paste it in a chat or post.` : COPY_FAIL)}>Copy as photo</button>
          <button type="button" className="secondary small" onClick={() => copyText(k === "story" ? caps.story : caps.feed, `${label(k)} caption`)}>Copy caption</button>
        </span>
      ))}
      {note && <span className="small">{note}</span>}
    </div>
  );
}

function Stepper({ label, v, min, max, onChange }: { label: string; v: number; min: number; max: number; onChange: (v: number) => void }) {
  return (
    <span className="promo-stepper" role="group" aria-label={label}>
      <button type="button" className="secondary" onClick={() => onChange(Math.max(min, v - 1))} disabled={v <= min} aria-label={`${label}: one less`}>−</button>
      <span className="promo-count" aria-live="polite">{v}</span>
      <button type="button" className="secondary" onClick={() => onChange(Math.min(max, v + 1))} disabled={v >= max} aria-label={`${label}: one more`}>+</button>
    </span>
  );
}

function CaptionBox({ label, text, onCopy }: { label: string; text: string; onCopy: (t: string) => void }) {
  return (
    <div className="promo-caption">
      <div className="row-between"><span className="small"><strong>{label}</strong></span><button type="button" className="secondary small" onClick={() => onCopy(text)}>Copy</button></div>
      <textarea readOnly value={text} rows={Math.min(14, text.split("\n").length + 1)} />
    </div>
  );
}
