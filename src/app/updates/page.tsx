import { redirect } from "next/navigation";
import { can, requireAccess } from "@/lib/access";
import { TopBar } from "@/components/TopBar";
import { UpdatesList } from "./UpdatesList";

/** Updates (CHRIS Nov 26): every Hermosa OS version and what changed, newest first, with Copy buttons for the management chat. */
export default async function UpdatesPage() {
  const { access } = await requireAccess();
  if (!(can(access, ["OWNER"], null) || can(access, ["MANAGER"], null))) redirect("/me");
  return (
    <>
      <TopBar access={access} />
      <UpdatesList />
    </>
  );
}
