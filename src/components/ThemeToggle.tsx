"use client";
import { useEffect, useState } from "react";
import { IconMoon, IconSun } from "./Icons";

/** Light / dark switch (v0.48). Remembered on this device in a cookie so the server draws the right colours first. */
export function ThemeToggle() {
  const [dark, setDark] = useState(false);
  useEffect(() => setDark(document.documentElement.dataset.mode === "dark"), []);
  const flip = () => {
    const next = !dark;
    setDark(next);
    document.documentElement.dataset.mode = next ? "dark" : "light";
    document.cookie = `mode=${next ? "dark" : "light"}; path=/; max-age=31536000; samesite=lax`;
  };
  return (
    <button type="button" className="icon-btn" onClick={flip} title={dark ? "Switch to light mode" : "Switch to dark mode"} aria-label={dark ? "Switch to light mode" : "Switch to dark mode"}>
      {dark ? <IconSun /> : <IconMoon />}
    </button>
  );
}
