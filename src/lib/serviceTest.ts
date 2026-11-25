// Staff phone test of the Service log (CHRIS, Nov 26): log "TEST Service", ₱100, with sample photos and waiver,
// Solo if commission-based, No commission if not. Returns what's wrong; empty means it all worked.
export type TestEntry = {
  kind: string; cents: number; type: string; eligible: boolean | null;
  photos: { kind: string }[]; photosDue: boolean;
};
export const TEST_OK = "✅ Your service logging feature is working correctly.";

export function testProblems(t: TestEntry): string[] {
  const out: string[] = [];
  const n = (k: string) => t.photos.filter((p) => p.kind === k).length;
  if (t.kind !== "PAID") out.push("choose Paid");
  if (t.cents !== 10000) out.push("enter 100 as the amount paid");
  if (t.eligible === true && t.type !== "SOLO") out.push("choose Solo commission (you're commission-based)");
  if (t.eligible === false && t.type !== "NONCOMMI") out.push("choose No commission (you're not commission-based)");
  if (n("BEFORE") < 1) out.push("add a before photo");
  if (n("AFTER") < 1) out.push("add an after photo");
  if (n("WAIVER") < 2) out.push("add both waiver pages");
  if (t.photosDue && out.length === 0) out.push("add the photos and waiver");
  return out;
}

export function testResult(t: TestEntry): string {
  const p = testProblems(t);
  return p.length === 0 ? TEST_OK : `Test saved, but it isn't complete yet: ${p.join(", ")}. Try the test again.`;
}
