// Business › Ads charts (update-0096). Server-rendered SVG in the gold dashboard style: spend* bars against the sales line,
// and ROAS bars against the 3.5x floor. Drawn twice (wide and phone) so text stays readable on both.
import { compact } from "@/components/BizCharts";

type Month = { key: string; label: string; spend: number; sales: number; partial?: boolean };

/** Monthly ad spend (VAT incl., gold bars, left scale) and declared sales (ink line, right scale). */
export function SpendSalesChart({ months, title }: { months: Month[]; title: string }) {
  return (
    <figure className="chart" aria-label={title}>
      <SpendSalesAt months={months} W={720} H={240} narrow={false} />
      <SpendSalesAt months={months.slice(-7)} W={360} H={210} narrow />
    </figure>
  );
}
function SpendSalesAt({ months, W, H, narrow }: { months: Month[]; W: number; H: number; narrow: boolean }) {
  const pl = narrow ? 60 : 74, pr = narrow ? 48 : 56, pt = 20, pb = 26, n = Math.max(1, months.length);
  const ms = Math.max(1, ...months.map((m) => m.spend)) * 1.15, mv = Math.max(1, ...months.map((m) => m.sales)) * 1.1;
  const st = (W - pl - pr) / n, bw = Math.max(5, st * 0.5);
  const ys = (v: number) => pt + (H - pt - pb) * (1 - v / ms);
  const yv = (v: number) => pt + (H - pt - pb) * (1 - v / mv);
  const cx = (i: number) => pl + i * st + st / 2;
  const line = months.map((m, i) => `${i ? "L" : "M"}${cx(i).toFixed(1)} ${yv(m.sales).toFixed(1)}`).join(" ");
  return (
    <svg className={narrow ? "viz-narrow" : "viz-wide"} viewBox={`0 0 ${W} ${H}`} role="img">
      {[0, 0.5, 1].map((t) => (
        <g key={t}>
          <line x1={pl} x2={W - pr} y1={ys((ms / 1.15) * t)} y2={ys((ms / 1.15) * t)} stroke="var(--line)" />
          <text x={pl - 8} y={ys((ms / 1.15) * t) + 4} textAnchor="end" className="axis">{`${compact((ms / 1.15) * t)}*`}</text>
          <text x={W - pr + 8} y={yv((mv / 1.1) * t) + 4} className="axis">{compact((mv / 1.1) * t)}</text>
        </g>
      ))}
      {months.map((m, i) => {
        const yt = ys(m.spend), h = Math.max(0, H - pb - yt);
        return (
          <g key={m.key} className="bar">
            <title>{`${m.label}${m.partial ? " (so far)" : ""}: ad spend ${compact(m.spend)}* · sales ${compact(m.sales)} · ROAS ${m.spend ? (m.sales / m.spend).toFixed(1) : "–"}x`}</title>
            <rect x={pl + i * st} y={pt} width={st} height={H - pt - pb} fill="transparent" />
            {h > 0 && <rect className="grow" style={{ animationDelay: `${i * 30}ms` }} x={cx(i) - bw / 2} y={yt} width={bw} height={h} rx={Math.min(7, bw / 2)} fill={m.partial ? "var(--viz-champ)" : "var(--viz-gold)"} opacity={m.partial ? 0.7 : 0.85} />}
            <text x={cx(i)} y={H - 7} textAnchor="middle" className="axis">{m.label}</text>
          </g>
        );
      })}
      <path className="draw" d={line} fill="none" stroke="var(--ink)" strokeWidth="2" strokeLinejoin="round" />
      {months.map((m, i) => <circle key={m.key} cx={cx(i)} cy={yv(m.sales)} r={m.partial ? 3 : 3.5} fill={m.partial ? "var(--surface)" : "var(--ink)"} stroke="var(--ink)" strokeWidth="1.5" />)}
    </svg>
  );
}

type RoasBar = { key: string; group: string; label: string; value: number | null; tip: string };

/** ROAS bars grouped by branch, with the floor drawn as a dashed line; bars under it are tinted red. */
export function RoasBars({ bars, floor, title }: { bars: RoasBar[]; floor: number; title: string }) {
  const groups = [...new Set(bars.map((b) => b.group))];
  const W = 440, H = 240, pl = 4, pt = 22, pb = 44;
  const mx = Math.max(floor * 1.6, ...bars.map((b) => b.value ?? 0)) * 1.12;
  const gw = (W - pl - 34) / Math.max(1, groups.length);
  const y = (v: number) => pt + (H - pt - pb) * (1 - v / mx);
  return (
    <figure className="chart roasbars" aria-label={title}>
      <svg viewBox={`0 0 ${W} ${H}`} role="img">
        <line x1={pl} x2={W} y1={y(floor)} y2={y(floor)} stroke="var(--muted)" strokeDasharray="5 5" />
        <text x={W - 2} y={y(floor) - 6} textAnchor="end" className="axis">{`${floor}x`}</text>
        {groups.map((g, gi) => {
          const inG = bars.filter((b) => b.group === g);
          const bw = Math.min(48, (gw - 16) / inG.length - 6);
          const x0 = pl + gi * gw + (gw - inG.length * (bw + 6) + 6) / 2;
          return (
            <g key={g}>
              {inG.map((b, i) => {
                const v = b.value ?? 0, yt = y(v), x = x0 + i * (bw + 6);
                const low = b.value !== null && b.value < floor;
                return (
                  <g key={b.key} className="bar">
                    <title>{b.tip}</title>
                    {v > 0 && <rect className="grow" x={x} y={yt} width={bw} height={H - pb - yt} rx="6" fill={low ? "var(--bad)" : "var(--viz-gold)"} opacity={low ? 0.55 : 0.85} />}
                    <text x={x + bw / 2} y={v > 0 ? yt - 6 : H - pb - 6} textAnchor="middle" className="bar-val">{b.value === null ? "–" : `${b.value.toFixed(1)}x`}</text>
                    <text x={x + bw / 2} y={H - pb + 15} textAnchor="middle" className="axis">{b.label}</text>
                  </g>
                );
              })}
              <text x={pl + gi * gw + gw / 2} y={H - 8} textAnchor="middle" className="rb-group">{g}</text>
            </g>
          );
        })}
      </svg>
    </figure>
  );
}
