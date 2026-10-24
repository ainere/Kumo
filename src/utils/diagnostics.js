/**
 * diagnostics.js — System health, subscription login, and direct-API doctor.
 * Verifies Node.js, Codex CLI, Antigravity/Gemini CLI, new subscription CLIs,
 * direct-API key presence, and MCP bridge.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { loadConfig, getConfigPath } from "../config/settings.js";
import { getCliBinary } from "../bridge/agy-runner.js";
import { findCodexBinary } from "../providers/orchestrators/codex.js";
import { safeSpawn, resolveBinary, killProcessTree } from "./process.js";
const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Run a command and return stdout or null if error.
 *
 * Goes through resolveBinary + safeSpawn: `execFile` cannot launch the `.cmd`
 * shims npm installs on Windows (EINVAL), and a bare name would never find
 * them, so every npm-installed CLI used to be reported as missing.
 */
function checkCommandFile(file, argsArray) {
  return new Promise((resolve) => {
    let proc;
    try {
      proc = safeSpawn(resolveBinary(file), argsArray, { stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      resolve({ ok: false, error: err.message });
      return;
    }
    let stdout = "";
    const timer = setTimeout(() => {
      killProcessTree(proc);
      resolve({ ok: false, error: "timed out" });
    }, 10000);
    proc.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    proc.on("error", (err) => {
      clearTimeout(timer);
      resolve({ ok: false, error: err.message });
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      resolve(code === 0 ? { ok: true, output: stdout.trim() } : { ok: false, error: `exit code ${code}` });
    });
  });
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
      results.gemini.details =
        fallback === "agy"
          ? `Found fallback 'agy' (${fallbackCheck.output}). Run: kumo config set cliBinary agy`
          : `Found 'gemini' (${fallbackCheck.output}) but not 'agy'. Install Antigravity, or use the gemini-cli worker provider.`;
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
  // Worker readiness is a separate question from orchestrator readiness: a
  // machine with only Codex installed has an orchestrator and no worker.
  const workerNames = [];
  if (results.gemini?.ok) workerNames.push("gemini");
  if (results.claude?.ok) workerNames.push("claude");
  if (results.copilot?.ok) workerNames.push("copilot");
  if (results.cursor?.ok) workerNames.push("cursor");
  if (results.geminiCli?.ok) workerNames.push("gemini-cli");
  if (results.ollama?.ok) workerNames.push("ollama");
  const workerOk = workerNames.length > 0 || apiOk;
  results.workerPath = {
    ok: workerOk,
    details: workerOk
      ? workerNames.length > 0
        ? `Worker CLI available: ${workerNames.join(", ")}`
        : "Available via Direct API keys (no worker CLI required)"
      : "No worker path available (no worker CLI and no API key)",
  };

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

/**
 * Whether the environment can actually run a Kumo session.
 *
 * Requires BOTH halves of the harness: an orchestrator path and a worker path.
 * `orchestratorPath.ok` alone is not sufficient, because it already counts a
 * Codex login, which says nothing about whether any worker exists.
 *
 * @param {object} results - output of runDiagnostics()
 * @returns {boolean}
 */
export function isEnvironmentReady(results) {
  return Boolean(
    results?.node?.ok &&
      results?.bridge?.ok &&
      results?.orchestratorPath?.ok &&
      results?.workerPath?.ok
  );
}
