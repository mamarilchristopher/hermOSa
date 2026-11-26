// Small server-rendered charts for the sales dashboard. One series each, brand brown, hover shows the value.
import { centsToPhp } from "@/lib/csv";
import { monthLabel, WEEKDAYS } from "@/lib/insights";
import { GoldBars } from "./BizCharts";

const compact = (cents: number) => {
  const p = cents / 100;
  if (p >= 1_000_000) return `₱${(p / 1_000_000).toFixed(p >= 10_000_000 ? 0 : 1)}M`;
  if (p >= 1_000) return `₱${Math.round(p / 1_000)}K`;
  return `₱${Math.round(p)}`;
};

/** Monthly totals (v0.87.2: the gold look from the Business dashboard). The best month is gold with its value, the
 *  current month hatched. */
export function MonthBars({ months, title }: { months: { ym: string; cents: number; partial: boolean }[]; title: string }) {
  return (
    <GoldBars id="mb" title={title}
      bars={months.map((m, i) => ({ key: m.ym, tip: monthLabel(m.ym), cents: m.cents, partial: m.partial,
        label: i % 2 === months.length % 2 || months.length <= 7 ? `${monthLabel(m.ym).slice(0, 3)}${m.ym.endsWith("-01") ? ` ${m.ym.slice(2, 4)}` : ""}` : null }))} />
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
            {h > 0 && <rect x={i * step + 1} y={H - h} width={step - 2} height={h} rx={1.5} fill={m.partial ? "var(--viz-champ)" : "var(--viz-gold)"} />}
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
