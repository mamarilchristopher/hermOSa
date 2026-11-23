"use server";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { errorText } from "@/lib/access";
import { parseDetails } from "@/lib/employeeDetails";
import type { DetailsState } from "@/components/DetailsForm";

export async function submitDetails(prev: DetailsState, fd: FormData): Promise<DetailsState> {
  const n = (prev?.n ?? 0) + 1;
  const r = parseDetails(Object.fromEntries(fd.entries()));
  if (!r.ok) return { errors: r.errors, values: r.data, n };
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("submit_employee_details", { p_data: r.data });
  if (error || !data?.ok) return { error: error ? "Could not send. Try again." : errorText(data.error), values: r.data, n };
  revalidatePath("/me/details");
  return { ok: "Sent. The owner will check your details and approve them.", values: r.data, n };
}
