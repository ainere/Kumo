/**
 * ui.js — Formal, terminal styling utilities with ANSI color coding.
 * Provides consistent typography, status badges, and layout without emojis.
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
 * Clean, readable block typography logo for KUMO.
 */
export function getBanner(version = "1.0.0") {
  const line1 = `${c.brightCyan}█  █${c.cyan}  █   █${c.blue}  █   █${c.brightBlue}   ███ ${c.reset}`;
  const line2 = `${c.brightCyan}█ █ ${c.cyan}  █   █${c.blue}  ██ ██${c.brightBlue}  █   █${c.reset}   ${c.bold}${c.white}KUMO${c.reset} ${c.dim}v${version}${c.reset}`;
  const line3 = `${c.brightCyan}██  ${c.cyan}  █   █${c.blue}  █ █ █${c.brightBlue}  █   █${c.reset}   ${c.dim}Cross-Provider AI Orchestrator${c.reset}`;
  const line4 = `${c.brightCyan}█ █ ${c.cyan}  █   █${c.blue}  █   █${c.brightBlue}  █   █${c.reset}`;
  const line5 = `${c.brightCyan}█  █${c.cyan}   ███ ${c.blue}  █   █${c.brightBlue}   ███ ${c.reset}`;

  return `
${line1}
${line2}
${line3}
${line4}
${line5}
`.trim();
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
