"use server";
import { redirect } from "next/navigation";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";

const Login = z.object({ email: z.email().max(254), password: z.string().min(8).max(200) });

export async function signIn(_prev: { error?: string } | undefined, formData: FormData) {
  const parsed = Login.safeParse({ email: formData.get("email"), password: formData.get("password") });
  if (!parsed.success) return { error: "Enter your email and password." };
  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword(parsed.data);
  if (error?.code === "email_not_confirmed") {
    return { error: "Your email isn't confirmed yet. Open the confirmation email from Hermosa OS (check Spam), or ask the owner to confirm it." };
  }
  // Same message for unknown email and wrong password.
  if (error) return { error: "Wrong email or password." };
  redirect("/");
}
