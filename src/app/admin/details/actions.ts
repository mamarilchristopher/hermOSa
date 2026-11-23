"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { errorText } from "@/lib/access";
import { parseDetails } from "@/lib/employeeDetails";
import type { DetailsState } from "@/components/DetailsForm";

const MORE: Record<string, string> = {
  NO_EMPLOYEE_RECORD: "Approve their join request first (Users and roles), then approve these details.",
  NOTE_REQUIRED: "Write what they need to fix.",
};

export async function approveDetails(prev: DetailsState, fd: FormData): Promise<DetailsState> {
  const n = (prev?.n ?? 0) + 1;
  const id = z.uuid().safeParse(fd.get("submission"));
  const name = String(fd.get("full_name") ?? "").trim().replace(/\s+/g, " ");
  const r = parseDetails(Object.fromEntries(fd.entries()));
  if (!id.success) return { error: "Refresh the page and try again.", n };
  if (!r.ok) return { errors: r.errors, values: r.data, n };
  if (name.length < 2 || name.length > 120) return { error: "Type the name to use on the employee record.", values: r.data, n };
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("decide_employee_details", {
    p_submission: id.data, p_approve: true, p_data: r.data, p_full_name: name, p_note: null,
  });
  if (error || !data?.ok) return { error: error ? "Could not save. Try again." : MORE[data.error] ?? errorText(data.error), values: r.data, n };
  revalidatePath("/admin/details");
  redirect("/admin/details?done=1");
}

export async function returnDetails(_prev: { error?: string } | undefined, fd: FormData) {
  const id = z.uuid().safeParse(fd.get("submission"));
  const note = String(fd.get("note") ?? "").trim();
  if (!id.success) return { error: "Refresh the page and try again." };
  if (note.length < 3) return { error: MORE.NOTE_REQUIRED };
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("decide_employee_details", {
    p_submission: id.data, p_approve: false, p_data: null, p_full_name: null, p_note: note,
  });
  if (error || !data?.ok) return { error: error ? "Could not save. Try again." : MORE[data.error] ?? errorText(data.error) };
  revalidatePath("/admin/details");
  redirect("/admin/details?returned=1");
}
