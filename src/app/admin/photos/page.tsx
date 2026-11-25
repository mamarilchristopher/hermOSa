import { redirect } from "next/navigation";
import { can, requireAccess } from "@/lib/access";
import { TopBar } from "@/components/TopBar";
import { Uid } from "@/components/Uid";
import { photoUrls } from "@/lib/photos";
import { DecidePhotoForm } from "./Forms";

type Row = { id: string; user_id: string; path: string; state: string; note: string | null; submitted_at: string; decided_at: string | null };

/** Owners and the General Manager approve staff profile pictures (update-0034). */
export default async function PhotoApprovals() {
  const { supabase, access } = await requireAccess();
  const owner = can(access, ["OWNER"], null);
  if (!owner && !can(access, ["MANAGER"], null)) redirect("/");
  const [{ data, error }, { data: users }] = await Promise.all([
    supabase.from("profile_photos").select("id, user_id, path, state, note, submitted_at, decided_at").neq("state", "SUPERSEDED").order("submitted_at", { ascending: false }).limit(100),
    supabase.from("app_users").select("id, uid, display_name"),
  ]);
  const rows = (data ?? []) as Row[];
  const waiting = rows.filter((r) => r.state === "PENDING").reverse();
  const recent = rows.filter((r) => r.state !== "PENDING").slice(0, 20);
  const who = new Map((users ?? []).map((u) => [u.id, u]));
  const urls = await photoUrls(supabase, rows.map((r) => r.path));
  const day = (t: string) => new Date(t).toLocaleDateString("en-PH", { timeZone: "Asia/Manila", month: "short", day: "numeric" });

  return (
    <>
      <TopBar access={access} />
      <main>
        <h1>Profile pictures</h1>
        <p className="muted small">Staff send their photo from Home. Approve it to make it their picture in Hermosa OS, or send it back with a note.</p>
        {error && <div className="notice info">{error.code === "42P01" ? "The owner needs to run update-0034 in Supabase first." : "Could not load. Try again."}</div>}
        <div className="card">
          <h2>Waiting for you ({waiting.length})</h2>
          {waiting.length === 0 && <p className="muted small" style={{ margin: 0 }}>Nothing to approve.</p>}
          {waiting.map((r) => (
            <div key={r.id} className="photo-review">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              {urls.get(r.path) ? <img src={urls.get(r.path)} alt={`${who.get(r.user_id)?.display_name ?? "Staff"} profile picture`} /> : <span />}
              <div>
                <p style={{ margin: "0 0 8px" }}><strong>{who.get(r.user_id)?.display_name ?? "Staff"}</strong><Uid v={who.get(r.user_id)?.uid} /> <span className="small muted">sent {day(r.submitted_at)}</span></p>
                {r.user_id === access.user_id && !owner ? <p className="small muted">Yours: an owner approves it.</p> : <DecidePhotoForm id={r.id} />}
              </div>
            </div>
          ))}
        </div>
        {recent.length > 0 && (
          <div className="card">
            <h2>Recently decided</h2>
            <ul className="plain-list">
              {recent.map((r) => (
                <li key={r.id}>
                  <span className="name-with-photo">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    {urls.get(r.path) && <img className="avatar photo" src={urls.get(r.path)} alt="" />}
                    <span>{who.get(r.user_id)?.display_name ?? "Staff"}<Uid v={who.get(r.user_id)?.uid} />{r.note && <span className="small muted"> · {r.note}</span>}</span>
                  </span>
                  <span className={`pill ${r.state === "APPROVED" ? "PUBLISHED" : "REVERSED"}`}>{r.state === "APPROVED" ? "Approved" : "Sent back"}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </main>
    </>
  );
}
