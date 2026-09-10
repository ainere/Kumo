/**
 * diagnostics.js — System health and subscription login doctor.
 * Verifies Node.js, Codex CLI, Antigravity/Gemini CLI, and MCP bridge.
 */

import { exec } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { loadConfig, getConfigPath } from "../config/settings.js";
import { getCliBinary } from "../bridge/agy-runner.js";
import { findCodexBinary } from "../providers/orchestrators/codex.js";

const execAsync = promisify(exec);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Run a command and return stdout or null if error.
 */
async function checkCommand(cmd) {
  try {
    const { stdout } = await execAsync(cmd);
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
    config: { ok: true, path: getConfigPath(), values: config },
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
  const codexCheck = await checkCommand(`"${codexBin}" --version`);
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
  const workerCheck = await checkCommand(`${workerBin} --version`);
  if (workerCheck.ok) {
    results.gemini.installed = true;
    results.gemini.ok = true;
    results.gemini.details = `Installed '${workerBin}' (${workerCheck.output})`;
  } else {
    // Check fallback
    const fallback = workerBin === "agy" ? "gemini" : "agy";
    const fallbackCheck = await checkCommand(`${fallback} --version`);
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

  return results;
}
