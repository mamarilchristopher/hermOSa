import { NextResponse, type NextRequest } from "next/server";
import type { EmailOtpType } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";

// v0.106.1: the "reset password" email link lands here. It signs the person in for the reset, then opens the
// new-password page. Works with a token_hash link (any phone or computer) or Supabase's default ?code= link.
export async function GET(request: NextRequest) {
  const u = request.nextUrl;
  const nextParam = u.searchParams.get("next") ?? "/login/reset";
  const next = /^\/[a-z0-9/_-]*$/i.test(nextParam) && !nextParam.startsWith("//") ? nextParam : "/login/reset";
  const supabase = await createClient();
  const tokenHash = u.searchParams.get("token_hash");
  const type = (u.searchParams.get("type") ?? "recovery") as EmailOtpType;
  const code = u.searchParams.get("code");
  let ok = false;
  if (tokenHash) ok = !(await supabase.auth.verifyOtp({ token_hash: tokenHash, type })).error;
  else if (code) ok = !(await supabase.auth.exchangeCodeForSession(code)).error;
  const to = u.clone();
  to.search = "";
  to.pathname = ok ? next : "/login/forgot";
  if (!ok) to.searchParams.set("error", "link");
  return NextResponse.redirect(to);
}
