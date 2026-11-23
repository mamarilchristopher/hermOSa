import { createClient } from "@/lib/supabase/server";
import { sortBranches } from "@/lib/insights";
import { JoinForm } from "./JoinForm";

type Info = { valid: boolean; organization?: string; branches?: { id: string; code: string; name: string }[] };

/** Public page behind the staff invite link: register, then wait for the owner's approval. */
export default async function Join({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  const ok = /^[a-z0-9]{12,40}$/.test(code);
  const supabase = await createClient();
  const { data } = ok ? await supabase.rpc("staff_invite_info", { p_code: code }) : { data: null };
  const info = (data ?? { valid: false }) as Info;
  return (
    <div className="center">
      <div className="card auth-card">
        <img src="/hermosa-logo.png" alt="Hermosa Aesthetics" />
        <h1>Join Hermosa OS</h1>
        {info.valid ? (
          <>
            <p className="muted small">Create your staff login. The owner approves you and sets your staff level before you can use the app.</p>
            <JoinForm code={code} branches={sortBranches(info.branches ?? [])} />
          </>
        ) : (
          <div className="notice error">This invite link has expired or was turned off. Ask the owner for a new link.</div>
        )}
      </div>
    </div>
  );
}
