import "server-only";
import { redirect } from "next/navigation";
import { createClient } from "./supabase/server";
import { sortBranches } from "./insights";

export type Role = "OWNER" | "FINANCE" | "MANAGER" | "CASHIER" | "HR" | "MARKETING" | "CLINICIAN" | "INVENTORY" | "AUDITOR" | "CSR";
export type Access = {
  user_id: string;
  display_name: string;
  mfa: boolean;
  needs_mfa: boolean;
  join_status?: "PENDING" | "APPROVED" | "REJECTED";
  grants: { role: Role; branch_id: string | null }[];
};
export type Branch = { id: string; code: string; name: string; kind: "CLINIC" | "HQ" | "WFH"; active?: boolean };

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
    supabase.from("branches").select("id, code, name, kind, active").order("name"),
    supabase.rpc("my_pin_status"), // errors (before update-0018) mean no PIN step
  ]);
  if (error) throw new Error("Could not load access");
  const access = data as Access | null;
  if (!access) redirect("/login?error=no_account");
  if (access.join_status === "PENDING" && !opts.allowPending) redirect("/pending");
  if (access.needs_mfa && !access.mfa && !opts.allowWithoutMfa) redirect("/mfa");
  if (pin?.has_pin && !pin.verified && !opts.allowWithoutPin) redirect("/pin");
  // v0.48.2: switched-off branches (e.g. the old "TEST (Chris)" branch) are hidden everywhere in the app.
  return { supabase, access, branches: sortBranches(((branches ?? []) as Branch[]).filter((b) => b.active !== false)) };
}

const effective = (a: Access, role: Role) =>
  a.grants.some((g) => g.role === role) && (!["OWNER", "FINANCE", "HR"].includes(role) || a.mfa);

export function can(a: Access, roles: Role[], branchId: string | null): boolean {
  return a.grants.some(
    (g) =>
      roles.includes(g.role) &&
      effective(a, g.role) &&
      (g.branch_id === null || (branchId !== null && (g.branch_id === branchId || ANY_BRANCH.includes(g.role)))),
  );
}

/** update-0092 (CHRIS Nov 27): staff move between branches, so a branch CLINICIAN grant (CMAs, Senior CMAs, Trainees) works at every
 *  clinic (the home branch stays on their records). The database (private.has_role) applies the same rule. */
const ANY_BRANCH: Role[] = ["CLINICIAN"];

/** The General Manager: a company-wide MANAGER grant (Geraldine). Since update-0028 the GM gives every owner-level approval. */
export const isGM = (a: Access) => can(a, ["MANAGER"], null);

/** Owner-level approver: an owner, or the GM. Pass ["OWNER", "FINANCE"] where Finance also approves. */
export function canApprove(a: Access, branchId: string | null, roles: Role[] = ["OWNER"]) {
  return can(a, roles, branchId) || isGM(a);
}

export function branchesFor(a: Access, branches: Branch[], roles: Role[]) {
  return branches.filter((b) => b.kind === "CLINIC" && can(a, roles, b.id));
}

export const ERROR_TEXT: Record<string, string> = {
  FORBIDDEN: "You don't have access to that.",
  BAD_START_DATE: "That start date doesn't look right. Check the year.",
  NOT_SCHEDULED: "That day isn't on the published schedule yet.",
  SAME_SHIFT: "You both have the same schedule that day, so there's nothing to swap.",
  ON_LEAVE: "One of you is on leave that day, so it can't be swapped.",
  NOT_A_DAY_OFF: "Pick one of your days off as the day you'll work.",
  NO_EMPLOYEE_RECORD: "You don't have an employee record yet. Ask the owner to add you on Employees.",
  PHOTO_REQUIRED: "Take a photo of the clinic clock to time in or out.",
  ALREADY_IN: "You're already timed in. Time out first.",
  NOT_IN: "You haven't timed in yet today.",
  NOT_TIMED_IN: "Time in first. Only staff who are timed in today can add to the Service log.",
  CLIENT_NAME_REQUIRED: "Type the client's name.",
  PRICE_NOTE_REQUIRED: "The amount is different from the list price. Add the reason (e.g. the promo or discount).",
  WAIVER_PHOTOS_REQUIRED: "Add both pages of the signed waiver.",
  BEFORE_AFTER_REQUIRED: "Add at least one before and one after photo.",
  PHOTO_NOT_UPLOADED: "A photo didn't finish uploading. Remove it and add it again.",
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
  OTHER_REASON_REQUIRED: "Type the reason when you pick Other.",
  BAD_EXPECTED_TOTAL: "Enter the expected row count and total from the branch report.",
  CSV_HAS_NO_RECORDS: "The file has no sales rows.",
  MISSING_CSV_COLUMNS: "The file needs the columns source_id, posting_date and amount_php.",
  MALFORMED_CSV: "The file isn't a valid CSV.",
  UNCLOSED_CSV_QUOTE: "The file isn't a valid CSV (a quote is never closed).",
  UNKNOWN_BRANCH: "Unknown branch.",
  WRONG_BRANCH_TODAY: "Today this person timed in at another branch. Log it at the branch where they timed in, or ask the GM.",
  CANCEL_REASON_REQUIRED: "Write the client's reason for cancelling first.",
  BOOKING_DATE: "Check the date: bookings can be up to 30 days back or a year ahead, and a re-sched needs a new day from today on.",
  NOT_AUTHENTICATED: "Please sign in again.",
  PAYROLL_IS_FINAL: "This payroll is final and can't change. Add it to the next cutoff instead.",
  CUTOFF_NOT_OVER: "This cutoff isn't over yet. You can finalize it on its last day.",
  NO_PAY_RATE: "Save this person's pay rate first, then set the COLA.",
  ALREADY_DECIDED: "Someone already decided this. Refresh the page.",
  INVALID_RULE: "Pick when government shares are deducted.",
  INVALID_HOLIDAY: "Pick a date, type the holiday's name and choose regular or special.",
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
  SERVICE_EXISTS: "A service with that name already exists. Edit that one instead.",
  BAD_REQUEST: "Something was missing. Try again.",
  LEVEL_REQUIRED: "Choose a staff level first.",
  OWNER_ONLY_LEVEL: "Only an owner can approve that level. Choose a staff level, or ask an owner.",
  BRANCH_REQUIRED: "Choose their home branch.",
  UNKNOWN_USER: "That person isn't in the list any more. Refresh the page.",
  SELF_ESCALATION_DENIED: "You can't change your own access.",
  SELF_CHANGE_DENIED: "You can't do this to your own account.",
  OWNER_LOGIN_LOCKED: "An owner's login can't be moved this way.",
  NEEDS_UPDATE_0089: "Run update-0089 in Supabase first (it's on your To-Do).",
  LEAVE_DATES: "Those dates can't be filed: vacation leave is filed ahead, sick leave up to 14 days after, and up to 6 months ahead.",
  LEAVE_OVERLAP: "You already filed leave on some of those days.",
  PAY_CHOICE_REQUIRED: "Choose with pay or without pay.",
  COWORKER_PENDING: "Your coworker hasn't accepted this swap yet.",
  SWAP_ALREADY_ASKED: "A swap for one of those days is already waiting. Cancel it first or pick other days.",
  SCHEDULE_CHANGED_SINCE: "The schedule changed since this was asked. Ask them to send a new request.",
};
export const errorText = (code: string | undefined) => (code && ERROR_TEXT[code]) || "Something went wrong.";
