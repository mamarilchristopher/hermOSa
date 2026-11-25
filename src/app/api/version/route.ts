// Which build the server is running. The page compares it with its own build to notice an update (VersionGuard).
export const dynamic = "force-dynamic";
export function GET() {
  return Response.json({ sha: process.env.NEXT_PUBLIC_BUILD_SHA ?? "dev" }, { headers: { "Cache-Control": "no-store" } });
}
