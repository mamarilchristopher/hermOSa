// Gold dashboard charts (v0.87.2, CHRIS Nov 27: "A Gold glow + calendar"). Server-rendered SVG, one hue (gold),
// recessive grid, hover shows the exact figure, and a short draw-in animation (off for reduced motion).
import { centsToPhp } from "@/lib/csv";
import { WEEKDAYS } from "@/lib/insights";

export const compact = (cents: number) => {
  const p = cents / 100;
  if (Math.abs(p) >= 1_000_000) return `₱${(p / 1_000_000).toFixed(Math.abs(p) >= 10_000_000 ? 0 : 1)}M`;
  if (Math.abs(p) >= 1_000) return `₱${Math.round(p / 1_000)}K`;
  return `₱${Math.round(p)}`;
};

/** ▲ 3% / ▼ 7% pill. */
export function Chg({ c, suffix }: { c: number | null; suffix?: string }) {
  if (c === null || !Number.isFinite(c)) return null;
  return <span className={`chg ${c >= 0 ? "up" : "down"}`}>{c >= 0 ? "▲" : "▼"} {Math.abs(Math.round(c * 100))}%{suffix ? ` ${suffix}` : ""}</span>;
}

/** Small gold area sparkline with a dot on the latest value. */
export function GoldSpark({ values, id, label, w = 240, h = 46 }: { values: (number | null)[]; id: string; label: string; w?: number; h?: number }) {
  const v = values.map((x) => x ?? 0);
  if (v.length < 2) return null;
  const mx = Math.max(...v), mn = Math.min(...v) * 0.9;
  const span = mx - mn || 1;
  const pts = v.map((x, i) => [(i * w) / (v.length - 1), h - 4 - ((h - 8) * (x - mn)) / span]);
  const d = pts.map((p, i) => `${i ? "L" : "M"}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(" ");
  const last = pts[pts.length - 1];
  return (
    <svg className="gspark" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" role="img" aria-label={label}>
      <defs><linearGradient id={id} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="var(--viz-gold)" stopOpacity=".35" /><stop offset="1" stopColor="var(--viz-gold)" stopOpacity="0" /></linearGradient></defs>
      <path d={`${d} L${w} ${h} L0 ${h}Z`} fill={`url(#${id})`} />
      <path className="draw" d={d} fill="none" stroke="var(--viz-gold)" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
      <circle cx={last[0]} cy={last[1]} r="3.5" fill="var(--viz-gold)" />
    </svg>
  );
}

/** Progress ring: big percentage in the middle, a short word under it. */
export function Ring({ frac, label, sub, size = 118, color = "var(--viz-gold)" }: { frac: number; label: string; sub: string; size?: number; color?: string }) {
  const R = size / 2 - 9, C = 2 * Math.PI * R;
  return (
    <svg className="ring" width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={`${label} ${sub}`}>
      <circle cx={size / 2} cy={size / 2} r={R} fill="none" stroke="var(--viz-track)" strokeWidth="12" />
      <circle className="ring-arc" cx={size / 2} cy={size / 2} r={R} fill="none" stroke={color} strokeWidth="12" strokeLinecap="round"
        strokeDasharray={`${C * Math.max(0, Math.min(frac, 1))} ${C}`} transform={`rotate(-90 ${size / 2} ${size / 2})`} />
      <text x="50%" y="48%" textAnchor="middle" className="ring-big" style={{ fontSize: size / 5.2 }}>{label}</text>
      <text x="50%" y="64%" textAnchor="middle" className="ring-sub">{sub}</text>
    </svg>
  );
}

/** Weekly sales: gold line with a soft gradient; the unfinished week is a dashed step with a pulsing dot.
 *  Drawn twice (wide and phone) so the axis text stays readable on both. */
export function GoldArea({ points, id, title }: { points: { label: string; tip: string; cents: number; partial?: boolean }[]; id: string; title: string }) {
  const n = points.length;
  if (n < 2) return null;
  const draw = (W: number, height: number, narrow: boolean) => {
    const pl = 46, pr = 12, pb = 24, pt = 14, gid = `${id}${narrow ? "n" : "w"}`;
    const mx = Math.max(1, ...points.map((p) => p.cents)) * 1.08;
    const x = (i: number) => pl + (i * (W - pl - pr)) / (n - 1);
    const y = (v: number) => pt + (height - pt - pb) * (1 - v / mx);
    const partial = !!points[n - 1].partial;
    const solidN = partial ? n - 1 : n;
    const d = points.slice(0, solidN).map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)} ${y(p.cents).toFixed(1)}`).join(" ");
    const top = mx / 1.08;
    const labeled = points.map((p, i) => (p.label ? i : -1)).filter((i) => i >= 0);
    const showLabel = (i: number) => !!points[i].label && (!narrow || i === labeled[0] || i === labeled[labeled.length - 1]);
    return (
      <svg className={narrow ? "viz-narrow" : "viz-wide"} viewBox={`0 0 ${W} ${height}`} role="img" aria-label={title}>
        <defs><linearGradient id={gid} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="var(--viz-gold)" stopOpacity=".38" /><stop offset="1" stopColor="var(--viz-gold)" stopOpacity="0" /></linearGradient></defs>
        {[0, 0.5, 1].map((t) => (
          <g key={t}><line x1={pl} x2={W - pr} y1={y(top * t)} y2={y(top * t)} stroke="var(--line)" /><text x={pl - 8} y={y(top * t) + 4} textAnchor="end" className="axis">{compact(top * t)}</text></g>
        ))}
        <path className="fade" d={`${d} L${x(solidN - 1)} ${y(0)} L${x(0)} ${y(0)}Z`} fill={`url(#${gid})`} />
        <path className="draw" d={d} fill="none" stroke="var(--viz-gold)" strokeWidth="2.6" strokeLinejoin="round" strokeLinecap="round" />
        {partial && <path d={`M${x(n - 2)} ${y(points[n - 2].cents)} L${x(n - 1)} ${y(points[n - 1].cents)}`} stroke="var(--viz-gold)" strokeWidth="2" strokeDasharray="4 5" fill="none" />}
        {points.map((p, i) => (
          <g key={p.tip} className="pt">
            <title>{`${p.tip}${p.partial ? " (so far)" : ""}: ${centsToPhp(p.cents)}`}</title>
            <rect x={x(i) - (W - pl) / n / 2} y={pt} width={(W - pl) / n} height={height - pt - pb} fill="transparent" />
            <circle cx={x(i)} cy={y(p.cents)} r="4" fill="var(--surface)" stroke="var(--viz-gold)" strokeWidth="2" className="pt-dot" />
            {showLabel(i) && <text x={x(i)} y={height - 6} textAnchor={i === n - 1 ? "end" : i === 0 ? "start" : "middle"} className="axis">{p.label}</text>}
          </g>
        ))}
        {partial && <text x={x(n - 1) - 8} y={y(points[n - 1].cents) - 12} textAnchor="end" className="bar-val">so far</text>}
        <circle className="pulse" cx={x(n - 1)} cy={y(points[n - 1].cents)} r="10" fill="var(--viz-gold)" opacity=".22" />
        <circle cx={x(n - 1)} cy={y(points[n - 1].cents)} r="5" fill="var(--viz-gold)" stroke="var(--surface)" strokeWidth="2" />
      </svg>
    );
  };
  return <figure className="chart" aria-label={title}>{draw(720, 290, false)}{draw(360, 200, true)}</figure>;
}

