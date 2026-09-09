/**
 * ui.js — Formal terminal styling utilities, ANSI color coding,
 * and multi-style banner designs for KUMO.
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
};

/**
 * Available banner design implementations.
 */
export const BANNER_DESIGNS = {
  slant: {
    name: "Slant (Aligned)",
    description: "Properly aligned slanted forward-motion isometric ASCII font with badge",
    render: (v) => {
      const l1 = `${c.brightCyan}    __ __${c.cyan}                  ${c.blue}        ${c.reset}`;
      const l2 = `${c.brightCyan}   / //_/${c.cyan}__  ______ ___  ${c.blue}____     ${c.reset}  ${c.bold}${c.white}KUMO${c.reset} ${c.dim}v${v}${c.reset}`;
      const l3 = `${c.brightCyan}  / ,<  ${c.cyan}/ / / / __ \`__ \\${c.blue}/ __ \\    ${c.reset}  ${c.dim}Cross-Provider AI Orchestrator${c.reset}`;
      const l4 = `${c.brightCyan} / /| | ${c.cyan}/ /_/ / / / / / /${c.blue} /_/ /    ${c.reset}  ${c.dim}Codex (Astra) ◄───[MCP]───► Gemini (Flash)${c.reset}`;
      const l5 = `${c.brightCyan}/_/ |_| ${c.cyan}\\__,_/_/ /_/ /_/${c.blue}\\____/     ${c.reset}`;
      return `${l1}\n${l2}\n${l3}\n${l4}\n${l5}`;
    },
  },

  spider: {
    name: "Spider (蜘蛛)",
    description: "ASCII Spider glyph linking the two provider endpoints",
    render: (v) => {
      const s1 = `${c.brightCyan}      / _ \\     ${c.reset}  ${c.bold}${c.white}KUMO (蜘蛛)${c.reset} ${c.dim}v${v}${c.reset}`;
      const s2 = `${c.cyan}    \\(\\(_)/)/   ${c.reset}  ${c.dim}Cross-Provider AI Orchestration Harness${c.reset}`;
      const s3 = `${c.blue}     -(_)-      ${c.reset}  ${c.dim}OpenAI Codex ◄───[MCP]───► Google Gemini${c.reset}`;
      const s4 = `${c.brightBlue}    / / \\ \\     ${c.reset}  ${c.dim}High-Speed Agent Weaver${c.reset}`;
      return `${s1}\n${s2}\n${s3}\n${s4}`;
    },
  },

  cloud: {
    name: "Cloud (雲)",
    description: "Clean ASCII Cloud illustration with balanced provider subtitle",
    render: (v) => {
      const c1 = `${c.brightCyan}       .--.     ${c.reset}  ${c.bold}${c.white}KUMO (雲)${c.reset} ${c.dim}v${v}${c.reset}`;
      const c2 = `${c.cyan}    .-(    ).   ${c.reset}  ${c.dim}Cross-Provider AI Orchestration Harness${c.reset}`;
      const c3 = `${c.blue}   (___.__)__)  ${c.reset}  ${c.dim}OpenAI Codex ◄───[MCP]───► Google Gemini${c.reset}`;
      return `${c1}\n${c2}\n${c3}`;
    },
  },

  web: {
    name: "Web / Mesh",
    description: "ASCII Web geometry capturing the multi-agent mesh",
    render: (v) => {
      const w1 = `${c.brightCyan}    /\\  /\\    ${c.reset}  ${c.bold}${c.white}KUMO (蜘蛛の巣)${c.reset} ${c.dim}v${v}${c.reset}`;
      const w2 = `${c.cyan}   <  ><  >   ${c.reset}  ${c.dim}Cross-Provider AI Orchestration Harness${c.reset}`;
      const w3 = `${c.blue}    \\/  \\/    ${c.reset}  ${c.dim}Codex (Astra) ◄───[MCP]───► Gemini (Flash)${c.reset}`;
      return `${w1}\n${w2}\n${w3}`;
    },
  },

  isometric: {
    name: "Isometric 3D",
    description: "Double-line geometric wireframe block font",
    render: (v) => {
      const l1 = `${c.brightCyan}╦╔═╦ ╦╔╦╗╔═╗${c.reset}   ${c.bold}${c.white}KUMO${c.reset} ${c.dim}v${v}${c.reset}`;
      const l2 = `${c.cyan}╠╩╗║ ║║║║║ ║${c.reset}   ${c.dim}Cross-Provider AI Orchestrator${c.reset}`;
      const l3 = `${c.blue}╩ ╩╚═╝╩ ╩╚═╝${c.reset}   ${c.dim}Codex (Astra) ◄───[MCP]───► Gemini (Flash)${c.reset}`;
      return `${l1}\n${l2}\n${l3}`;
    },
  },

  block: {
    name: "Block",
    description: "Solid, modern sans-serif block typography with subtle cyan-to-blue gradient",
    render: (v) => {
      const l1 = `${c.brightCyan}█  █${c.cyan}  █   █${c.blue}  █   █${c.brightBlue}   ███ ${c.reset}`;
      const l2 = `${c.brightCyan}█ █ ${c.cyan}  █   █${c.blue}  ██ ██${c.brightBlue}  █   █${c.reset}   ${c.bold}${c.white}KUMO${c.reset} ${c.dim}v${v}${c.reset}`;
      const l3 = `${c.brightCyan}██  ${c.cyan}  █   █${c.blue}  █ █ █${c.brightBlue}  █   █${c.reset}   ${c.dim}Cross-Provider AI Orchestrator${c.reset}`;
      const l4 = `${c.brightCyan}█ █ ${c.cyan}  █   █${c.blue}  █   █${c.brightBlue}  █   █${c.reset}`;
      const l5 = `${c.brightCyan}█  █${c.cyan}   ███ ${c.blue}  █   █${c.brightBlue}   ███ ${c.reset}`;
      return `${l1}\n${l2}\n${l3}\n${l4}\n${l5}`;
    },
  },

  kanji: {
    name: "Kanji & Cloud (雲)",
    description: "Prominent Japanese kanji for cloud/spider with balanced subtitle badge",
    render: (v) => {
      const k1 = `${c.brightCyan}    雨    ${c.reset}  ${c.bold}${c.white}KUMO (雲)${c.reset} ${c.dim}v${v}${c.reset}`;
      const k2 = `${c.cyan}  一 云 一${c.reset}  ${c.dim}Cross-Provider AI Orchestration Harness${c.reset}`;
      const k3 = `${c.blue}   二 二  ${c.reset}  ${c.dim}Codex (Astra) × Gemini (Flash)${c.reset}`;
      return `${k1}\n${k2}\n${k3}`;
    },
  },

  minimal: {
    name: "Minimal Line",
    description: "Compact single-line badge inspired by modern developer CLI tools",
    render: (v) => {
      return `${c.bold}${c.brightCyan}KUMO${c.reset} ${c.dim}v${v}${c.reset} ${c.dim}│${c.reset} ${c.white}Cross-Provider AI Orchestrator${c.reset}`;
    },
  },

  box: {
    name: "Box Framed Card",
    description: "Clean Unicode boxed card with framed provider and version details",
    render: (v) => {
      const top = `${c.dim}┌────────────────────────────────────────────────────────┐${c.reset}`;
      const m1  = `${c.dim}│${c.reset}  ${c.bold}${c.brightCyan}KUMO${c.reset} ${c.dim}v${v}${c.reset}  ${c.dim}•  Cross-Provider AI Orchestrator${c.reset}       ${c.dim}│${c.reset}`;
      const m2  = `${c.dim}│${c.reset}  ${c.dim}OpenAI Codex (Astra)  ◄───[MCP]───►  Google Gemini     │${c.reset}`;
      const bot = `${c.dim}└────────────────────────────────────────────────────────┘${c.reset}`;
      return `${top}\n${m1}\n${m2}\n${bot}`;
    },
  },
};

/**
 * Get configured or default banner string.
 */
export function getBanner(version = "1.0.0", style = "slant") {
  const design = BANNER_DESIGNS[style] || BANNER_DESIGNS.slant || BANNER_DESIGNS.block;
  return design.render(version);
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
