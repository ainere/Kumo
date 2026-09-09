# Troubleshooting Guide: Codex × Gemini Orchestrator

Common issues and solutions when running the cross-provider harness.

---

## 1. CLI Executable Not Found

### Symptom:
`Failed to spawn CLI binary 'agy': ENOENT` or similar in MCP tool results.

### Solution:
1. Check if `agy` is installed and in your system PATH:
   ```powershell
   Get-Command agy
   ```
2. If using a different binary name (such as `gemini` or an explicit absolute path), set the `AGY_BIN` environment variable before launching Codex:
   ```powershell
   $env:AGY_BIN = "gemini"
   # Or set a full path:
   $env:AGY_BIN = "C:\Users\<username>\AppData\Roaming\npm\agy.cmd"
   ```
3. You can also specify this permanently in `.codex/config.toml` under `[mcp_servers.gemini-bridge.env]`:
   ```toml
   [mcp_servers.gemini-bridge]
   command = "node"
   args = ["src/bridge/server.js"]
   env = { AGY_BIN = "gemini" }
   ```

---

## 2. Authentication Errors

### Symptom:
Gemini tool returns: `Error authenticating: IneligibleTierError` or `Session expired`.

### Solution:
1. For Google AI Pro / Antigravity:
   - Run `agy auth login` (or your CLI's login command) in your terminal.
   - Verify that your subscription tier is active and selected.
2. For Codex / ChatGPT Plus:
   - Run `codex login` and complete the browser authentication.

---

## 3. Trusted Workspace Warning in Gemini

### Symptom:
Tool warning: `Gemini CLI is not running in a trusted directory`.

### Solution:
The bridge runner automatically sets `GEMINI_CLI_TRUST_WORKSPACE=true` and passes `--skip-trust`. If running manually, trust the folder with:
```bash
gemini --skip-trust
```

---

## 4. Subprocess Timeout

### Symptom:
`⏱ gemini_implement timed out after 300s.`

### Solution:
1. By default, tasks have a 5-minute timeout.
2. For very large tasks, either break the task prompt into smaller chunks or increase `GEMINI_TIMEOUT_MS`:
   ```powershell
   $env:GEMINI_TIMEOUT_MS = "600000"  # 10 minutes
   ```
   Or in `.codex/config.toml`:
   ```toml
   [mcp_servers.gemini-bridge.env]
   GEMINI_TIMEOUT_MS = "600000"
   ```

---

## 5. Verifying MCP Server Health Manually

You can test the MCP server in isolation anytime by running:
```bash
cd bridge
npm test
```
This connects a lightweight client via stdio to verify that all tools register and communication functions without error.
