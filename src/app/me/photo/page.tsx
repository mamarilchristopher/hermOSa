import { requireAccess } from "@/lib/access";
import { TopBar } from "@/components/TopBar";
import { photoUrls } from "@/lib/photos";
import { PhotoUpload } from "./PhotoUpload";

/** Staff choose their profile picture; an owner or the GM approves it (update-0034). */
export default async function MyPhoto() {
  const { supabase, access } = await requireAccess();
  const [{ data: me }, { data: last }] = await Promise.all([
    supabase.from("app_users").select("photo_path").eq("id", access.user_id).maybeSingle(),
    supabase.from("profile_photos").select("path, state, note, submitted_at").eq("user_id", access.user_id).neq("state", "SUPERSEDED")
      .order("submitted_at", { ascending: false }).limit(1).maybeSingle(),
  ]);
  const urls = await photoUrls(supabase, [me?.photo_path, last?.path]);
  const current = me?.photo_path ? urls.get(me.photo_path) : null;
  const pending = last?.state === "PENDING" ? urls.get(last.path) : null;

  return (
    <>
      <TopBar access={access} />
      <main className="narrow">
        <h1>My profile picture</h1>
        <p className="muted small">Use a clear, recent photo of your face, like an ID picture. An owner approves it before it shows on your account.</p>
        <div className="card">
          {current ? (
            <>
              <h2>Your picture</h2>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img className="photo-preview" src={current} alt="Your profile picture" />
            </>
          ) : <p className="muted" style={{ marginTop: 0 }}>You don&apos;t have an approved picture yet.</p>}
          {pending && (
            <div className="notice info" style={{ marginTop: 12 }}>
              Waiting for approval:
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={pending} alt="Your photo waiting for approval" style={{ width: 64, height: 64, borderRadius: "50%", objectFit: "cover", verticalAlign: "middle", marginLeft: 8 }} />
            </div>
          )}
          {last?.state === "RETURNED" && <div className="notice error" style={{ marginTop: 12 }}><strong>Sent back:</strong> {last.note} Please upload another one.</div>}
        </div>
        <div className="card">
          <h2>{current || pending ? "Change your picture" : "Add your picture"}</h2>
          <PhotoUpload userId={access.user_id} />
        </div>
      </main>
    </>
  );
}
