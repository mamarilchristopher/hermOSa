import { LoginForm } from "./LoginForm";

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  return (
    <div className="center">
      <div className="card auth-card">
        <img src="/hermosa-logo-transparent.png" alt="Hermosa Aesthetics" />
        <h1>Sign in to Hermosa OS</h1>
        <p className="muted small">New staff join through the invite link from the owner.</p>
        {error === "no_account" && (
          <div className="notice error">Your login works but has no Hermosa OS account yet. Ask the owner to add you.</div>
        )}
        <LoginForm />
      </div>
    </div>
  );
}
