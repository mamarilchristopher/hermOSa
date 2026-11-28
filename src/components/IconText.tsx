import type { ReactNode } from "react";
import * as I from "./Icons";

// v0.106.9 (CHRIS Nov 28, soft duotone icons): text that starts with an emoji (signals, badges, to-dos, My day steps) shows
// the matching duotone icon instead. Unknown emoji stay as they are. Client-facing message copy keeps its emoji.
type Ico = (p: { size?: number; className?: string }) => ReactNode;
const MAP: Record<string, Ico> = {
  "💸": I.IconHandCoins, "🎯": I.IconTarget, "📉": I.IconTrendDown, "📈": I.IconTrendUp, "🔥": I.IconFire, "📅": I.IconWeek, "📆": I.IconCalendar,
  "💬": I.IconChat, "📣": I.IconMegaphone, "💳": I.IconCard, "⏰": I.IconAlarm, "☀": I.IconSunrise, "📊": I.IconChartBar, "🛠": I.IconWrench,
  "✨": I.IconSparkle, "🕐": I.IconClockMid, "📞": I.IconPhone, "🧾": I.IconReceipt, "📨": I.IconPaperPlane, "🚀": I.IconRocket, "🌙": I.IconMoon,
  "💰": I.IconCoins, "✅": I.IconCheckCircle, "🏦": I.IconBank, "🎄": I.IconTree, "🔁": I.IconRepeat, "⚠": I.IconWarning, "🔔": I.IconBell,
  "📷": I.IconCamera, "🏆": I.IconTrophy, "🎉": I.IconConfetti, "⭐": I.IconStar, "📵": I.IconPhoneSlash, "📁": I.IconFolder, "📦": I.IconPackage,
  "📄": I.IconFile, "🔒": I.IconLock, "💡": I.IconBulb, "🤝": I.IconHandshake, "🛍": I.IconBag, "🔍": I.IconSearch,
};
const LEAD = /^(\p{Extended_Pictographic})️?\s*/u;

/** The duotone icon for one emoji (falls back to the emoji itself). */
export function EmojiIcon({ e, size, className }: { e: string; size?: number; className?: string }) {
  const Icon = MAP[e.replace(/️/g, "")];
  return Icon ? <Icon size={size} className={className} /> : <span aria-hidden>{e}</span>;
}

/** "💸 Payday" → [hand-coins icon] Payday. */
export function IconText({ text, size }: { text: string; size?: number }) {
  const m = LEAD.exec(text);
  const Icon = m ? MAP[m[1]] : undefined;
  if (!m || !Icon) return <>{text}</>;
  return <><Icon size={size} className="ic-lead" />{text.slice(m[0].length)}</>;
}
