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

export const IconRefresh = () => (
  <svg {...base}>
    <path d="M13 8a5 5 0 1 1-1.5-3.5M13 3v2.5h-2.5" />
  </svg>
);
