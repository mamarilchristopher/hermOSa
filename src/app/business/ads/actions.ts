"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { parseSourceLines, parseSpendLines, SOURCES, type Source } from "@/lib/ads";

const back = (period: string, q: Record<string, string>) => {
  const p = new URLSearchParams({ ...(period ? { p: period } : {}), ...q });
  return `/business/ads?${p.toString()}#sources`;
};
const periodOf = (fd: FormData) => String(fd.get("period") ?? "").replace(/[^0-9a-z-]/gi, "").slice(0, 10);
const NEEDS_SQL = "The owner needs to run update-0096 in Supabase first.";

/** Owners and the GM: tag where sales came from — per entry (selects) and/or pasted "SL number + source" lines. */
export async function saveSources(fd: FormData) {
  const period = periodOf(fd);
  const rows: ({ log: string; source: Source | null } | { log_no: string; source: Source })[] = [];
  for (const [k, v] of fd.entries()) {
    if (!k.startsWith("src_")) continue;
    const id = k.slice(4), val = String(v);
    if (!/^[0-9a-f-]{36}$/i.test(id) || !val) continue;
    rows.push({ log: id, source: val === "CLEAR" ? null : (SOURCES as string[]).includes(val) ? (val as Source) : null });
  }
  const pasted = parseSourceLines(String(fd.get("lines") ?? "").slice(0, 60_000));
  rows.push(...pasted.rows);
  if (!rows.length) redirect(back(period, pasted.bad.length ? { err: `Couldn't read: ${pasted.bad.slice(0, 3).join(" · ")}` } : { err: "Nothing to save: pick a source or paste SL numbers with a source." }));
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("set_sales_sources", { p_rows: rows.slice(0, 2000) });
  if (error || !data?.ok) redirect(back(period, { err: error?.code === "PGRST202" ? NEEDS_SQL : data?.error === "FORBIDDEN" ? "Only owners and the GM can tag sources." : "Could not save. Try again." }));
  revalidatePath("/business/ads");
  const missing = (data.missing as string[]) ?? [];
  const note = [`${data.saved} saved`, missing.length ? `not found: ${missing.slice(0, 5).join(", ")}${missing.length > 5 ? ` +${missing.length - 5}` : ""}` : "", pasted.bad.length ? `couldn't read ${pasted.bad.length} line${pasted.bad.length === 1 ? "" : "s"}: ${pasted.bad.slice(0, 2).join(" · ")}` : ""].filter(Boolean).join(" · ");
  redirect(back(period, { ok: note }));
}

/** Owners and the GM: add or correct monthly ad spend (pre-VAT pesos) from pasted lines. */
export async function saveSpend(fd: FormData) {
  const period = periodOf(fd);
  const { rows, bad } = parseSpendLines(String(fd.get("spend") ?? "").slice(0, 60_000));
  const to = (q: Record<string, string>) => back(period, q).replace("#sources", "#spend");
  if (bad.length) redirect(to({ err: `Couldn't read: ${bad.slice(0, 3).join(" · ")}` }));
  if (!rows.length) redirect(to({ err: "Paste at least one line." }));
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("save_ad_spend", { p_rows: rows });
  if (error || !data?.ok) redirect(to({ err: error?.code === "PGRST202" ? NEEDS_SQL : data?.error === "FORBIDDEN" ? "Only owners and the GM can add ad spend." : "Could not save. Check the lines and try again." }));
  revalidatePath("/business/ads");
  redirect(to({ ok: `${data.saved} line${data.saved === 1 ? "" : "s"} of ad spend saved` }));
}
