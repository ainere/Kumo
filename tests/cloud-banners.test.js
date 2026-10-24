import "./helpers/env.js";
/**
 * cloud-banners.test.js — Verification tests for Cloud Cumulus kanji banner styling,
 * progress bars, and rate limit formatting helpers.
 */

import { test } from "node:test";
import assert from "node:assert";
import {
  getBanner,
  progressBar,
  formatResetTime,
  formatIsoResetTime,
} from "../src/utils/ui.js";

test("getBanner interpolates the provided version string", () => {
  const testVersion = "9.9.9-test";
  const rendered = getBanner(testVersion, "cloud");
  assert.ok(rendered.includes(`v${testVersion}`), `Banner must contain version 'v${testVersion}'`);
});

test("custom subtitle renders in cloud banner", () => {
  const custom = "Custom Orchestrator ◄───[MCP]───► Custom Worker";
  const rendered = getBanner("2.0.0", "cloud", custom);
  assert.ok(rendered.includes(custom), "Banner must contain the custom subtitle");
  assert.ok(rendered.includes("2.0.0"), "Banner must contain version '2.0.0'");
});

test("progressBar clamps and renders correct visual bars", () => {
  const bar0 = progressBar(0, 10);
  assert.ok(bar0.includes("0%"));

  const bar50 = progressBar(50, 10);
  assert.ok(bar50.includes("50%"));

  const bar100 = progressBar(100, 10);
  assert.ok(bar100.includes("100%"));

  // Check out of bounds clamping
  const barOver = progressBar(150, 10);
  assert.ok(barOver.includes("100%"));

  const barUnder = progressBar(-20, 10);
  assert.ok(barUnder.includes("0%"));
});


test("formatResetTime calculates relative countdown", () => {
  const nowSec = Math.floor(Date.now() / 1000);
  // 5 days, 3 hours, plus a minute of slack: if the clock ticks over a second
  // before formatResetTime reads it, an exact 5d3h would print "5d 2h".
  const futureSec = nowSec + 86400 * 5 + 3600 * 3 + 60;

  const formatted = formatResetTime(futureSec);
  assert.ok(formatted.includes("in 5d 3h"), `Expected 'in 5d 3h', got: ${formatted}`);

  const pastFormatted = formatResetTime(nowSec - 100);
  assert.ok(pastFormatted.includes("Reset due now"));

  assert.strictEqual(formatResetTime(null), "N/A");
});

test("formatIsoResetTime formats ISO 8601 timestamps", () => {
  const future = new Date(Date.now() + 3600 * 1000 * 2).toISOString();
  const formatted = formatIsoResetTime(future);
  assert.ok(formatted.includes("in 2h 0m") || formatted.includes("in 1h 59m"));
});
