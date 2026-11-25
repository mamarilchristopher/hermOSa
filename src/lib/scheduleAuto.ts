// "Suggest a week" and schedule checks (owner request 2026-11-25). Pure functions, no database.
// A week is Monday..Sunday; day index 0 = Monday. Branch ids are in the owner's branch order.

export type Rules = {
  /** Fewest people per branch for each day, Monday..Sunday. */
  min: Record<string, number[]>;
  /** Days off per person per week. */
  days_off: number;
};
export type AutoPerson = { id: string; home: string | null; daysOff?: number[] /** usual days off, 0 = Sunday */; start?: string; end?: string };
/** A day already decided: a branch, OFF, or leave (VL / SL / ABSENT). Kept as is. */
export type Fixed = { employee: string; day: number; status: string };
export type Row = { employee: string; status: string; start?: string; end?: string };
const LEAVE = ["OFF", "VL", "SL", "ABSENT"];

export function defaultRules(branches: string[]): Rules {
  return { days_off: 1, min: Object.fromEntries(branches.map((b, i) => [b, i === 0 ? [1, 2, 2, 2, 2, 2, 2] : [1, 1, 1, 1, 1, 1, 1]])) };
}
export function normalizeRules(raw: unknown, branches: string[]): Rules {
  const d = defaultRules(branches);
  const r = (raw ?? {}) as Partial<Rules>;
  const days = Number.isInteger(r.days_off) && r.days_off! >= 0 && r.days_off! <= 3 ? r.days_off! : d.days_off;
  const min = Object.fromEntries(branches.map((b) => {
    const v = r.min?.[b];
    return [b, Array.isArray(v) && v.length === 7 && v.every((n) => Number.isInteger(n) && n >= 0 && n <= 9) ? v : d.min[b]];
  }));
  return { days_off: days, min };
}

/** A small seeded random so the same week always gets the same suggestion, and "Suggest again" changes it. */
function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return ((s >>> 0) % 100000) / 100000; };
}

/**
 * Suggest who works where for 7 days. Fixed days (published or leave) are kept.
 * 1. Days off: each person gets `days_off` days, on their usual day off when it still leaves enough staff,
 *    otherwise on the day with the most spare people (weekdays before weekends), spread across the week.
 * 2. Each day, fill every branch's minimum, scarcest branch first, preferring people whose home branch it is,
 *    then people who have worked there most this week. 3. Everyone left goes to their home branch, or where most needed.
 */
