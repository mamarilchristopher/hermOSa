// Small server-rendered charts for the sales dashboard. One series each, brand brown, hover shows the value.
import { centsToPhp } from "@/lib/csv";
import { monthLabel, WEEKDAYS } from "@/lib/insights";

const compact = (cents: number) => {
  const p = cents / 100;
  if (p >= 1_000_000) return `₱${(p / 1_000_000).toFixed(p >= 10_000_000 ? 0 : 1)}M`;
  if (p >= 1_000) return `₱${Math.round(p / 1_000)}K`;
  return `₱${Math.round(p)}`;
};

/** Monthly totals as bars. The current (partial) month is drawn hatched and labelled "so far". */
export function MonthBars({ months, height = 180, title }: { months: { ym: string; cents: number; partial: boolean }[]; height?: number; title: string }) {
  const W = 640, padL = 44, padB = 22, padT = 10;
  const max = Math.max(1, ...months.map((m) => m.cents));
  const step = (W - padL) / months.length;
  const bw = Math.max(4, step - 6);
  const y = (c: number) => padT + (height - padT - padB) * (1 - c / max);
  const ticks = [0, 0.5, 1].map((t) => Math.round(max * t));
  return (
    <figure className="chart" aria-label={title}>
      <svg viewBox={`0 0 ${W} ${height}`} role="img" aria-label={title}>
        <defs>
          <pattern id="partial" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <rect width="6" height="6" fill="var(--chart-fill-soft)" />
            <line x1="0" y1="0" x2="0" y2="6" stroke="var(--chart-fill)" strokeWidth="2" />
          </pattern>
        </defs>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={padL} x2={W} y1={y(t)} y2={y(t)} stroke="var(--line)" strokeWidth="1" />
            <text x={padL - 6} y={y(t) + 4} textAnchor="end" className="axis">{compact(t)}</text>
          </g>
        ))}
        {months.map((m, i) => {
          const x = padL + i * step + (step - bw) / 2;
          const top = y(m.cents);
          const h = Math.max(0, height - padB - top);
          return (
            <g key={m.ym} className="bar">
              <title>{`${monthLabel(m.ym)}${m.partial ? " (so far)" : ""}: ${centsToPhp(m.cents)}`}</title>
              <rect x={padL + i * step} y={padT} width={step} height={height - padT - padB} fill="transparent" />
              {h > 0 && <rect x={x} y={top} width={bw} height={h} rx={Math.min(4, bw / 2)} fill={m.partial ? "url(#partial)" : "var(--chart-fill)"} />}
              {(i % 2 === months.length % 2 || months.length <= 7) && (
                <text x={x + bw / 2} y={height - 6} textAnchor="middle" className="axis">{monthLabel(m.ym).slice(0, 3)}{m.ym.endsWith("-01") ? ` ${m.ym.slice(2, 4)}` : ""}</text>
              )}
            </g>
          );
        })}
      </svg>
    </figure>
  );
}

/** Tiny 13-month bar strip for a branch card. */
export function Spark({ months, label }: { months: { ym: string; cents: number; partial: boolean }[]; label: string }) {
  const W = 130, H = 32;
  const max = Math.max(1, ...months.map((m) => m.cents));
  const step = W / months.length;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} role="img" aria-label={`${label}: monthly sales, last 13 months`}>
      {months.map((m, i) => {
        const h = Math.round((H - 2) * (m.cents / max));
        return (
          <g key={m.ym}>
            <title>{`${monthLabel(m.ym)}${m.partial ? " (so far)" : ""}: ${centsToPhp(m.cents)}`}</title>
            <rect x={i * step} y={0} width={step} height={H} fill="transparent" />
            {h > 0 && <rect x={i * step + 1} y={H - h} width={step - 2} height={h} rx={1.5} fill={m.partial ? "var(--chart-fill-soft)" : "var(--chart-fill)"} />}
          </g>
        );
      })}
    </svg>
  );
}

/** Average sales per weekday as horizontal bars with the value written beside each. */
export function WeekdayBars({ days }: { days: { day: number; avg: number | null }[] }) {
  const max = Math.max(1, ...days.map((d) => d.avg ?? 0));
  return (
    <div className="hbars">
      {days.map((d) => (
        <div className="hbar" key={d.day} title={d.avg === null ? "No data" : centsToPhp(d.avg)}>
          <span className="hbar-label">{WEEKDAYS[d.day]}</span>
          <span className="hbar-track"><span className="hbar-fill" style={{ width: `${((d.avg ?? 0) / max) * 100}%` }} /></span>
          <span className="hbar-value">{d.avg === null ? "–" : compact(d.avg)}</span>
        </div>
      ))}
    </div>
  );
}
