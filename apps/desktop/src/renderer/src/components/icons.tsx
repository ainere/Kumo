const base = {
  width: 16,
  height: 16,
  viewBox: "0 0 16 16",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.5,
  strokeLinecap: "round",
  strokeLinejoin: "round",
  "aria-hidden": true,
} as const;

export const IconPlus = () => (
  <svg {...base}>
    <path d="M8 3v10M3 8h10" />
  </svg>
);

export const IconFolder = () => (
  <svg {...base}>
    <path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h3L8 4.5h4.5A1.5 1.5 0 0 1 14 6v5.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5z" />
  </svg>
);

export const IconArrowUp = () => (
  <svg {...base}>
    <path d="M8 13V3M4 7l4-4 4 4" />
  </svg>
);

export const IconStop = () => (
  <svg {...base}>
    <rect x="4" y="4" width="8" height="8" rx="1.5" fill="currentColor" stroke="none" />
  </svg>
);

export const IconSliders = () => (
  <svg {...base}>
    <path d="M2.5 4.5h7M12.5 4.5h1M2.5 11.5h1M6.5 11.5h7M11 3v3M5 10v3" />
  </svg>
);

export const IconClose = () => (
  <svg {...base}>
    <path d="M4 4l8 8M12 4l-8 8" />
  </svg>
);

export const IconSearch = () => (
  <svg {...base}>
    <circle cx="7" cy="7" r="4.25" />
    <path d="M10.25 10.25L13.5 13.5" />
  </svg>
);

export const IconPanelRight = () => (
  <svg {...base}>
    <rect x="2.25" y="3" width="11.5" height="10" rx="1.75" />
    <path d="M9.75 3v10" />
  </svg>
);

export const IconSplit = () => (
  <svg {...base}>
    <rect x="2.25" y="3" width="11.5" height="10" rx="1.75" />
    <path d="M2.25 8h11.5" />
  </svg>
);

export const IconPopOut = () => (
  <svg {...base}>
    <path d="M9 3h4v4M13 3L7.5 8.5M6.5 3.5h-2A1.5 1.5 0 0 0 3 5v6.5A1.5 1.5 0 0 0 4.5 13H11a1.5 1.5 0 0 0 1.5-1.5v-2" />
  </svg>
);

export const IconArrowRight = () => (
  <svg {...base}>
    <path d="M3 8h10M9 4l4 4-4 4" />
  </svg>
);

export const IconRefresh = () => (
  <svg {...base}>
    <path d="M13 8a5 5 0 1 1-1.5-3.5M13 3v2.5h-2.5" />
  </svg>
);

export const IconChevronRight = ({ className }: { className?: string }) => (
  <svg {...base} className={className} width={12} height={12} viewBox="0 0 16 16">
    <path d="M6 3.5l4.5 4.5-4.5 4.5" />
  </svg>
);

export const IconChevronDown = ({ className }: { className?: string }) => (
  <svg {...base} className={className} width={12} height={12} viewBox="0 0 16 16">
    <path d="M3.5 6l4.5 4.5 4.5-4.5" />
  </svg>
);

export const IconArrowLeft = () => (
  <svg {...base}>
    <path d="M13 8H3M7 4L3 8l4 4" />
  </svg>
);

/** Settings: a six-tooth gear. */
export const IconGear = () => (
  <svg {...base}>
    <path d="M6.3 3.57L6.48 1.42L9.52 1.42L9.7 3.57A4.75 4.75 0 0 1 10.99 4.31L12.94 3.4L14.46 6.03L12.69 7.26A4.75 4.75 0 0 1 12.69 8.74L14.46 9.97L12.94 12.6L10.99 11.69A4.75 4.75 0 0 1 9.7 12.43L9.52 14.58L6.48 14.58L6.3 12.43A4.75 4.75 0 0 1 5.01 11.69L3.06 12.6L1.54 9.97L3.31 8.74A4.75 4.75 0 0 1 3.31 7.26L1.54 6.03L3.06 3.4L5.01 4.31A4.75 4.75 0 0 1 6.3 3.57Z" />
    <circle cx="8" cy="8" r="2" />
  </svg>
);

export const IconSun = () => (
  <svg {...base}>
    <circle cx="8" cy="8" r="3.2" />
    <path d="M8 1.5v1.5M8 13v1.5M1.5 8H3M13 8h1.5M3.4 3.4l1.1 1.1M11.5 11.5l1.1 1.1M3.4 12.6l1.1-1.1M11.5 4.5l1.1-1.1" />
  </svg>
);

export const IconMoon = () => (
  <svg {...base}>
    <path d="M13.2 9.2A5.5 5.5 0 1 1 6.8 2.8a4.3 4.3 0 0 0 6.4 6.4z" />
  </svg>
);

export const IconUser = () => (
  <svg {...base}>
    <circle cx="8" cy="5.5" r="2.5" />
    <path d="M3 13.5c0-2.5 2.2-4 5-4s5 1.5 5 4" />
  </svg>
);

export const IconUsers = () => (
  <svg {...base}>
    <circle cx="6" cy="5.75" r="2.25" />
    <path d="M1.75 13.25c0-2.2 1.9-3.5 4.25-3.5s4.25 1.3 4.25 3.5" />
    <path d="M10.25 3.75a2 2 0 1 1 0 4M12 9.9c1.4.4 2.25 1.5 2.25 3.1" />
  </svg>
);

