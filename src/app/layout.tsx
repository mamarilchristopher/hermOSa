import type { Metadata, Viewport } from "next";
import { Plus_Jakarta_Sans } from "next/font/google";
import "./globals.css";
import "./themes.css";
import "./dark.css";
import { VERSION } from "@/lib/version";
import { cookies } from "next/headers";
import { RegisterSW } from "@/components/Hermosapp";

const sans = Plus_Jakarta_Sans({ subsets: ["latin"], variable: "--font-sans", display: "swap" });

export const metadata: Metadata = {
  title: "Hermosa OS",
  description: "Internal operations system for Hermosa Aesthetics",
  robots: { index: false, follow: false },
  // Hermosapp (v0.55): installable on Android and iPhone home screens.
  manifest: "/manifest.webmanifest",
  applicationName: "Hermosapp",
  appleWebApp: { capable: true, title: "Hermosapp", statusBarStyle: "default" },
  icons: { icon: "/app-icons/icon-192.png", apple: "/app-icons/apple-touch-icon.png" },
};
export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: "#faf7f2" };

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Light / dark mode remembered per device (v0.48).
  const mode = (await cookies()).get("mode")?.value === "dark" ? "dark" : "light";
  return (
    <html lang="en" className={sans.variable} data-theme="ivory" data-mode={mode}>
      <body>
        {children}
        <RegisterSW />
        <footer className="build-note" title="The code version this page is running">
          Hermosa OS v{VERSION} · {process.env.NEXT_PUBLIC_BUILD_SHA} · updated {process.env.NEXT_PUBLIC_BUILD_TIME} · {process.env.NEXT_PUBLIC_BUILD_HOST}
        </footer>
      </body>
    </html>
  );
}
