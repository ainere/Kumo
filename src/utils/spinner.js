/**
 * spinner.js — Minimal terminal spinner for long-running operations.
 */
import { c } from "./ui.js";

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export function createSpinner(label = "Thinking") {
  let frame = 0;
  let startTime = Date.now();
  let interval = null;
  let active = false;

  function render() {
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    const text = `  ${c.brightCyan}${FRAMES[frame]}${c.reset} ${c.dim}${label}... (${elapsed}s)${c.reset}`;
    process.stdout.write(`\r\x1b[K${text}`);
    frame = (frame + 1) % FRAMES.length;
  }

  return {
    start() {
      if (active) return;
      active = true;
      startTime = Date.now();
      frame = 0;
      interval = setInterval(render, 80);
    },
    stop() {
      if (!active) return;
      active = false;
      clearInterval(interval);
      process.stdout.write("\r\x1b[K"); // clear spinner line
    },
    isActive() {
      return active;
    },
  };
}