/** Models: a cube. */
export const IconCube = () => (
  <svg {...base}>
    <path d="M8 1.75l5.5 3v6.5l-5.5 3-5.5-3v-6.5z" />
    <path d="M2.5 4.75L8 7.75l5.5-3M8 7.75v6.5" />
  </svg>
);

/** Appearance: half light, half dark. */
export const IconContrast = () => (
  <svg {...base}>
    <circle cx="8" cy="8" r="5.75" />
    <path d="M8 2.25a5.75 5.75 0 0 1 0 11.5z" fill="currentColor" stroke="none" />
  </svg>
);

/** Doctor: a pulse line. */
export const IconPulse = () => (
  <svg {...base}>
    <path d="M1.5 8.5h3l1.5-4 3 7 1.5-3h4" />
  </svg>
);

export const IconCheck = () => (
  <svg {...base}>
    <path d="M3.5 8.5l3 3 6-7" />
  </svg>
);

export const IconShield = ({ className }: { className?: string }) => (
  <svg {...base} className={className}>
    <path d="M8 1.75L2.75 4v4.5c0 3.75 2.75 6 5.25 6.75 2.5-.75 5.25-3 5.25-6.75V4z" />
  </svg>
);

export const IconShieldReview = ({ className }: { className?: string }) => (
  <svg {...base} className={className}>
    <path d="M8 1.75L2.75 4v4.5c0 3.75 2.75 6 5.25 6.75 2.5-.75 5.25-3 5.25-6.75V4z" />
    <circle cx="8" cy="8.25" r="1.5" />
  </svg>
);

export const IconShieldLock = ({ className }: { className?: string }) => (
  <svg {...base} className={className}>
    <path d="M8 1.75L2.75 4v4.5c0 3.75 2.75 6 5.25 6.75 2.5-.75 5.25-3 5.25-6.75V4z" />
    <rect x="6.25" y="7.5" width="3.5" height="3" rx="0.75" />
    <path d="M7 7.5V6.5a1 1 0 0 1 2 0v1" />
  </svg>
);

export const IconShieldAuto = ({ className }: { className?: string }) => (
  <svg {...base} className={className}>
    <path d="M8 1.75L2.75 4v4.5c0 3.75 2.75 6 5.25 6.75 2.5-.75 5.25-3 5.25-6.75V4z" />
    <path d="M8 6.5v4M6 8.5h4" />
  </svg>
);

export const IconShieldTurbo = ({ className }: { className?: string }) => (
  <svg {...base} className={className}>
    <path d="M8 1.75L2.75 4v4.5c0 3.75 2.75 6 5.25 6.75 2.5-.75 5.25-3 5.25-6.75V4z" />
    <path d="M8 5.75v3.5M8 11.25h.01" />
  </svg>
);

/** A safety mode's shield (SAFETY_MODE_OPTIONS' iconType). */
export function SafetyIcon({ type, className }: { type: "review" | "copilot" | "autopilot"; className?: string }) {
  switch (type) {
    case "review":
      return <IconShieldReview className={className} />;
    case "copilot":
      return <IconShieldLock className={className} />;
    case "autopilot":
    default:
      return <IconShieldTurbo className={className} />;
  }
}

export const IconMore = ({ className }: { className?: string }) => (
  <svg {...base} className={className} width={14} height={14}>
    <circle cx="3.5" cy="8" r="1" fill="currentColor" stroke="none" />
    <circle cx="8" cy="8" r="1" fill="currentColor" stroke="none" />
    <circle cx="12.5" cy="8" r="1" fill="currentColor" stroke="none" />
  </svg>
);

export const IconPencil = ({ className }: { className?: string }) => (
  <svg {...base} className={className} width={13} height={13}>
    <path d="M11 2.5l2.5 2.5L5 13.5H2.5V11z" />
  </svg>
);

export const IconTrash = ({ className }: { className?: string }) => (
  <svg {...base} className={className} width={13} height={13}>
    <path d="M2.5 4.5h11M5.5 4.5V3a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v1.5M4 4.5v8a1.5 1.5 0 0 0 1.5 1.5h5a1.5 1.5 0 0 0 1.5-1.5v-8" />
  </svg>
);

export const IconGrip = ({ className }: { className?: string }) => (
  <svg {...base} className={className} width={10} height={14} viewBox="0 0 10 16">
    <circle cx="3" cy="4" r="1" fill="currentColor" stroke="none" />
    <circle cx="7" cy="4" r="1" fill="currentColor" stroke="none" />
    <circle cx="3" cy="8" r="1" fill="currentColor" stroke="none" />
    <circle cx="7" cy="8" r="1" fill="currentColor" stroke="none" />
    <circle cx="3" cy="12" r="1" fill="currentColor" stroke="none" />
    <circle cx="7" cy="12" r="1" fill="currentColor" stroke="none" />
  </svg>
);

export const IconCollapseAll = ({ className }: { className?: string }) => (
  <svg {...base} className={className} width={14} height={14}>
    <path d="M2.5 5.5l5.5-3 5.5 3M2.5 10.5l5.5 3 5.5-3" />
  </svg>
);

export const IconCopy = ({ className }: { className?: string }) => (
  <svg {...base} className={className} width={14} height={14}>
    <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
    <path d="M2.5 10.5V3.5a1 1 0 0 1 1-1h7" />
  </svg>
);
