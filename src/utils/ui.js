/**
 * ui.js — Formal terminal styling utilities, ANSI color coding,
 * cloud cumulus kanji banner design, and live rate limit formatters for KUMO.
 */

// ANSI Color and Style Codes
export const c = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  italic: "\x1b[3m",
  underline: "\x1b[4m",

  // Foreground colors
  black: "\x1b[30m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  white: "\x1b[37m",
  gray: "\x1b[90m",

  // Bright foreground colors
  brightCyan: "\x1b[96m",
  brightGreen: "\x1b[92m",
  brightYellow: "\x1b[93m",
  brightRed: "\x1b[91m",
  brightBlue: "\x1b[94m",
  brightMagenta: "\x1b[95m",
  brightWhite: "\x1b[97m",

  // Vibrant blueish gradient tones (no dark navy)
  skyBlue: "\x1b[38;5;75m",
  periwinkle: "\x1b[38;5;111m",
  electricCyan: "\x1b[38;5;51m",
};

export const DEFAULT_SUBTITLE = "Frontier Reasoning ◄───[MCP]───► High-Speed Execution";

/**
 * Signature blueish gradient steps matching Cloud Cumulus theme (electric cyan -> sky blue -> bright blue).
 */
export const BLUEISH_GRADIENT = [
  "\x1b[38;5;51m",  // vibrant electric cyan
  "\x1b[38;5;45m",
  "\x1b[38;5;39m",  // sky blue
  "\x1b[38;5;75m",  // soft bright blue
  "\x1b[38;5;111m", // periwinkle
  "\x1b[94m",       // bright blue
];

/**
 * Cloud banner design implementation.
 * Refined Cloud Cumulus with KUMO (雲) title badge.
 */
export const BANNER_DESIGNS = {
  cloud: {
    name: "Cloud Cumulus (雲)",
    description: "Atmospheric cloud cumulus cluster with KUMO (雲) title badge",
    render: (v = "1.0.0", sub = DEFAULT_SUBTITLE) => {
      const l1 = `${c.brightCyan}         .---.                    ${c.reset}`;
      const l2 = `${c.brightCyan}      .-(     ).    ${c.cyan}.---.         ${c.reset}  ${c.bold}${c.white}KUMO${c.reset} ${c.brightCyan}(雲)${c.reset} ${c.gray}v${v}${c.reset}`;
      const l3 = `${c.cyan}    .(          ).-(     ).       ${c.reset}  ${c.gray}Cross-Provider AI Orchestrator${c.reset}`;
      const l4 = `${c.brightBlue}   (____.__.__.____)(____)        ${c.reset}  ${c.skyBlue}${sub}${c.reset}`;
      return `${l1}\n${l2}\n${l3}\n${l4}`;
    },
  },
};

/**
 * Get configured or default banner string.
 */
export function getBanner(version = "1.0.0", style = "cloud", subtitle = DEFAULT_SUBTITLE) {
  const design = BANNER_DESIGNS[style] || BANNER_DESIGNS.cloud;
  return design.render(version, subtitle);
}

/**
 * Status badges for operational messages.
 */
export const badge = {
  ok: `${c.brightGreen}[OK]${c.reset}`,
  fail: `${c.brightRed}[FAIL]${c.reset}`,
  warn: `${c.brightYellow}[WARN]${c.reset}`,
  info: `${c.brightCyan}[INFO]${c.reset}`,
  dot: `${c.skyBlue}•${c.reset}`,
  arrow: `${c.brightCyan}→${c.reset}`,
};

/**
 * Horizontal separator line with luminous cyan-to-blue gradient (no dark navy)
 */
export function separator(length = 64) {
  const steps = [c.brightCyan, c.cyan, c.brightBlue, c.skyBlue, c.periwinkle];
  let res = "";
  for (let i = 0; i < length; i++) {
    const idx = Math.floor((i / length) * steps.length);
    res += steps[idx] + "─";
  }
  return res + c.reset;
}

/**
 * Render a visual ASCII progress bar for remaining percentages (0 - 100).
 * Always standardizes to 14 blocks for consistent alignment across all quotas.
 * Uses the signature blueish gradient (cyan to bright blue) for filled blocks.
 */
export function progressBar(percent = 100, width = 14) {
  const clamped = Math.max(0, Math.min(100, Math.round(percent)));
  const filled = Math.round((clamped / 100) * width);
  const empty = width - filled;

  let bar = "";
  for (let i = 0; i < filled; i++) {
    const color = BLUEISH_GRADIENT[Math.floor((i / width) * BLUEISH_GRADIENT.length)] || c.brightCyan;
    bar += `${color}█`;
  }
  bar += `${c.gray}${"░".repeat(empty)}${c.reset}`;
  return `${bar} ${c.brightCyan}${clamped}%${c.reset}`;
}

/**
 * Format relative countdown and human-readable time from a Unix timestamp (seconds).
 */
export function formatResetTime(resetsAtSeconds) {
  if (!resetsAtSeconds) return "N/A";
  const nowSec = Math.floor(Date.now() / 1000);
  const diffSec = resetsAtSeconds - nowSec;

  const dateStr = new Date(resetsAtSeconds * 1000).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

  if (diffSec <= 0) {
    return `Reset due now (${dateStr})`;
  }

  const days = Math.floor(diffSec / 86400);
  const hours = Math.floor((diffSec % 86400) / 3600);
  const minutes = Math.floor((diffSec % 3600) / 60);

  let countdown = "";
  if (days > 0) {
    countdown = `${days}d ${hours}h`;
  } else if (hours > 0) {
    countdown = `${hours}h ${minutes}m`;
  } else {
    countdown = `${minutes}m`;
  }

  return `in ${countdown} (${dateStr})`;
}

/**
 * Format relative countdown from an ISO 8601 string (e.g. 2026-09-16T19:53:54Z).
 * Shows both exact calendar date/time and relative countdown.
 */
export function formatIsoResetTime(isoStr) {
  if (!isoStr) return "N/A";
  try {
    const targetMs = new Date(isoStr).getTime();
    if (isNaN(targetMs)) return isoStr;
    const nowMs = Date.now();
    const diffSec = Math.floor((targetMs - nowMs) / 1000);

    const dateStr = new Date(targetMs).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });

    if (diffSec <= 0) return `Reset due now (${dateStr})`;

    const days = Math.floor(diffSec / 86400);
    const hours = Math.floor((diffSec % 86400) / 3600);
    const minutes = Math.floor((diffSec % 3600) / 60);

    let countdown = "";
    if (days > 0) {
      countdown = `${days}d ${hours}h`;
    } else if (hours > 0) {
      countdown = `${hours}h ${minutes}m`;
    } else {
      countdown = `${minutes}m`;
    }

    return `in ${countdown} (${dateStr})`;
  } catch {
    return isoStr;
  }
}

/**
 * Format plan type into formal human-readable label.
 */
export function formatPlanType(planType) {
  if (!planType) return "Unknown Tier";
  const p = planType.toLowerCase();
  if (p === "go") return "ChatGPT Go";
  if (p === "plus") return "ChatGPT Plus";
  if (p === "pro") return "ChatGPT Pro";
  if (p === "team") return "ChatGPT Team";
  if (p === "enterprise") return "ChatGPT Enterprise";
  return planType.toUpperCase();
}
