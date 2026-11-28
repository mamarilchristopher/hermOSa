import { ForgotForm } from "../ForgotForm";

export default async function ForgotPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  return (
    <div className="center">
      <div className="card auth-card">
        <img className="logo-light" src="/hermosa-logo-transparent.png" alt="Hermosa Aesthetics" />
        <img className="logo-dark" src="/hermosa-logo-dark.png" alt="Hermosa Aesthetics" />
        <h1>Forgot password</h1>
        <p className="muted small">Set a new password yourself. No approval needed: your account, roles and records stay the same.</p>
        {error === "link" && <div className="notice error">That reset link has expired or was already used. Send a new code below.</div>}
        <ForgotForm />
      </div>
    </div>
  );
}
