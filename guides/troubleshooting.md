# Troubleshooting Guide: Cross-Provider Orchestrator

Common issues and solutions when running the cross-provider harness.

---

## 1. CLI Executable Not Found

### Symptom:
`Failed to spawn CLI binary '<name>': ENOENT` or similar in MCP tool results (e.g. `agy`, `codex`, `cursor-agent`).

### Solution:
1. Check if the binary for your active provider is installed and in your system PATH:
   ```powershell
   Get-Command agy
   # or: codex, claude, gh, cursor-agent, gemini, ollama, opencode, commandcode
   ```
   Run `kumo doctor` to probe every provider binary at once.
2. Each provider honors a binary override env var: `AGY_BIN`, `CODEX_BIN`, `CLAUDE_BIN`, `COPILOT_BIN`, `CURSOR_BIN`, `GEMINI_BIN`, `OLLAMA_BIN`, `OPENCODE_BIN`, `COMMANDCODE_BIN`. Example:
   ```powershell
   $env:GEMINI_BIN = "gemini"
   # Or set a full path:
   $env:AGY_BIN = "C:\Users\<username>\AppData\Roaming\npm\agy.cmd"
   ```

---

## 2. Authentication Errors

### Symptom:
Worker tool returns: `Error authenticating: IneligibleTierError` or `Session expired`.

### Solution:
1. For Google AI Pro / Antigravity:
   - Run `agy auth login` (or your CLI's login command) in your terminal.
   - Verify that your subscription tier is active and selected.
2. For Codex / ChatGPT Plus:
   - Run `codex login` and complete the browser authentication.
3. For direct-API providers (`openai-api`, `anthropic-api`, `gemini-api`, `compat-api`):
   - `Missing or invalid <VAR>` means the env key is unset or rejected — set it in the current shell (never in config files):
   - `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY` (or `GOOGLE_GENERATIVE_AI_API_KEY` fallback), `COMPAT_API_KEY` (optional) + required `COMPAT_BASE_URL` (or `kumo config set compatBaseUrl <url>`).

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
`⏱ worker_implement timed out after 300s.`

### Solution:
1. By default, tasks have a 5-minute timeout.
2. For very large tasks, either break the task prompt into smaller chunks or increase `GEMINI_TIMEOUT_MS`:
   ```powershell
   $env:GEMINI_TIMEOUT_MS = "600000"  # 10 minutes
   ```
   Or in `.codex/config.toml`:
   ```toml
   [mcp_servers.kumo-bridge.env]
   GEMINI_TIMEOUT_MS = "600000"
   ```

---

## 5. Verifying MCP Server Health Manually

You can check the MCP server in isolation anytime by running:
```bash
kumo doctor
```
Besides each provider CLI and its login, it starts the bridge, connects a lightweight MCP client over stdio and confirms the worker tools register. It runs no model, so it costs no quota.
