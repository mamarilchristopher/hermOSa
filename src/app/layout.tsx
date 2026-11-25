import type { Metadata, Viewport } from "next";
import { Plus_Jakarta_Sans } from "next/font/google";
import "./globals.css";
import "./themes.css";
import "./dark.css";
import { VERSION } from "@/lib/version";
import { cookies } from "next/headers";

const sans = Plus_Jakarta_Sans({ subsets: ["latin"], variable: "--font-sans", display: "swap" });

export const metadata: Metadata = {
  title: "Hermosa OS",
  description: "Internal operations system for Hermosa Aesthetics",
  robots: { index: false, follow: false },
};
export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: "#faf7f2" };

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Light / dark mode remembered per device (v0.48).
  const mode = (await cookies()).get("mode")?.value === "dark" ? "dark" : "light";
  return (
    <html lang="en" className={sans.variable} data-theme="ivory" data-mode={mode}>
      <body>
        {children}
        <footer className="build-note" title="The code version this page is running">
          Hermosa OS v{VERSION} · {process.env.NEXT_PUBLIC_BUILD_SHA} · updated {process.env.NEXT_PUBLIC_BUILD_TIME} · {process.env.NEXT_PUBLIC_BUILD_HOST}
        </footer>
      </body>
    </html>
  );
}
