export type IrDay = { date: string; branch: string | null; start: string; time_in: string; late_min: number; nte_no?: number; explanation?: string | null };
export type Ir = {
  id: string; ir_no: number; employee_id: string; name: string; position: string | null; branch: string | null;
  period_start: string; period_end: string; late_minutes: number; late_days: number; limit_minutes: number; details: IrDay[];
  state: "DRAFT" | "ISSUED" | "EXPLAINED" | "CLOSED" | "DISMISSED"; issue_note: string | null; issued_by: string | null; issued_at: string | null;
  explanation: string | null; explained_at: string | null; action_taken: string | null; closed_by: string | null; closed_at: string | null;
  created_at: string; updated_at?: string; basis?: "CUTOFF_MINUTES" | "LATE_NTE"; acknowledged_at?: string | null;
  pdf_path?: string | null; pdf_saved_at?: string | null; mine: boolean; can_manage: boolean;
};
export const IR_STATE: Record<Ir["state"], { label: string; cls: string }> = {
  DRAFT: { label: "To review", cls: "STAGED" },
  ISSUED: { label: "Waiting for acknowledgement", cls: "STAGED" },
  EXPLAINED: { label: "Acknowledged, to close", cls: "STAGED" },
  CLOSED: { label: "Closed", cls: "PUBLISHED" },
  DISMISSED: { label: "Dismissed", cls: "REVERSED" },
};
export const minutesText = (m: number) => (m >= 60 ? `${Math.floor(m / 60)} hr ${m % 60 ? `${m % 60} min` : ""}`.trim() : `${m} min`);