export function suggestWeek(input: { people: AutoPerson[]; branches: string[]; rules: Rules; fixed: Fixed[]; seed?: number; lastWeek?: Fixed[] }): { days: Row[][]; short: { day: number; branch: string; need: number; have: number }[] } {
  const { people, branches, rules } = input;
  const rand = rng(input.seed ?? 1);
  const order = [...people].sort(() => rand() - 0.5);
  const fixed = new Map(input.fixed.map((f) => [`${f.employee}|${f.day}`, f.status]));
  const need = (d: number) => branches.reduce((s, b) => s + (rules.min[b]?.[d] ?? 0), 0);
  const avail = (d: number, off: Map<string, Set<number>>) => people.filter((p) => {
    const f = fixed.get(`${p.id}|${d}`);
    return f ? !LEAVE.includes(f) : !off.get(p.id)?.has(d);
  }).length;

  // 1. Days off.
  const off = new Map(people.map((p) => [p.id, new Set<number>()]));
  const lastOff = new Map<string, Set<number>>();
  for (const f of input.lastWeek ?? []) if (LEAVE.includes(f.status)) (lastOff.get(f.employee) ?? lastOff.set(f.employee, new Set()).get(f.employee)!).add(f.day);
  for (const p of order) {
    const already = [0, 1, 2, 3, 4, 5, 6].filter((d) => fixed.get(`${p.id}|${d}`) === "OFF").length; // leave doesn't use up the weekly day off
    for (let k = already; k < rules.days_off; k++) {
      const free = [0, 1, 2, 3, 4, 5, 6].filter((d) => !fixed.has(`${p.id}|${d}`) && !off.get(p.id)!.has(d));
      const usual = (p.daysOff ?? []).map((w) => (w + 6) % 7); // Sunday-based -> Monday-based
      const score = (d: number) => {
        const spare = avail(d, off) - need(d);
        return (spare <= 0 ? -1000 : spare * 10) + (usual.includes(d) ? 25 : 0) + (d >= 5 ? -4 : 0)
          - (lastOff.get(p.id)?.has(d) ? 3 : 0) + rand();
      };
      const best = free.sort((a, b) => score(b) - score(a))[0];
      if (best !== undefined) off.get(p.id)!.add(best);
    }
  }

  // 2 and 3. Branches, day by day.
  const worked = new Map<string, number>(); // `${person}|${branch}` -> days this week
  const days: Row[][] = [];
  const short: { day: number; branch: string; need: number; have: number }[] = [];
  for (let d = 0; d < 7; d++) {
    const rows: Row[] = [];
    const count = new Map(branches.map((b) => [b, 0]));
    const free: AutoPerson[] = [];
    for (const p of order) {
      const f = fixed.get(`${p.id}|${d}`);
      if (f) { if (count.has(f)) count.set(f, count.get(f)! + 1); continue; }
      if (off.get(p.id)!.has(d)) { rows.push({ employee: p.id, status: "OFF" }); continue; }
      free.push(p);
    }
    const hours = (p: AutoPerson) => ({ start: p.start ?? "10:00", end: p.end ?? "19:00" });
    const place = (p: AutoPerson, b: string) => {
      rows.push({ employee: p.id, status: b, ...hours(p) });
      count.set(b, count.get(b)! + 1);
      worked.set(`${p.id}|${b}`, (worked.get(`${p.id}|${b}`) ?? 0) + 1);
      free.splice(free.indexOf(p), 1);
    };
    // Fill minimums, branch with the fewest home people first.
    const homeCount = (b: string) => free.filter((p) => p.home === b).length;
    for (const b of [...branches].sort((x, y) => homeCount(x) - homeCount(y))) {
      while (count.get(b)! < (rules.min[b]?.[d] ?? 0) && free.length) {
        const pick = [...free].sort((x, y) => fit(y, b) - fit(x, b))[0];
        place(pick, b);
      }
    }
    // Everyone left: home branch, else the branch furthest under its minimum ratio.
    for (const p of [...free]) {
      const b = p.home && branches.includes(p.home) ? p.home
        : [...branches].sort((x, y) => count.get(x)! / Math.max(1, rules.min[x]?.[d] ?? 1) - count.get(y)! / Math.max(1, rules.min[y]?.[d] ?? 1))[0];
      place(p, b);
    }
    for (const b of branches) if (count.get(b)! < (rules.min[b]?.[d] ?? 0)) short.push({ day: d, branch: b, need: rules.min[b][d], have: count.get(b)! });
    days.push(rows);

    function fit(p: AutoPerson, b: string) {
      // Home branch wins; then familiarity this week; a person whose home branch is short today is kept for it.
      const homeShort = p.home && p.home !== b && count.get(p.home)! < (rules.min[p.home]?.[d] ?? 0) ? -50 : 0;
      return (p.home === b ? 100 : 0) + (worked.get(`${p.id}|${b}`) ?? 0) * 5 + homeShort + rand();
    }
  }
  return { days, short };
}

export type CheckShift = { employee_id: string; date: string; off: boolean; branch_id: string | null; leave?: string | null };
/** Problems a manager should see before publishing. `dates` = the week's 7 dates, Monday first. */
export function checkWeek(input: { dates: string[]; people: { id: string; name: string }[]; branches: { id: string; name: string }[]; shifts: CheckShift[]; rules: Rules; dayLabel: (d: string) => string }): string[] {
  const { dates, people, branches, shifts, rules, dayLabel } = input;
  if (!shifts.length) return [];
  const out: string[] = [];
  dates.forEach((d, i) => {
    const day = shifts.filter((s) => s.date === d);
    if (!day.length) { out.push(`${dayLabel(d)}: nothing planned yet.`); return; }
    for (const b of branches) {
      const n = day.filter((s) => !s.off && s.branch_id === b.id).length;
      const min = rules.min[b.id]?.[i] ?? 0;
      if (n < min) out.push(`${dayLabel(d)}: ${b.name} has ${n === 0 ? "nobody" : `only ${n}`} (needs ${min}).`);
    }
    const missing = people.filter((p) => !day.some((s) => s.employee_id === p.id));
    if (missing.length) out.push(`${dayLabel(d)}: no plan for ${missing.map((p) => p.name).join(", ")}.`);
  });
  for (const p of people) {
    const mine = shifts.filter((s) => s.employee_id === p.id);
    if (mine.length === 7 && mine.every((s) => !s.off)) out.push(`${p.name} works all 7 days with no day off.`);
    // Scheduled working days (leave and absences count as scheduled). Fewer than usual is sometimes on purpose
    // (CHRIS: some staff have a 5-day arrangement), so ask instead of assuming (Nov 25).
    const work = mine.filter((s) => !s.off || s.leave).length;
    if (mine.length === 7 && work < 7 - rules.days_off) out.push(`${p.name} only has ${work} working day${work === 1 ? "" : "s"} this week. Confirm?`);
  }
  return out;
}
