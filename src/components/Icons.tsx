// Simple line icons (24px grid, 1.8 stroke). Decorative: the label beside each icon carries the meaning.
const base = { width: 20, height: 20, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true };

export const IconChart = () => (<svg {...base}><path d="M4 20V10" /><path d="M10 20V4" /><path d="M16 20v-7" /><path d="M22 20H2" /></svg>);
export const IconBriefcase = () => (<svg {...base}><rect x="3" y="7" width="18" height="13" rx="2.5" /><path d="M9 7V5.5A1.5 1.5 0 0 1 10.5 4h3A1.5 1.5 0 0 1 15 5.5V7" /><path d="M3 12.5h18" /><path d="M12 11.5v2" /></svg>);
export const IconCalendar = () => (<svg {...base}><rect x="3" y="5" width="18" height="16" rx="3" /><path d="M8 3v4M16 3v4M3 10h18" /><path d="m10 14 4 4M14 14l-4 4" /></svg>);
export const IconUpload = () => (<svg {...base}><path d="M12 15V4" /><path d="m7 9 5-5 5 5" /><path d="M4 15v3a3 3 0 0 0 3 3h10a3 3 0 0 0 3-3v-3" /></svg>);
export const IconUsers = () => (<svg {...base}><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20a6.5 6.5 0 0 1 13 0" /><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18 14a6 6 0 0 1 3.5 6" /></svg>);
export const IconLogout = () => (<svg {...base}><path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3" /><path d="m10 16-4-4 4-4" /><path d="M6 12h10" /></svg>);
export const IconShield = () => (<svg {...base} width={14} height={14}><path d="M12 3 5 6v6c0 4 3 7 7 9 4-2 7-5 7-9V6z" /><path d="m9 12 2 2 4-4" /></svg>);
export const IconClipboard = () => (<svg {...base}><rect x="5" y="4" width="14" height="17" rx="2.5" /><path d="M9 4.5V3h6v1.5" /><path d="M9 11h6M9 15h4" /></svg>);
export const IconPeople = () => (<svg {...base}><circle cx="12" cy="8" r="3.5" /><path d="M5 20a7 7 0 0 1 14 0" /></svg>);
export const IconCoins = () => (<svg {...base}><ellipse cx="12" cy="6.5" rx="7" ry="3" /><path d="M5 6.5v5c0 1.7 3.1 3 7 3s7-1.3 7-3v-5" /><path d="M5 11.5v5c0 1.7 3.1 3 7 3s7-1.3 7-3v-5" /></svg>);
export const IconHome = () => (<svg {...base}><path d="M3.5 10.5 12 4l8.5 6.5" /><path d="M5.5 9v10.5h13V9" /><path d="M10 19.5v-5h4v5" /></svg>);
export const IconPen = () => (<svg {...base}><path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16v4Z" /><path d="m13.5 6.5 4 4" /><path d="M14 20h6" /></svg>);
export const IconIdCard = () => (<svg {...base}><rect x="3" y="5" width="18" height="14" rx="2.5" /><circle cx="9" cy="11" r="2.2" /><path d="M5.8 16c.6-1.6 1.8-2.4 3.2-2.4s2.6.8 3.2 2.4" /><path d="M14.5 10h4M14.5 13.5h3" /></svg>);
export const IconWeek = () => (<svg {...base}><rect x="3" y="5" width="18" height="16" rx="3" /><path d="M8 3v4M16 3v4M3 10h18" /><path d="M7 14h2M11 14h2M15 14h2M7 17.5h2M11 17.5h2" /></svg>);
export const IconClock = () => (<svg {...base}><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>);
export const IconBell = () => (<svg {...base}><path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z" /><path d="M10 20.5a2 2 0 0 0 4 0" /></svg>);
export const IconMore = () => (<svg {...base}><circle cx="5" cy="12" r="1.6" /><circle cx="12" cy="12" r="1.6" /><circle cx="19" cy="12" r="1.6" /></svg>);
export const IconSettings = () => (<svg {...base}><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" /></svg>);
export const IconSun = () => (<svg {...base}><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></svg>);
export const IconMoon = () => (<svg {...base}><path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z" /></svg>);
// Team chat (v0.49).
export const IconChat = () => (<svg {...base}><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v8a2.5 2.5 0 0 1-2.5 2.5H10l-4.5 4v-4h0A1.5 1.5 0 0 1 4 14.5z" /><path d="M8 8.5h8M8 12h5" /></svg>);
export const IconImage = () => (<svg {...base}><rect x="3" y="4" width="18" height="16" rx="3" /><circle cx="9" cy="10" r="1.8" /><path d="m4 18 5-5 4 4 3-3 4 4" /></svg>);
export const IconSend = () => (<svg {...base}><path d="M4 12 20 4l-6 16-3-7z" /><path d="m11 13 9-9" /></svg>);
export const IconPlus = () => (<svg {...base}><path d="M12 5v14M5 12h14" /></svg>);
export const IconBack = () => (<svg {...base}><path d="m14 6-6 6 6 6" /></svg>);
export const IconInfo = () => (<svg {...base}><circle cx="12" cy="12" r="9" /><path d="M12 11v5" /><path d="M12 7.5h.01" /></svg>);
