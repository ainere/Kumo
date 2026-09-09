/**
 * ui.js — Formal terminal styling utilities, ANSI color coding,
 * cloud-themed banner designs, and rate limit formatters for KUMO.
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
};

export const DEFAULT_SUBTITLE = "Frontier Reasoning ◄───[MCP]───► High-Speed Execution";

/**
 * Cloud banner design implementations.
 * Focus exclusively on refined Cloud (雲) aesthetics.
 */
export const BANNER_DESIGNS = {
  cloud: {
    name: "Cloud (Classic Puffy 雲)",
    description: "Refined ASCII puffy cloud with balanced typography and gradient depth",
    render: (v = "1.0.0", sub = DEFAULT_SUBTITLE) => {
      const c1 = `${c.brightCyan}       .--.       ${c.reset}  ${c.bold}${c.white}KUMO (雲)${c.reset} ${c.dim}v${v}${c.reset}`;
      const c2 = `${c.cyan}    .-(    ).     ${c.reset}  ${c.dim}Cross-Provider AI Orchestrator${c.reset}`;
      const c3 = `${c.blue}   (___.__)__)    ${c.reset}  ${c.dim}${sub}${c.reset}`;
      return `${c1}\n${c2}\n${c3}`;
    },
  },

  "cloud-cumulus": {
    name: "Cloud Cumulus (Atmospheric Multi-Tier)",
    description: "Expanded atmospheric cloud cluster with volumetric shaded borders",
    render: (v = "1.0.0", sub = DEFAULT_SUBTITLE) => {
      const l1 = `${c.brightCyan}         .---.                ${c.reset}`;
      const l2 = `${c.brightCyan}      .-(     ).    ${c.cyan}.---.     ${c.reset}  ${c.bold}${c.white}KUMO${c.reset} ${c.dim}v${v}${c.reset}`;
      const l3 = `${c.cyan}    .(          ).-(     ).   ${c.reset}  ${c.dim}Cross-Provider AI Orchestrator${c.reset}`;
      const l4 = `${c.blue}   (____.__.__.____)(____)    ${c.reset}  ${c.dim}${sub}${c.reset}`;
      return `${l1}\n${l2}\n${l3}\n${l4}`;
    },
  },

  "cloud-kanji": {
    name: "Cloud Kanji (雲 Crest)",
    description: "Artistic cloud enclosure surrounding the traditional Japanese 雲 kanji",
    render: (v = "1.0.0", sub = DEFAULT_SUBTITLE) => {
      const k1 = `${c.brightCyan}     ╭─── 雲 ───╮     ${c.reset}  ${c.bold}${c.white}KUMO (雲)${c.reset} ${c.dim}v${v}${c.reset}`;
      const k2 = `${c.cyan}    -(   KUMO   )-    ${c.reset}  ${c.dim}Cross-Provider AI Orchestrator${c.reset}`;
      const k3 = `${c.blue}     ╰──────────╯     ${c.reset}  ${c.dim}${sub}${c.reset}`;
      return `${k1}\n${k2}\n${k3}`;
    },
  },

  "cloud-minimal": {
    name: "Cloud Minimal (Developer Header)",
    description: "Streamlined single/double-line compact cloud glyph for high-density terminals",
    render: (v = "1.0.0", sub = DEFAULT_SUBTITLE) => {
      const m1 = `${c.cyan} ☁  ${c.bold}${c.white}KUMO${c.reset} ${c.dim}v${v}${c.reset}  ${c.dim}│${c.reset}  ${c.dim}Cross-Provider AI Orchestrator${c.reset}`;
      const m2 = `    ${c.dim}${sub}${c.reset}`;
      return `${m1}\n${m2}`;
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
  dot: `${c.dim}•${c.reset}`,
  arrow: `${c.dim}→${c.reset}`,
};

/**
 * Horizontal separator line
 */
export function separator(length = 64) {
  return `${c.dim}${"─".repeat(length)}${c.reset}`;
}

/**
 * Render a visual ASCII progress bar for percentages (0 - 100).
 */
export function progressBar(percent = 0, width = 12) {
  const clamped = Math.max(0, Math.min(100, Math.round(percent)));
  const filled = Math.round((clamped / 100) * width);
  const empty = width - filled;

  let color = c.brightGreen;
  if (clamped > 80) color = c.brightRed;
  else if (clamped > 50) color = c.brightYellow;

  const bar = `${color}${"█".repeat(filled)}${c.dim}${"░".repeat(empty)}${c.reset}`;
  return `${bar} ${color}${clamped}%${c.reset}`;
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
 * Format plan type into formal human-readable label.
 */
export function formatPlanType(planType) {
  if (!planType) return "Unknown Tier";
  const p = planType.toLowerCase();
  if (p === "go" || p === "plus") return "ChatGPT Plus";
  if (p === "pro") return "ChatGPT Pro";
  if (p === "team") return "ChatGPT Team";
  if (p === "enterprise") return "ChatGPT Enterprise";
  return planType.toUpperCase();
}
