import "server-only";
import { redirect } from "next/navigation";
import { createClient } from "./supabase/server";
import { sortBranches } from "./insights";

export type Role = "OWNER" | "FINANCE" | "MANAGER" | "CASHIER" | "HR" | "MARKETING" | "CLINICIAN" | "INVENTORY" | "AUDITOR";
export type Access = {
  user_id: string;
  display_name: string;
  mfa: boolean;
  needs_mfa: boolean;
  join_status?: "PENDING" | "APPROVED" | "REJECTED";
  grants: { role: Role; branch_id: string | null }[];
};
export type Branch = { id: string; code: string; name: string; kind: "CLINIC" | "HQ" };

/**
 * Loads the signed-in user's access for building the UI. Redirects to /login when signed out,
 * and to /mfa when a privileged role needs a second factor. The database enforces the same
 * rules again; hiding a button here is never the security boundary.
 */
export async function requireAccess(opts: { allowWithoutMfa?: boolean; allowPending?: boolean; allowWithoutPin?: boolean } = {}) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  // Both reads go out together: each trip to the database counts on every page load.
  const [{ data, error }, { data: branches }, { data: pin }] = await Promise.all([
    supabase.rpc("my_access"),
    supabase.from("branches").select("id, code, name, kind").order("name"),
    supabase.rpc("my_pin_status"), // errors (before update-0018) mean no PIN step
  ]);
  if (error) throw new Error("Could not load access");
  const access = data as Access | null;
  if (!access) redirect("/login?error=no_account");
  if (access.join_status === "PENDING" && !opts.allowPending) redirect("/pending");
  if (access.needs_mfa && !access.mfa && !opts.allowWithoutMfa) redirect("/mfa");
  if (pin?.has_pin && !pin.verified && !opts.allowWithoutPin) redirect("/pin");
  return { supabase, access, branches: sortBranches((branches ?? []) as Branch[]) };
}

const effective = (a: Access, role: Role) =>
  a.grants.some((g) => g.role === role) && (!["OWNER", "FINANCE", "HR"].includes(role) || a.mfa);

export function can(a: Access, roles: Role[], branchId: string | null): boolean {
  return a.grants.some(
    (g) =>
      roles.includes(g.role) &&
      effective(a, g.role) &&
      (g.branch_id === null || (branchId !== null && g.branch_id === branchId)),
  );
}

export function branchesFor(a: Access, branches: Branch[], roles: Role[]) {
  return branches.filter((b) => b.kind === "CLINIC" && can(a, roles, b.id));
}

export const ERROR_TEXT: Record<string, string> = {
  FORBIDDEN: "You don't have access to that.",
  DUPLICATE_RECEIPT: "That waiver / OR number is already in the log for this branch. Check the entries below.",
  PIN_WRONG: "That PIN isn't right.",
  PIN_LOCKED: "Too many wrong tries. Wait 15 minutes, or ask the owner to reset your PIN.",
  PIN_FORMAT: "The PIN must be 4 digits.",
  MFA_REQUIRED: "Verify with your authenticator app first.",
  SELF_APPROVAL_DENIED: "Someone other than the uploader has to sign this off.",
  INVALID_ROWS: "Some rows have errors. Fix the file and upload it again.",
  RECONCILIATION_FAILED: "The totals don't match the branch's source report.",
  PERIOD_LOCKED: "That period is locked.",
  DUPLICATE_SOURCE_ACTIVE: "Some sales in this file are already published.",
  NOT_STAGED: "This batch is no longer waiting for sign-off.",
  NOT_PUBLISHED: "Only published batches can be reversed.",
  REASON_REQUIRED: "Give a reason of at least 8 characters.",
  BAD_EXPECTED_TOTAL: "Enter the expected row count and total from the branch report.",
  CSV_HAS_NO_RECORDS: "The file has no sales rows.",
  MISSING_CSV_COLUMNS: "The file needs the columns source_id, posting_date and amount_php.",
  MALFORMED_CSV: "The file isn't a valid CSV.",
  UNCLOSED_CSV_QUOTE: "The file isn't a valid CSV (a quote is never closed).",
  UNKNOWN_BRANCH: "Unknown branch.",
  NOT_AUTHENTICATED: "Please sign in again.",
  DAY_ALREADY_RECORDED: "That day already has sales or a mark.",
  NOT_PENDING: "Someone already decided this one.",
  INVALID_AMOUNT: "Enter an amount above zero.",
  INVALID_DATE: "Only past days can be filled in.",
  NOT_FOUND: "Not found. Refresh the page.",
  ASSISTANT_REQUIRED: "Choose who assisted (or who led, for Assist).",
  SAME_PERSON: "The lead and the assistant must be different people.",
  EMPLOYEE_REQUIRED: "Choose who did the service.",
  UNKNOWN_EMPLOYEE: "That employee isn't active. Refresh the page.",
  UNKNOWN_SERVICE: "That service isn't available. Refresh the page.",
  NAME_REQUIRED: "Type a name.",
  BAD_REQUEST: "Something was missing. Try again.",
  LEVEL_REQUIRED: "Choose a staff level first.",
  BRANCH_REQUIRED: "Choose their home branch.",
  UNKNOWN_USER: "That person isn't in the list any more. Refresh the page.",
  SELF_ESCALATION_DENIED: "You can't change your own access.",
};
export const errorText = (code: string | undefined) => (code && ERROR_TEXT[code]) || "Something went wrong.";
