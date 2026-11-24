import type { NextConfig } from "next";
import { execSync } from "node:child_process";

/** Which code this build is, shown in the footer so you can tell when a deploy is live. */
function buildInfo() {
  let sha = process.env.WORKERS_CI_COMMIT_SHA || process.env.VERCEL_GIT_COMMIT_SHA || "";
  if (!sha) { try { sha = execSync("git rev-parse HEAD", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim(); } catch { sha = ""; } }
  const host = process.env.WORKERS_CI ? "Cloudflare" : process.env.VERCEL ? "Vercel" : "local";
  const time = new Date().toLocaleString("en-PH", { timeZone: "Asia/Manila", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  return { NEXT_PUBLIC_BUILD_SHA: sha.slice(0, 7) || "dev", NEXT_PUBLIC_BUILD_TIME: time, NEXT_PUBLIC_BUILD_HOST: host };
}

const securityHeaders = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(self)" },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  env: buildInfo(),
  experimental: { serverActions: { bodySizeLimit: "5mb" } },
  async headers() {
    return [
      { source: "/:path*", headers: securityHeaders },
      // Signed-in pages may hold patient or finance data: never cache them anywhere.
      { source: "/((?!_next/static|hermosa-logo.png).*)", headers: [{ key: "Cache-Control", value: "no-store" }] },
    ];
  },
};

export default nextConfig;
