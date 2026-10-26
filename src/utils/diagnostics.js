/**
 * diagnostics.js — System health, subscription login, and direct-API doctor.
 * Verifies Node.js, Codex CLI, Antigravity CLI, new subscription CLIs,
 * direct-API key presence, and MCP bridge.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { loadConfig, getConfigPath } from "../config/settings.js";
import { getCliBinary } from "../bridge/agy-runner.js";
import { findCodexBinary } from "../providers/orchestrators/codex.js";
import { safeSpawn, resolveBinary, killProcessTree, childEnvFor } from "./process.js";
import { nodeCommand } from "../core/node-command.js";
const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Spawn options for a version probe: piped output, no console window flashing up
 * on Windows, and the given environment when there is one.
 *
 * @param {Record<string, string|undefined>} [env]
 * @returns {import("node:child_process").SpawnOptions}
 */
export function probeSpawnOptions(env) {
  return { stdio: ["ignore", "pipe", "pipe"], windowsHide: true, ...(env ? { env } : {}) };
}

/**
 * Run a command and return stdout or null if error.
 *
 * Goes through resolveBinary + safeSpawn: `execFile` cannot launch the `.cmd`
 * shims npm installs on Windows (EINVAL), and a bare name would never find
 * them, so every npm-installed CLI used to be reported as missing.
 *
 * `env` is the child's whole environment. Probing a provider CLI should pass
 * `childEnvFor(provider)` so no unrelated credential reaches it; left out, the
 * child inherits this process's environment.
 *
 * @param {string} file
 * @param {string[]} argsArray
 * @param {{ timeoutMs?: number, env?: Record<string, string|undefined> }} [opts]
 * @returns {Promise<{ ok: true, output: string } | { ok: false, error: string }>}
 */
export function checkCommandFile(file, argsArray, { timeoutMs = 10000, env } = {}) {
  return new Promise((resolve) => {
    let proc;
    try {
      proc = safeSpawn(resolveBinary(file), argsArray, probeSpawnOptions(env));
    } catch (err) {
      resolve({ ok: false, error: err.message });
      return;
    }
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      killProcessTree(proc);
      resolve({ ok: false, error: "timed out" });
    }, timeoutMs);
    proc.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    // Some CLIs print their version on stderr; keep it as a fallback.
    proc.stderr?.on("data", (chunk) => {
      stderr = (stderr + chunk.toString()).slice(-2000);
    });
    proc.on("error", (err) => {
      clearTimeout(timer);
      resolve({ ok: false, error: err.message });
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      resolve(code === 0 ? { ok: true, output: stdout.trim() || stderr.trim() } : { ok: false, error: `exit code ${code}` });
    });
  });
}

/**
 * Start the MCP bridge the way an orchestrator would, list its tools, and stop it.
 *
 * Spawned through nodeCommand(): inside the desktop app `process.execPath` is
 * Electron, which only behaves as node with ELECTRON_RUN_AS_NODE set, and a bare
 * "node" may not be on PATH at all. The child gets the SDK's minimal default
 * environment, so the Kumo state directory is passed on by hand or the probe
 * would read a different config than the caller does (`kumoHome` overrides it:
 * the bridge's loadConfig moves a corrupt config.json aside, so a caller that
 * must not touch the user's files points it at a scratch folder). Bounded by a
 * timeout so a hung bridge cannot hang the caller.
 *
 * @param {{ workspace?: string, timeoutMs?: number, kumoHome?: string }} [opts]
 * @returns {Promise<{ ok: boolean, tools: string[], details: string }>}
 */
