"use client";
/**
 * Chat sounds (v0.49, CHRIS Nov 26): made in the browser (no sound files). On/off is remembered per device.
 * "message" = a soft two-note pop; "management" = a louder rising three-note chime played twice; "sent" = a tiny tick; "mention" = three quick bright notes when you are tagged.
 */
const KEY = "hermosa-chat-sounds";
export const CHAT_SOUNDS_EVENT = "hermosa-chat-sounds";

export function soundsOn(): boolean {
  try { return localStorage.getItem(KEY) !== "off"; } catch { return true; }
}
export function setSoundsOn(on: boolean) {
  try { localStorage.setItem(KEY, on ? "on" : "off"); } catch { /* private mode: stays on for this visit */ }
  window.dispatchEvent(new Event(CHAT_SOUNDS_EVENT));
  if (on) playChatSound("message");
}

let ctx: AudioContext | null = null;
function audio(): AudioContext | null {
  try {
    const A = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!A) return null;
    ctx ??= new A();
    if (ctx.state === "suspended") void ctx.resume();
    return ctx;
  } catch { return null; }
}
// Browsers only allow sound after the person has tapped the page once.
if (typeof window !== "undefined") {
  const unlock = () => { audio(); removeEventListener("pointerdown", unlock); removeEventListener("keydown", unlock); };
  addEventListener("pointerdown", unlock); addEventListener("keydown", unlock);
}

function tone(a: AudioContext, freq: number, start: number, length: number, volume: number, type: OscillatorType = "sine") {
  const o = a.createOscillator(), g = a.createGain();
  o.type = type; o.frequency.value = freq;
  g.gain.setValueAtTime(0.0001, a.currentTime + start);
  g.gain.exponentialRampToValueAtTime(volume, a.currentTime + start + 0.015);
  g.gain.exponentialRampToValueAtTime(0.0001, a.currentTime + start + length);
  o.connect(g).connect(a.destination);
  o.start(a.currentTime + start); o.stop(a.currentTime + start + length + 0.05);
}

export function playChatSound(kind: "message" | "management" | "sent" | "mention") {
  if (!soundsOn()) return;
  const a = audio();
  if (!a) return;
  if (kind === "sent") { tone(a, 1200, 0, 0.08, 0.05); return; }
  if (kind === "mention") { tone(a, 1047, 0, 0.12, 0.22); tone(a, 1319, 0.1, 0.12, 0.22); tone(a, 1568, 0.2, 0.25, 0.24); return; }
  if (kind === "message") { tone(a, 880, 0, 0.14, 0.18); tone(a, 1320, 0.09, 0.2, 0.15); return; }
  for (const r of [0, 0.75]) {
    tone(a, 659, r, 0.3, 0.32, "triangle"); tone(a, 880, r + 0.16, 0.3, 0.32, "triangle"); tone(a, 1175, r + 0.32, 0.45, 0.34, "triangle");
  }
  try { navigator.vibrate?.([200, 100, 200, 100, 300]); } catch { /* not supported */ }
}
