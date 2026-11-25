import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { sendPush, type PushSub } from "@/lib/webpush";
import { VAPID_PUBLIC_KEY } from "@/lib/pushConfig";

/** Called by the database (update-0055, pg_net) with a shared secret: encrypt and send one notice to a person's devices. */
export async function POST(req: Request) {
  const secret = process.env.PUSH_SECRET, privateD = process.env.VAPID_PRIVATE_KEY;
  if (!secret || !privateD) return NextResponse.json({ ok: false, error: "NOT_CONFIGURED" }, { status: 503 });
  const given = req.headers.get("x-push-secret") ?? "";
  // Constant-time compare.
  let diff = given.length ^ secret.length;
  for (let i = 0; i < Math.max(given.length, secret.length); i++) diff |= (given.charCodeAt(i) || 0) ^ (secret.charCodeAt(i) || 0);
  if (diff !== 0) return NextResponse.json({ ok: false }, { status: 403 });
  let body: { subs?: PushSub[]; title?: string; body?: string; url?: string; tag?: string | null };
  try { body = await req.json(); } catch { return NextResponse.json({ ok: false }, { status: 400 }); }
  const subs = (body.subs ?? []).filter((s) => /^https:\/\//.test(s.endpoint ?? "")).slice(0, 200);
  const url = typeof body.url === "string" && body.url.startsWith("/") ? body.url : "/me";
  const data = { title: String(body.title ?? "Hermosapp").slice(0, 120), body: String(body.body ?? "").slice(0, 240), url, tag: body.tag ?? undefined };
  const vapid = { publicKey: VAPID_PUBLIC_KEY, privateD, subject: "https://hermosaos.com" };
  const gone: string[] = [];
  await Promise.all(subs.map(async (s) => {
    try { const st = await sendPush(s, data, vapid); if (st === 404 || st === 410) gone.push(s.endpoint); } catch { /* one bad device never stops the rest */ }
  }));
  if (gone.length) {
    const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, { auth: { persistSession: false } });
    await sb.rpc("push_gone", { p_secret: secret, p_endpoints: gone });
  }
  return NextResponse.json({ ok: true, sent: subs.length - gone.length, gone: gone.length });
}
