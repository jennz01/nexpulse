import type { ReactNode } from 'react';

interface P { size?: number }
const Svg = ({ size = 16, children, fill = 'none' }: P & { children: ReactNode; fill?: string }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill={fill} stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {children}
  </svg>
);

export const IconLogo = ({ size = 22 }: P) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="3" y="3" width="8" height="8" rx="1.5" /><rect x="13" y="3" width="8" height="5" rx="1.5" /><rect x="13" y="11" width="8" height="10" rx="1.5" /><rect x="3" y="14" width="8" height="7" rx="1.5" />
  </svg>
);
export const IconRefresh = (p: P) => <Svg {...p}><path d="M21 12a9 9 0 1 1-2.64-6.36" /><path d="M21 3v6h-6" /></Svg>;
export const IconSettings = (p: P) => (
  <Svg {...p}><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" /></Svg>
);
export const IconExternal = (p: P) => <Svg {...p}><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" /><path d="M15 3h6v6" /><path d="M10 14 21 3" /></Svg>;
export const IconPlay = (p: P) => <Svg {...p} fill="currentColor"><path d="M7 4v16l13-8z" stroke="none" /></Svg>;
export const IconDownload = (p: P) => <Svg {...p}><path d="M12 3v12" /><path d="m7 10 5 5 5-5" /><path d="M5 21h14" /></Svg>;
export const IconChevronRight = (p: P) => <Svg {...p}><path d="m9 6 6 6-6 6" /></Svg>;
export const IconChevronDown = (p: P) => <Svg {...p}><path d="m6 9 6 6 6-6" /></Svg>;
export const IconClose = (p: P) => <Svg {...p}><path d="M18 6 6 18" /><path d="m6 6 12 12" /></Svg>;
export const IconCheck = (p: P) => <Svg {...p}><path d="m5 12 5 5L20 7" /></Svg>;
export const IconChevronLeft = (p: P) => <Svg {...p}><path d="m15 6-6 6 6 6" /></Svg>;
export const IconHome = (p: P) => <Svg {...p}><path d="m3 11 9-8 9 8" /><path d="M5 10v10h14V10" /><path d="M10 20v-6h4v6" /></Svg>;
export const IconBuilds = (p: P) => <Svg {...p}><path d="m21 8-9-5-9 5v8l9 5 9-5z" /><path d="m3 8 9 5 9-5" /><path d="M12 13v8" /></Svg>;
export const IconReleases = (p: P) => <Svg {...p}><path d='M12 2c3 2.5 4.5 6 4.5 10L12 16l-4.5-4C7.5 8 9 4.5 12 2z' /><circle cx='12' cy='9' r='2' /><path d='M7.5 14 5 20l4-1.5' /><path d='M16.5 14 19 20l-4-1.5' /></Svg>;
export const IconStores = (p: P) => <Svg {...p}><rect x="6" y="2" width="12" height="20" rx="2" /><path d="M11 18h2" /></Svg>;
export const IconSliders = (p: P) => <Svg {...p}><path d="M4 21v-7" /><path d="M4 10V3" /><path d="M12 21v-9" /><path d="M12 8V3" /><path d="M20 21v-5" /><path d="M20 12V3" /><path d="M1 14h6" /><path d="M9 8h6" /><path d="M17 16h6" /></Svg>;
export const IconGrip = (p: P) => (
  <Svg {...p} fill="currentColor"><g stroke="none"><circle cx="9" cy="6" r="1.7" /><circle cx="15" cy="6" r="1.7" /><circle cx="9" cy="12" r="1.7" /><circle cx="15" cy="12" r="1.7" /><circle cx="9" cy="18" r="1.7" /><circle cx="15" cy="18" r="1.7" /></g></Svg>
);
export const IconPalette = (p: P) => (
  <Svg {...p}><path d="M12 3a9 9 0 1 0 0 18h1a2 2 0 0 0 2-2v-1a2 2 0 0 1 2-2h1a3 3 0 0 0 3-3 9 9 0 0 0-9-10z" /><circle cx="7.5" cy="11.5" r="1" fill="currentColor" /><circle cx="11" cy="7.5" r="1" fill="currentColor" /><circle cx="16" cy="8.5" r="1" fill="currentColor" /></Svg>
);
export const IconEyeOff = (p: P) => (
  <Svg {...p}><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94" /><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" /><path d="m1 1 22 22" /></Svg>
);
export const IconResize = (p: P) => <Svg {...p}><path d="M21 11 11 21" /><path d="m21 17-4 4" /></Svg>;
export const IconPlus = (p: P) => <Svg {...p}><path d="M12 5v14" /><path d="M5 12h14" /></Svg>;
export const IconReset = (p: P) => <Svg {...p}><path d="M3 12a9 9 0 1 0 2.64-6.36" /><path d="M3 3v6h6" /></Svg>;
export const IconStore = (p: P) => <Svg {...p}><path d="M3 9.5 5 3h14l2 6.5" /><path d="M3 9.5a3 3 0 0 0 6 0 3 3 0 0 0 6 0 3 3 0 0 0 6 0" /><path d="M5 12v9h14v-9" /><path d="M9 21v-6h6v6" /></Svg>;
export const IconUser = (p: P) => <Svg {...p}><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></Svg>;
export const IconPaperclip = (p: P) => <Svg {...p}><path d="m21.4 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l9.2-9.19a4 4 0 0 1 5.65 5.66l-9.2 9.19a2 2 0 0 1-2.82-2.83l8.49-8.48" /></Svg>;
export const IconFile = (p: P) => <Svg {...p}><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" /><path d="M14 3v6h6" /></Svg>;
export const IconAlert = (p: P) => <Svg {...p}><path d="m10.3 3.9-8.5 14.7A2 2 0 0 0 3.5 21.6h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" /><path d="M12 9v4" /><path d="M12 17h.01" /></Svg>;
export const IconCopy = (p: P) => <Svg {...p}><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></Svg>;
export const IconZoomIn = (p: P) => <Svg {...p}><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /><path d="M11 8v6" /><path d="M8 11h6" /></Svg>;
export const IconZoomOut = (p: P) => <Svg {...p}><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /><path d="M8 11h6" /></Svg>;
export const IconMaximize = (p: P) => <Svg {...p}><path d="M8 3H5a2 2 0 0 0-2 2v3" /><path d="M21 8V5a2 2 0 0 0-2-2h-3" /><path d="M3 16v3a2 2 0 0 0 2 2h3" /><path d="M16 21h3a2 2 0 0 0 2-2v-3" /></Svg>;
