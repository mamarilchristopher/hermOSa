// Irregular days (update-0044). Kept out of the "use client" forms file: server components
// (OnDuty, OnDutyFaces) call irregularLabel, and calling a client module's function on the server crashes the page.
export type IrregularTag = { id: string; reason: "MAINTENANCE" | "EMERGENCY" | "OTHER"; note: string | null; whole_day: boolean };
export const irregularLabel = (t: IrregularTag) =>
  t.reason === "MAINTENANCE" ? "Maintenance" : t.reason === "EMERGENCY" ? "Emergency" : t.note || "Other";
