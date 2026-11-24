"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/browser";

type Setup = { factorId: string; qr?: string; secret?: string; enrolling: boolean };

// Owner, Finance and HR accounts must verify with an authenticator app (TOTP) every session.
export function MfaForm() {
  const supabase = createClient();
  const router = useRouter();
  const [setup, setSetup] = useState<Setup | null>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    (async () => {
      const { data, error } = await supabase.auth.mfa.listFactors();
      if (error) return setError("Could not load your authenticator settings.");
      const verified = data.totp.find((f) => f.status === "verified");
      if (verified) return setSetup({ factorId: verified.id, enrolling: false });
      // Remove half-finished enrolments before starting a new one.
      for (const f of data.all.filter((f) => f.status === "unverified")) await supabase.auth.mfa.unenroll({ factorId: f.id });
      const enrolled = await supabase.auth.mfa.enroll({ factorType: "totp", issuer: "Hermosa OS", friendlyName: `Hermosa OS ${Date.now()}` });
      if (enrolled.error) return setError("Could not start authenticator setup.");
      setSetup({ factorId: enrolled.data.id, qr: enrolled.data.totp.qr_code, secret: enrolled.data.totp.secret, enrolling: true });
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function verify(e: React.FormEvent) {
    e.preventDefault();
    if (!setup) return;
    setBusy(true);
    setError(null);
    const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId: setup.factorId, code: code.trim() });
    setBusy(false);
    if (error) return setError("That code didn't work. Check the time on your phone and try again.");
    router.replace("/");
    router.refresh();
  }

  if (!setup && !error) return <p className="muted">Loading…</p>;
  return (
    <form onSubmit={verify} className="stack">
      {error && <div className="notice error">{error}</div>}
      {setup?.enrolling && (
        <>
          <p>Scan this with Google Authenticator, Microsoft Authenticator or 1Password, then enter the 6-digit code.</p>
          {setup.qr && <img src={setup.qr} alt="Authenticator QR code" width={200} height={200} />}
          <p className="small muted">Can't scan? Enter this key: <code>{setup.secret}</code></p>
          <p className="small">In your authenticator app it will be listed as <strong>Hermosa OS</strong>. Keep it: you'll need it every time you sign in.</p>
        </>
      )}
      {setup && !setup.enrolling && (
        <>
          <p>Enter the 6-digit code shown for <strong>Hermosa OS</strong> in your authenticator app.</p>
          <p className="small muted">Lost your authenticator or can&apos;t find Hermosa OS in it? Ask the owner to reset your 2-step verification.</p>
        </>
      )}
      <label>
        Code
        <input value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" pattern="[0-9]{6}" maxLength={6} autoComplete="one-time-code" required />
      </label>
      <button type="submit" disabled={busy || !setup}>{busy ? "Checking…" : "Verify"}</button>
    </form>
  );
}
