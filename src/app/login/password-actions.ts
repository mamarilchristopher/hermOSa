"use server";
// v0.106.1 (CHRIS Nov 28): "Forgot password" for everyone. Changing your own password needs no approval: the person
// proves it's them with the code or link emailed to their login email, then sets a new password. Their account,
// roles, PIN, payroll and records stay exactly as they are.
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";

export type ForgotState = { error?: string; sent?: string; done?: boolean } | undefined;

const Email = z.email().max(254);
const NEW_PW_MIN = 10;

function pwError(pw: string, again: string): string | null {
  if (pw.length < NEW_PW_MIN) return `The new password needs at least ${NEW_PW_MIN} characters.`;
  if (pw.length > 200) return "That password is too long.";
  if (pw !== again) return "The two new passwords don't match.";
  return null;
}

/** Step 1: email a reset code and link. Always says "sent" so nobody can test which emails have a login. */
export async function sendResetEmail(_prev: ForgotState, fd: FormData): Promise<ForgotState> {
  const email = Email.safeParse(String(fd.get("email") ?? "").trim().toLowerCase());
  if (!email.success) return { error: "Enter the email you sign in with." };
  const h = await headers();
  const origin = `${h.get("x-forwarded-proto") ?? "https"}://${h.get("host")}`;
  const supabase = await createClient();
  const { error } = await supabase.auth.resetPasswordForEmail(email.data, { redirectTo: `${origin}/auth/confirm?next=/login/reset` });
  if (error && /rate limit|too many|security purposes/i.test(error.message)) {
    return { error: "Too many reset emails were sent in the last hour. Wait a few minutes, then try again, or tell the owner." };
  }
  if (error) console.error("resetPasswordForEmail failed", error.message);
  return { sent: email.data };
}

/** Step 2a: the 6-digit code from the email, plus the new password (works on any phone or computer). */
export async function resetWithCode(_prev: ForgotState, fd: FormData): Promise<ForgotState> {
  const email = Email.safeParse(String(fd.get("email") ?? "").trim().toLowerCase());
  const code = String(fd.get("code") ?? "").replace(/\s/g, "");
  const pw = String(fd.get("password") ?? ""), again = String(fd.get("again") ?? "");
  if (!email.success) return { error: "Enter the email you sign in with." };
  if (!/^\d{6,10}$/.test(code)) return { sent: email.data, error: "Type the code from the email (numbers only)." };
  const bad = pwError(pw, again);
  if (bad) return { sent: email.data, error: bad };
  const supabase = await createClient();
  const { error: vErr } = await supabase.auth.verifyOtp({ email: email.data, token: code, type: "recovery" });
  if (vErr) return { sent: email.data, error: "That code is wrong or has expired. Check the newest email, or send a new code." };
  return setPassword(pw);
}

/** Step 2b: signed in through the emailed link (or already signed in): just the new password. */
export async function resetSignedIn(_prev: ForgotState, fd: FormData): Promise<ForgotState> {
  const pw = String(fd.get("password") ?? ""), again = String(fd.get("again") ?? "");
  const bad = pwError(pw, again);
  if (bad) return { error: bad };
  return setPassword(pw);
}

async function setPassword(pw: string): Promise<ForgotState> {
  const supabase = await createClient();
  const { error } = await supabase.auth.updateUser({ password: pw });
  if (error) {
    // Accounts with an authenticator app (owners) confirm it first, then come back here.
    if (error.code === "insufficient_aal" || /aal2|AAL2/.test(error.message)) redirect("/mfa?next=/login/reset");
    if (error.code === "same_password") return { error: "That's your current password. Pick a new one." };
    if (error.code === "weak_password" || /password/i.test(error.message)) return { error: `That password was refused: ${error.message}` };
    return { error: "Could not change the password. Try again." };
  }
  return { done: true };
}