export async function probeBridge({ workspace = process.cwd(), timeoutMs = 15000, kumoHome } = {}) {
  const serverScript = path.resolve(__dirname, "../bridge/server.js");
  const node = nodeCommand();
  const env = { ...node.env };
  const home = kumoHome ?? process.env.KUMO_HOME;
  if (home) env.KUMO_HOME = home;
  const transport = new StdioClientTransport({
    command: node.command,
    args: [serverScript, "--workspace", workspace],
    env,
    stderr: "pipe",
  });
  // Piped stderr must be drained; its tail also explains a failed start.
  let stderrTail = "";
  transport.stderr?.on("data", (chunk) => {
    stderrTail = (stderrTail + chunk.toString()).slice(-600);
  });
  const client = new Client({ name: "doctor-client", version: "1.0.0" }, { capabilities: {} });

  let timer;
  try {
    const tools = await Promise.race([
      (async () => {
        await client.connect(transport);
        return (await client.listTools()).tools.map((t) => t.name);
      })(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`no answer within ${timeoutMs} ms`)), timeoutMs);
      }),
    ]);
    return { ok: true, tools, details: `Bridge initialized successfully with ${tools.length} tools registered.` };
  } catch (err) {
    const tail = stderrTail.trim();
    return { ok: false, tools: [], details: `MCP server failed: ${err.message}${tail ? ` (${tail})` : ""}` };
  } finally {
    clearTimeout(timer);
    // Ends the child (stdin close, then SIGTERM/SIGKILL); never throws out of here.
    await transport.close().catch(() => {});
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
    claude: { ok: false, installed: false, details: "" },
    copilot: { ok: false, installed: false, details: "" },
    cursor: { ok: false, installed: false, details: "" },
    ollama: { ok: false, installed: false, details: "" },
    config: { ok: true, path: getConfigPath(), values: config },
    // Overall orchestrator-path health: any subscription login OR any API key present.
    orchestratorPath: { ok: false, details: "" },
  };

  // 1. Node.js version
  const nodeVersion = process.version;
  const major = parseInt(nodeVersion.replace("v", "").split(".")[0], 10);
  if (major >= 22) {
    results.node = { ok: true, details: `${nodeVersion} (Supported)` };
  } else {
    results.node = { ok: false, details: `${nodeVersion} (Node.js >= 22.0.0 required)` };
  }

  // 2. Codex CLI
  const codexBin = findCodexBinary();
  const codexCheck = await checkCommandFile(codexBin, ["--version"], { env: childEnvFor("codex") });
  if (codexCheck.ok) {
    results.codex.installed = true;
    results.codex.ok = true;
    results.codex.details = `Installed '${codexBin}' (${codexCheck.output})`;
  } else {
    results.codex.installed = false;
    results.codex.ok = false;
    results.codex.details = "Not found. Ensure Codex is installed and authenticated via: codex login";
  }

  // 3. Antigravity CLI (agy)
  const workerBin = getCliBinary();
  const workerCheck = await checkCommandFile(workerBin, ["--version"], { env: childEnvFor("antigravity") });
  if (workerCheck.ok) {
    results.gemini.installed = true;
    results.gemini.ok = true;
    results.gemini.details = `Installed '${workerBin}' (${workerCheck.output})`;
  } else {
    // A resolved path that fails to run may still leave `agy` on PATH.
    const fallbackCheck = workerBin === "agy"
      ? null
      : await checkCommandFile("agy", ["--version"], { env: childEnvFor("antigravity") });
    if (fallbackCheck?.ok) {
      results.gemini.installed = true;
      results.gemini.ok = true;
      results.gemini.details = `Found fallback 'agy' (${fallbackCheck.output}). Run: kumo config set cliBinary agy`;
    } else {
      results.gemini.installed = false;
      results.gemini.ok = false;
      results.gemini.details = `'agy' not found in PATH.`;
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
    { key: "claude", provider: "claude", bin: process.env.CLAUDE_BIN || "claude", args: ["--version"], hint: "Install Claude Code: npm install -g @anthropic-ai/claude-code, then run 'claude' to log in" },
    { key: "copilot", provider: "copilot", bin: process.env.COPILOT_BIN || "gh", args: ["copilot", "--version"], hint: "Install GitHub CLI with copilot extension: gh extension install github/gh-copilot" },
    { key: "cursor", provider: "cursor", bin: process.env.CURSOR_BIN || "cursor-agent", args: ["--version"], hint: "Install Cursor Agent and ensure 'cursor-agent' is on PATH" },
    { key: "ollama", provider: "ollama", bin: process.env.OLLAMA_BIN || "ollama", args: ["--version"], hint: "Install Ollama from https://ollama.com and ensure 'ollama' is on PATH" },
  ];
  await Promise.all(
    cliProbes.map(async ({ key, provider, bin, args, hint }) => {
      const check = await checkCommandFile(bin, args, { env: childEnvFor(provider) });
      if (check.ok) {
        results[key] = { ok: true, installed: true, details: `Installed '${bin}' (${check.output})` };
      } else {
        results[key] = { ok: false, installed: false, details: `Not found ('${bin}'). ${hint}` };
      }
    })
  );

  // 4. MCP Bridge test
  const bridge = await probeBridge();
  results.bridge = { ok: bridge.ok, details: bridge.details };

  // 5. Overall orchestrator-path health: ok when at least one subscription login OR any API key is present.
  const subscriptionOk =
    Boolean(results.codex?.ok) ||
    Boolean(results.gemini?.ok) ||
    Boolean(results.claude?.ok) ||
    Boolean(results.copilot?.ok) ||
    Boolean(results.cursor?.ok) ||
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
