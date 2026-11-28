import { NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { can, type Access } from "@/lib/access";
import { manilaToday } from "@/lib/dates";
import { DOC_TYPES, PAID_VIA, markDuplicates, normalizeScan, scanSystem, scanUser, type RawScan, type ScanBranch, type ScanCat } from "@/lib/receiptScan";

/**
 * Expenses › Scan receipt (v0.100.1, CHRIS Nov 28): reads one receipt photo, bill, payment screenshot, voucher or handwritten
 * expense list and returns the lines to record, a suggested branch and possible duplicates. Nothing is saved here: the person
 * checks the filled form, picks the branch and saves. Owners, the GM and Finance only. Needs the Cloudflare secret ANTHROPIC_API_KEY.
 */
const IMAGE = ["image/jpeg", "image/png", "image/webp", "image/gif"] as const;
const json = (body: Record<string, unknown>, status = 200) => NextResponse.json(body, { status });

export async function POST(req: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return json({ ok: false, error: "NOT_AUTHENTICATED" }, 401);
  const [{ data: acc }, { data: pin }] = await Promise.all([supabase.rpc("my_access"), supabase.rpc("my_pin_status")]);
  const access = acc as Access | null;
  const management = !!access?.grants.some((g) => g.branch_id === null && (g.role === "OWNER" || g.role === "MANAGER"));
  if (!access || (pin?.has_pin && !pin.verified) || (access.needs_mfa && !access.mfa) || !(management || can(access, ["FINANCE"], null))) {
    return json({ ok: false, error: "FORBIDDEN" }, 403);
  }
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return json({ ok: false, error: "NO_KEY" });

  const fd = await req.formData().catch(() => null);
  const file = fd?.get("file");
  if (!(file instanceof Blob) || file.size < 100) return json({ ok: false, error: "NO_FILE" }, 400);
  const type = file.type;
  const pdf = type === "application/pdf";
  if (!pdf && !(IMAGE as readonly string[]).includes(type)) return json({ ok: false, error: "BAD_TYPE" });
  if (file.size > (pdf ? 20 : 5) * 1024 * 1024) return json({ ok: false, error: "TOO_BIG" });
  const name = String(fd?.get("name") ?? (pdf ? "receipt.pdf" : "receipt.jpg")).slice(0, 120);

  const [{ data: catRows }, { data: branchRows }] = await Promise.all([
    supabase.from("expense_categories").select("id, name, grp, kind, active").order("sort"),
    supabase.from("branches").select("id, code, name, kind, active").order("name"),
  ]);
  const cats = ((catRows ?? []) as (ScanCat & { kind: string; active: boolean })[]).filter((c) => c.kind !== "AUTO" && c.active);
  const branches = ((branchRows ?? []) as (ScanBranch & { kind: string; active: boolean })[]).filter((b) => b.kind === "CLINIC" && b.active !== false);
  if (!cats.length) return json({ ok: false, error: "NEEDS_SQL" });

  const ids = (l: string[]) => z.enum(l as [string, ...string[]]);
  const Schema = z.object({
    doc_type: z.enum(DOC_TYPES),
    payee: z.string().nullable(),
    paid_via: z.enum(PAID_VIA).nullable(),
    branch_code: (branches.length ? ids(branches.map((b) => b.code)) : z.string()).nullable(),
    branch_reason: z.string().nullable(),
    note: z.string(),
    items: z.array(z.object({
      date: z.string().nullable(), amount: z.number(), description: z.string(), category_id: ids(cats.map((c) => c.id)).nullable(), unsure: z.boolean(),
    })),
  });

  const today = manilaToday();
  const data = Buffer.from(await file.arrayBuffer()).toString("base64");
  const source: Anthropic.Beta.Messages.BetaContentBlockParam = pdf
    ? { type: "document", source: { type: "base64", media_type: "application/pdf", data } }
    : { type: "image", source: { type: "base64", media_type: type as (typeof IMAGE)[number], data } };
  const client = new Anthropic({ apiKey: key, timeout: 120_000, maxRetries: 1 });
  let raw: RawScan | null = null;
  try {
    const res = await client.beta.messages.parse({
      // v0.102.3 (CHRIS Nov 28: Opus "a bit costly for scan feature"): the small model, about ₱0.10 a scan; every scan is
      // checked by a person before it's saved.
      model: "claude-haiku-5-5",
      max_tokens: 16000,
      output_config: { effort: "medium", format: betaZodOutputFormat(Schema) },
      system: scanSystem(cats, branches),
      messages: [{ role: "user", content: [source, { type: "text", text: scanUser(today, name) }] }],
    });
    if (res.stop_reason === "refusal" || res.stop_reason === "max_tokens") return json({ ok: false, error: "NOT_READ" });
    raw = (res.parsed_output ?? null) as RawScan | null;
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) return json({ ok: false, error: "BAD_KEY" });
    if (e instanceof Anthropic.RateLimitError) return json({ ok: false, error: "BUSY" });
    if (e instanceof Anthropic.BadRequestError) return json({ ok: false, error: "NOT_READ" });
    return json({ ok: false, error: "FAILED" });
  }
  if (!raw) return json({ ok: false, error: "NOT_READ" });

  const scan = normalizeScan(raw, { cats, branches, today });
  if (scan.items.length) {
    const from = new Date(Date.parse(`${scan.items.reduce((m, x) => (x.spent_on && x.spent_on < m ? x.spent_on : m), today)}T00:00:00Z`) - 40 * 86400000).toISOString().slice(0, 10);
    const { data: prior } = await supabase.from("expenses").select("amount_cents, spent_on, description")
      .is("voided_at", null).gte("spent_on", from).in("amount_cents", [...new Set(scan.items.map((x) => x.amount_cents))]).limit(200);
    scan.items = markDuplicates(scan.items, (prior ?? []) as { amount_cents: number; spent_on: string; description: string }[], today);
  }
  return json({ ok: true, scan });
}
