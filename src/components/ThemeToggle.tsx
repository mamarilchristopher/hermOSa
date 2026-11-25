"use client";
import { useEffect, useState } from "react";
import { IconMoon, IconSun } from "./Icons";

/**
 * Light / dark switch (v0.48). Remembered on this device in a cookie so the server draws the right colours first.
 * v0.48.1: the side menu shows a two-option "Light | Dark" pill; the phone top bar keeps the small sun/moon icon.
 */
export function ThemeToggle({ variant = "icon" }: { variant?: "icon" | "pill" }) {
  const [dark, setDark] = useState(false);
  useEffect(() => setDark(document.documentElement.dataset.mode === "dark"), []);
  const set = (next: boolean) => {
    setDark(next);
    document.documentElement.dataset.mode = next ? "dark" : "light";
    document.cookie = `mode=${next ? "dark" : "light"}; path=/; max-age=31536000; samesite=lax`;
  };
  if (variant === "pill")
    return (
      <div className="mode-pill" role="group" aria-label="Colour mode">
        <button type="button" className={dark ? undefined : "on"} aria-pressed={!dark} onClick={() => set(false)}><IconSun /> Light</button>
        <button type="button" className={dark ? "on" : undefined} aria-pressed={dark} onClick={() => set(true)}><IconMoon /> Dark</button>
      </div>
    );
  return (
    <button type="button" className="icon-btn" onClick={() => set(!dark)} title={dark ? "Switch to light mode" : "Switch to dark mode"} aria-label={dark ? "Switch to light mode" : "Switch to dark mode"}>
      {dark ? <IconSun /> : <IconMoon />}
    </button>
  );
}