/** Champagne bars; the best bar is gold with its value, the current period is hatched, and an optional dashed line
 *  shows the same period a year earlier. */
export function GoldBars(props: {
  bars: { key: string; label: string | null; tip: string; cents: number; partial?: boolean }[]; id: string; title: string; ghost?: (number | null)[];
}) {
  return <figure className="chart" aria-label={props.title}><GoldBarsAt {...props} W={720} height={230} narrow={false} /><GoldBarsAt {...props} W={360} height={190} narrow /></figure>;
}
function GoldBarsAt({ bars, id: baseId, title, ghost, W, height, narrow }: {
  bars: { key: string; label: string | null; tip: string; cents: number; partial?: boolean }[]; id: string; title: string; ghost?: (number | null)[]; W: number; height: number; narrow: boolean;
}) {
  const id = `${baseId}${narrow ? "n" : "w"}`;
  const pl = 46, pb = 24, pt = 18, n = bars.length;
  const mx = Math.max(1, ...bars.map((b) => b.cents), ...(ghost ?? []).map((g) => g ?? 0)) * 1.08;
  const st = (W - pl) / n, bw = Math.max(6, st * 0.58);
  const y = (v: number) => pt + (height - pt - pb) * (1 - v / mx);
  const best = bars.reduce((b, x, i) => (!x.partial && x.cents > (bars[b]?.cents ?? -1) ? i : b), -1);
  const top = mx / 1.08;
  const gd = ghost?.map((g, i) => (g === null || g === 0 ? "" : `${pl + i * st + st / 2} ${y(g)}`));
  return (
      <svg className={narrow ? "viz-narrow" : "viz-wide"} viewBox={`0 0 ${W} ${height}`} role="img" aria-label={title}>
        <defs>
          <linearGradient id={`${id}-g`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="var(--viz-gold-hi)" /><stop offset="1" stopColor="var(--viz-gold)" /></linearGradient>
          <pattern id={`${id}-h`} width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="6" height="6" fill="var(--viz-champ)" /><line x1="0" y1="0" x2="0" y2="6" stroke="var(--viz-gold)" strokeWidth="2" /></pattern>
        </defs>
        {[0, 0.5, 1].map((t) => (
          <g key={t}><line x1={pl} x2={W} y1={y(top * t)} y2={y(top * t)} stroke="var(--line)" /><text x={pl - 8} y={y(top * t) + 4} textAnchor="end" className="axis">{compact(top * t)}</text></g>
        ))}
        {bars.map((b, i) => {
          const x = pl + i * st + (st - bw) / 2, yt = y(b.cents), h = Math.max(0, height - pb - yt);
          const g = ghost?.[i];
          return (
            <g key={b.key} className="bar">
              <title>{`${b.tip}${b.partial ? " (so far)" : ""}: ${centsToPhp(b.cents)}${g ? ` · a year earlier ${centsToPhp(g)}` : ""}`}</title>
              <rect x={pl + i * st} y={pt} width={st} height={height - pt - pb} fill="transparent" />
              {h > 0 && <rect className="grow" style={{ animationDelay: `${i * 30}ms` }} x={x} y={yt} width={bw} height={h} rx={Math.min(9, bw / 2)}
                fill={b.partial ? `url(#${id}-h)` : i === best ? `url(#${id}-g)` : "var(--viz-champ)"} />}
              {(i === best || b.partial) && h > 0 && <text x={x + bw / 2} y={yt - 6} textAnchor="middle" className="bar-val">{compact(b.cents)}</text>}
              {b.label && (!narrow || (n - 1 - i) % 3 === 0) && <text x={x + bw / 2} y={height - 6} textAnchor="middle" className="axis">{b.label}</text>}
            </g>
          );
        })}
        {gd && gd.filter(Boolean).length > 1 && (
          <path d={gd.reduce((s, p) => (!p ? s : `${s}${s ? " L" : "M"}${p}`), "")} fill="none" stroke="var(--muted)" strokeWidth="1.6" strokeDasharray="4 4" />
        )}
      </svg>
  );
}

/** Average day by weekday as short gold columns: the best day gold, the slowest tinted red. */
export function DayColumns({ days }: { days: { day: number; avg: number | null }[] }) {
  const vals = days.map((d) => d.avg ?? 0);
  const mx = Math.max(1, ...vals);
  const withData = days.filter((d) => d.avg !== null);
  const best = withData.length ? withData.reduce((a, b) => (b.avg! > a.avg! ? b : a)).day : -1;
  const slow = withData.length > 1 ? withData.reduce((a, b) => (b.avg! < a.avg! ? b : a)).day : -1;
  return (
    <div className="daycols" role="img" aria-label="Average sales by weekday">
      {days.map((d) => (
        <div key={d.day} title={`${WEEKDAYS[d.day]}: ${d.avg === null ? "no data" : centsToPhp(d.avg)}`}>
          <span className="dc-val">{d.day === best || d.day === slow ? compact(d.avg ?? 0) : ""}</span>
          <i className={`grow ${d.day === best ? "best" : d.day === slow ? "slow" : ""}`} style={{ height: `${Math.max(4, ((d.avg ?? 0) / mx) * 72)}px` }} />
          <span className="dc-day">{WEEKDAYS[d.day].slice(0, 1)}</span>
        </div>
      ))}
    </div>
  );
}

/** 12 weeks × 7 days; brighter gold = bigger day. Future days are blank, days without figures are outlined. */
export function HeatCalendar({ weeks, max }: { weeks: { start: string; days: { d: string; cents: number | null; future: boolean }[] }[]; max: number }) {
  const order = [1, 2, 3, 4, 5, 6, 0];
  return (
    <div className="heatcal">
      <div className="hc-grid" style={{ gridTemplateColumns: `30px repeat(${weeks.length}, 1fr)` }}>
        {order.map((wd, r) => (
          <div key={wd} style={{ display: "contents" }}>
            <span className="hc-day">{WEEKDAYS[wd]}</span>
            {weeks.map((w) => {
              const c = w.days[r];
              if (c.future) return <span key={c.d} className="hc-cell future" />;
              if (c.cents === null) return <span key={c.d} className="hc-cell none" title={`${c.d}: no figure`} />;
              const pct = Math.round(10 + 90 * Math.pow(Math.max(0, c.cents) / Math.max(1, max), 1.6));
              return <span key={c.d} className="hc-cell" title={`${c.d}: ${centsToPhp(c.cents)}`} style={{ background: `color-mix(in srgb, var(--viz-gold) ${pct}%, var(--viz-track))` }} />;
            })}
          </div>
        ))}
      </div>
      <div className="hc-legend"><span>less</span>{[10, 35, 60, 85, 100].map((p) => <i key={p} style={{ background: `color-mix(in srgb, var(--viz-gold) ${p}%, var(--viz-track))` }} />)}<span>more</span></div>
    </div>
  );
}

const RAMP = ["var(--viz-deep)", "var(--viz-gold)", "var(--viz-gold-hi)", "var(--viz-champ)", "#c9b8a6", "#ddd0c2", "#ebe2d8"];
/** Donut by share (ordered largest first, darkest gold first) with a big centre figure, plus the top items beside it. */
export function Donut({ items, center, sub, size = 150 }: { items: { name: string; cents: number; change?: number | null }[]; center: string; sub: string; size?: number }) {
  const list = items.slice(0, 6);
  const rest = items.slice(6).reduce((s, x) => s + x.cents, 0);
  if (rest > 0) list.push({ name: "Other", cents: rest });
  const tot = list.reduce((s, x) => s + x.cents, 0) || 1;
  const R = size / 2 - 4, r0 = R - 24, c = size / 2;
  let a0 = -Math.PI / 2;
  const p = (a: number, rr: number) => `${(c + rr * Math.cos(a)).toFixed(2)} ${(c + rr * Math.sin(a)).toFixed(2)}`;
  return (
    <div className="donut">
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={`${center} ${sub}`}>
        {list.map((it, i) => {
          const a1 = a0 + (it.cents / tot) * 2 * Math.PI - 0.0001;
          const lg = a1 - a0 > Math.PI ? 1 : 0;
          const path = `M${p(a0, R)}A${R} ${R} 0 ${lg} 1 ${p(a1, R)}L${p(a1, r0)}A${r0} ${r0} 0 ${lg} 0 ${p(a0, r0)}Z`;
          a0 = a1 + 0.0001;
          return <path key={it.name} d={path} fill={RAMP[i] ?? RAMP[6]} stroke="var(--surface)" strokeWidth="2"><title>{`${it.name}: ${centsToPhp(it.cents)} (${Math.round((it.cents / tot) * 100)}%)`}</title></path>;
        })}
        <text x="50%" y="49%" textAnchor="middle" className="ring-big" style={{ fontSize: 26 }}>{center}</text>
        <text x="50%" y="63%" textAnchor="middle" className="ring-sub">{sub}</text>
      </svg>
      <ul>
        {list.slice(0, 5).map((it, i) => (
          <li key={it.name}><i style={{ background: RAMP[i] }} /><span className="dn-name">{it.name}</span><b>{compact(it.cents)}</b>{it.change !== undefined && <Chg c={it.change ?? null} />}</li>
        ))}
      </ul>
    </div>
  );
}

/** Horizontal gold bar rows: name, bar, value, optional change or warning pill. */
export function BarRows({ rows }: { rows: { key: string; name: string; href?: string; cents: number; avatar?: string; pill?: React.ReactNode }[] }) {
  const mx = Math.max(1, ...rows.map((r) => r.cents));
  return (
    <div className="barrows">
      {rows.map((r) => (
        <div className="br-row" key={r.key} title={`${r.name}: ${centsToPhp(r.cents)}`}>
          {r.avatar && <span className="br-av">{r.avatar}</span>}
          <span className="br-name">{r.href ? <a href={r.href}>{r.name}</a> : r.name}</span>
          <span className="br-track"><i className="growx" style={{ width: `${(r.cents / mx) * 100}%` }} /></span>
          <b className="br-val">{compact(r.cents)}</b>
          <span className="br-pill">{r.pill}</span>
        </div>
      ))}
    </div>
  );
}
