import Link from "next/link";
import { redirect } from "next/navigation";
import { requireAccess, branchesFor } from "@/lib/access";
import { TopBar } from "@/components/TopBar";
import { manilaToday } from "@/lib/dates";
import { TrackerUpload } from "./TrackerUpload";

/** Load days from the Sales Source Tracker download, after checking every row. */
export default async function UploadTracker() {
  const { access, branches } = await requireAccess();
  if (branchesFor(access, branches, ["OWNER", "FINANCE", "MANAGER"]).length === 0) redirect("/");
  return (
    <>
      <TopBar access={access} />
      <main>
        <nav className="crumbs"><Link className="back" href="/sales/daily">← Daily sales</Link></nav>
        <h1>Upload the sales tracker</h1>
        <p className="muted small">Reads the Sales Source Tracker&apos;s branch tabs (DATE and Sales columns) and checks every day against what the OS already has.</p>
        <TrackerUpload today={manilaToday()} />
      </main>
    </>
  );
}
