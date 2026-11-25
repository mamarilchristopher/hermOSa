import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

/** GIF search for Chat (v0.52). Uses the owner's free GIPHY key (Cloudflare secret GIPHY_API_KEY); signed-in staff only. */
export async function GET(req: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ ok: false, error: "NOT_AUTHENTICATED" }, { status: 401 });
  const key = process.env.GIPHY_API_KEY;
  if (!key) return NextResponse.json({ ok: false, error: "NO_KEY" });
  const q = (new URL(req.url).searchParams.get("q") ?? "").trim().slice(0, 50);
  const api = new URL(`https://api.giphy.com/v1/gifs/${q ? "search" : "trending"}`);
  api.searchParams.set("api_key", key);
  api.searchParams.set("limit", "24");
  api.searchParams.set("rating", "pg");
  if (q) api.searchParams.set("q", q);
  try {
    const res = await fetch(api, { cache: "no-store" });
    if (!res.ok) return NextResponse.json({ ok: false, error: "GIPHY_ERROR" });
    const body = (await res.json()) as { data?: { id: string; title?: string; images?: Record<string, { url?: string; width?: string; height?: string }> }[] };
    const ok = (u?: string) => (u && /^https:\/\/media[0-9]*\.giphy\.com\/[A-Za-z0-9/._-]+$/.test(u.split("?")[0]) ? u.split("?")[0] : null);
    const gifs = (body.data ?? []).map((g) => ({
      id: g.id, title: g.title ?? "GIF",
      preview: ok(g.images?.fixed_width_small?.url) ?? ok(g.images?.fixed_width?.url),
      url: ok(g.images?.fixed_width?.url) ?? ok(g.images?.downsized?.url),
    })).filter((g) => g.preview && g.url);
    return NextResponse.json({ ok: true, gifs });
  } catch {
    return NextResponse.json({ ok: false, error: "GIPHY_ERROR" });
  }
}
