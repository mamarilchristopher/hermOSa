import { redirect } from "next/navigation";
import { requireAccess } from "@/lib/access";

/** Where a registered but not yet approved login lands. It can see nothing else. */
export default async function Pending() {
  const { access } = await requireAccess({ allowPending: true, allowWithoutMfa: true });
  if (access.join_status !== "PENDING") redirect("/");
  return (
    <div className="center">
      <div className="card auth-card">
        <img src="/hermosa-logo-transparent.png" alt="Hermosa Aesthetics" />
        <h1>Waiting for approval</h1>
        <p className="muted small">Hi {access.display_name}. You're registered. The owner still needs to approve you and set your staff level. Check back later.</p>
        <p className="small">While you wait, please fill in your employee details so the owner can set up your record.</p>
        <p><a className="button" href="/me/details">Fill in my employee details</a></p>
        <form action="/auth/signout" method="post"><button type="submit" className="secondary">Sign out</button></form>
      </div>
    </div>
  );
}
