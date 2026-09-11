/**
 * gemini.js — Google Gemini worker provider adapter.
 */

import { runAgy, getCliBinary } from "../../bridge/agy-runner.js";

export const PROVIDER_INFO = {
  id: "gemini",
  name: "Google Gemini (Antigravity / Gemini CLI)",
};

export async function executeTask(opts) {
  return runAgy(opts);
}

export function getBinary() {
  return getCliBinary();
}
