"use server";
import { headers } from "next/headers";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";

type State = { error?: string; done?: boolean; confirm?: boolean } | undefined;
const Join = z.object({
  code: z.string().regex(/^[a-z0-9]{12,40}$/),
  full_name: z.string().trim().min(2).max(120),
  branch: z.uuid(),
  level: z.enum(["SENIOR_CMA", "CMA", "TRAINEE", "CSR", "CASHIER", "MANAGER", "OWNER", "OTHER"]),
  email: z.email().max(254),
  password: z.string().min(10).max(200),
});

export async function register(_prev: State, fd: FormData): Promise<State> {
  const p = Join.safeParse(Object.fromEntries(["code", "full_name", "branch", "level", "email", "password"].map((k) => [k, fd.get(k)])));
  if (!p.success) return { error: "Fill in every field, including your role. The password needs at least 10 characters." };
  const h = await headers();
  const origin = `${h.get("x-forwarded-proto") ?? "https"}://${h.get("host")}`;
  const supabase = await createClient();
  const { data, error } = await supabase.auth.signUp({
    email: p.data.email,
    password: p.data.password,
    options: {
      emailRedirectTo: `${origin}/login`,
      data: { full_name: p.data.full_name, invite_code: p.data.code, requested_branch: p.data.branch, requested_level: p.data.level },
    },
  });
  if (error) {
    // The database refuses sign-ups with a dead invite code; Supabase reports that as a generic error.
    if (/database error/i.test(error.message)) return { error: "This invite link has expired or was turned off. Ask the owner for a new link." };
    if (/registered|exists/i.test(error.message)) return { error: "That email already has a login. Sign in instead." };
    if (/signups not allowed/i.test(error.message)) return { error: "Registration is turned off right now. Tell the owner." };
    // Supabase's built-in mailer sends only a few confirmation emails an hour for the whole project.
    if (/rate limit|too many|security purposes/i.test(error.message))
      return { error: "Too many people registered in the last hour. Wait a few minutes, then try again, or tell the owner." };
    if (/password/i.test(error.message)) return { error: `That password was refused: ${error.message}` };
    console.error("signUp failed", error);
    return { error: `Could not register. Try again. (${error.message.slice(0, 120)})` };
  }
  await supabase.auth.signOut();
  return { done: true, confirm: !data.session };
}
