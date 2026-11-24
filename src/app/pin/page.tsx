import { redirect } from "next/navigation";
import { requireAccess } from "@/lib/access";
import { PinForm } from "./PinForm";

/** Second sign-in step for staff with a PIN (set privately by an owner). */
export default async function PinPage() {
  const { supabase } = await requireAccess({ allowWithoutPin: true });
  const { data } = await supabase.rpc("my_pin_status");
  if (!data?.has_pin || data.verified) redirect("/");
  return (
    <div className="center">
      <div className="card auth-card">
        <img src="/hermosa-logo.png" alt="Hermosa Aesthetics" />
        <h1>Enter your PIN</h1>
        <p className="muted small">The 4-digit PIN the owner gave you. You&apos;ll be asked again each day.</p>
        <PinForm />
        <form action="/auth/signout" method="post"><button type="submit" className="secondary small">Sign out</button></form>
      </div>
    </div>
  );
}
