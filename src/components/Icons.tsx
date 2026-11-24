// Simple line icons (24px grid, 1.8 stroke). Decorative: the label beside each icon carries the meaning.
const base = { width: 20, height: 20, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true };

export const IconChart = () => (<svg {...base}><path d="M4 20V10" /><path d="M10 20V4" /><path d="M16 20v-7" /><path d="M22 20H2" /></svg>);
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
