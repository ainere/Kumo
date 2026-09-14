/**
 * diagnostics.js — System health, subscription login, and direct-API doctor.
 * Verifies Node.js, Codex CLI, Antigravity/Gemini CLI, new subscription CLIs,
 * direct-API key presence, and MCP bridge.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { loadConfig, getConfigPath } from "../config/settings.js";
import { getCliBinary } from "../bridge/agy-runner.js";
import { findCodexBinary } from "../providers/orchestrators/codex.js";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Run a command and return stdout or null if error.
 */
async function checkCommandFile(file, argsArray) {
  try {
    const { stdout } = await execFileAsync(file, argsArray, { timeout: 10000 });
    return { ok: true, output: stdout.trim() };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Execute full diagnostic suite.
 */
export async function runDiagnostics() {
  const config = loadConfig();
  const results = {
    node: { ok: false, details: "" },
    codex: { ok: false, installed: false, details: "" },
    gemini: { ok: false, installed: false, details: "" },
    bridge: { ok: false, details: "" },
    // Non-breaking additions: Direct-API presence (env only, no network) + new CLI probes.
    openaiApi: { ok: false, details: "missing" },
    anthropicApi: { ok: false, details: "missing" },
    geminiApi: { ok: false, details: "missing" },
    compatApi: { ok: false, details: "missing" },
    copilot: { ok: false, installed: false, details: "" },
    cursor: { ok: false, installed: false, details: "" },
    geminiCli: { ok: false, installed: false, details: "" },
    ollama: { ok: false, installed: false, details: "" },
    config: { ok: true, path: getConfigPath(), values: config },
    // Overall orchestrator-path health: any subscription login OR any API key present.
    orchestratorPath: { ok: false, details: "" },
  };

  // 1. Node.js version
  const nodeVersion = process.version;
  const major = parseInt(nodeVersion.replace("v", "").split(".")[0], 10);
  if (major >= 20) {
    results.node = { ok: true, details: `${nodeVersion} (Supported)` };
  } else {
    results.node = { ok: false, details: `${nodeVersion} (Node.js >= 20.0.0 required)` };
  }

  // 2. Codex CLI
  const codexBin = findCodexBinary();
  const codexCheck = await checkCommandFile(codexBin, ["--version"]);
  if (codexCheck.ok) {
    results.codex.installed = true;
    results.codex.ok = true;
    results.codex.details = `Installed '${codexBin}' (${codexCheck.output})`;
  } else {
    results.codex.installed = false;
    results.codex.ok = false;
    results.codex.details = "Not found. Ensure Codex is installed and authenticated via: codex login";
  }

  // 3. Antigravity / Gemini CLI
  const workerBin = getCliBinary();
  const workerCheck = await checkCommandFile(workerBin, ["--version"]);
  if (workerCheck.ok) {
    results.gemini.installed = true;
    results.gemini.ok = true;
    results.gemini.details = `Installed '${workerBin}' (${workerCheck.output})`;
  } else {
    // Check fallback
    const fallback = workerBin === "agy" ? "gemini" : "agy";
    const fallbackCheck = await checkCommandFile(fallback, ["--version"]);
    if (fallbackCheck.ok) {
      results.gemini.installed = true;
      results.gemini.ok = true;
      results.gemini.details = `Found fallback '${fallback}' (${fallbackCheck.output}). Run: kumo config set cliBinary ${fallback}`;
    } else {
      results.gemini.installed = false;
      results.gemini.ok = false;
      results.gemini.details = `Neither 'agy' nor 'gemini' found in PATH.`;
    }
  }

  // 3b. Direct-API presence checks (env only, no network, never echo key material).
  const hasEnv = (name) => typeof process.env[name] === "string" && process.env[name].trim().length > 0;
  const hasOpenAi = hasEnv("OPENAI_API_KEY");
  const hasAnthropic = hasEnv("ANTHROPIC_API_KEY");
  const hasGemini = hasEnv("GEMINI_API_KEY") || hasEnv("GOOGLE_GENERATIVE_AI_API_KEY");
  const hasCompatKey = hasEnv("COMPAT_API_KEY");
  const hasCompatBase = hasEnv("COMPAT_BASE_URL") || Boolean(config?.compatBaseUrl && String(config.compatBaseUrl).trim());
  results.openaiApi = { ok: hasOpenAi, details: hasOpenAi ? "set (OPENAI_API_KEY)" : "missing (OPENAI_API_KEY)" };
  results.anthropicApi = { ok: hasAnthropic, details: hasAnthropic ? "set (ANTHROPIC_API_KEY)" : "missing (ANTHROPIC_API_KEY)" };
  results.geminiApi = { ok: hasGemini, details: hasGemini ? "set (GEMINI_API_KEY)" : "missing (GEMINI_API_KEY)" };
  results.compatApi = {
    ok: hasCompatBase,
    details: hasCompatBase
      ? (hasCompatKey ? "set (COMPAT_BASE_URL + COMPAT_API_KEY)" : "set (COMPAT_BASE_URL, keyless)")
      : "missing (COMPAT_BASE_URL)",
  };

  // 3c. New subscription CLI --version probes with install hints on failure.
  const cliProbes = [
    { key: "copilot", bin: process.env.COPILOT_BIN || "gh", args: ["copilot", "--version"], hint: "Install GitHub CLI with copilot extension: gh extension install github/gh-copilot" },
    { key: "cursor", bin: process.env.CURSOR_BIN || "cursor-agent", args: ["--version"], hint: "Install Cursor Agent and ensure 'cursor-agent' is on PATH" },
    { key: "geminiCli", bin: process.env.GEMINI_BIN || "gemini", args: ["--version"], hint: "Install Gemini CLI: npm install -g @google/gemini-cli" },
    { key: "ollama", bin: process.env.OLLAMA_BIN || "ollama", args: ["--version"], hint: "Install Ollama from https://ollama.com and ensure 'ollama' is on PATH" },
  ];
  await Promise.all(
    cliProbes.map(async ({ key, bin, args, hint }) => {
      const check = await checkCommandFile(bin, args);
      if (check.ok) {
        results[key] = { ok: true, installed: true, details: `Installed '${bin}' (${check.output})` };
      } else {
        results[key] = { ok: false, installed: false, details: `Not found ('${bin}'). ${hint}` };
      }
    })
  );

  // 4. MCP Bridge test
  const serverScript = path.resolve(__dirname, "../bridge/server.js");
  try {
    const transport = new StdioClientTransport({
      command: "node",
      args: [serverScript, "--workspace", process.cwd()],
    });
    const client = new Client(
      { name: "doctor-client", version: "1.0.0" },
      { capabilities: {} }
    );
    await client.connect(transport);
    const { tools } = await client.listTools();
    await transport.close();

    results.bridge = {
      ok: true,
      details: `Bridge initialized successfully with ${tools.length} tools registered.`,
    };
  } catch (err) {
    results.bridge = {
      ok: false,
      details: `MCP server failed: ${err.message}`,
    };
  }

  // 5. Overall orchestrator-path health: ok when at least one subscription login OR any API key is present.
  const subscriptionOk =
    Boolean(results.codex?.ok) ||
    Boolean(results.gemini?.ok) ||
    Boolean(results.copilot?.ok) ||
    Boolean(results.cursor?.ok) ||
    Boolean(results.geminiCli?.ok) ||
    Boolean(results.ollama?.ok);
  const apiOk =
    Boolean(results.openaiApi?.ok) ||
    Boolean(results.anthropicApi?.ok) ||
    Boolean(results.geminiApi?.ok) ||
    Boolean(results.compatApi?.ok);
  const pathOk = subscriptionOk || apiOk;
  results.orchestratorPath = {
    ok: pathOk,
    details: pathOk
      ? (apiOk && !subscriptionOk
        ? "Available via Direct API keys (no subscription login required)"
        : "At least one orchestrator path available")
      : "No orchestrator path available (no subscription login and no API key)",
  };

  return results;
}
