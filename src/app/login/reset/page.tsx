import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { ResetForm } from "../ForgotForm";

/** Set a new password while signed in: after tapping the emailed reset link, or anytime ("Change password"). */
export default async function ResetPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login/forgot");
  return (
    <div className="center">
      <div className="card auth-card">
        <img className="logo-light" src="/hermosa-logo-transparent.png" alt="Hermosa Aesthetics" />
        <img className="logo-dark" src="/hermosa-logo-dark.png" alt="Hermosa Aesthetics" />
        <h1>Set a new password</h1>
        <p className="muted small">For {user.email}. No approval needed.</p>
        <ResetForm />
        <p className="small center-link"><Link href="/">Cancel</Link></p>
      </div>
    </div>
  );
}
