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
   # or: codex, claude, gh, cursor-agent, ollama, opencode, commandcode
   ```
   Run `kumo doctor` to probe every provider binary at once. A copy in the project folder doesn't count: Kumo only looks in the folders on PATH.
2. Each provider honors a binary override env var: `AGY_BIN`, `CODEX_BIN`, `CLAUDE_BIN`, `COPILOT_BIN`, `CURSOR_BIN`, `OLLAMA_BIN`, `OPENCODE_BIN`, `COMMANDCODE_BIN`. Example:
   ```powershell
   $env:AGY_BIN = "C:\Users\<username>\AppData\Local\agy\bin\agy.exe"
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

## 3. Subprocess Timeout

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

## 4. Verifying MCP Server Health Manually

You can check the MCP server in isolation anytime by running:
```bash
kumo doctor
```
Besides each provider CLI and its login, it starts the bridge, connects a lightweight MCP client over stdio and confirms the worker tools register. It runs no model, so it costs no quota.

---

## 5. A Worker Is Refused Because Its Launcher Is a .cmd File

### Symptom:
`Copilot's launcher is a .cmd file, and a multi-line prompt can't be passed to it on Windows.`

### Solution:
Copilot, Command Code and CLIs you set as a provider by name take their prompt on the command line only, and `cmd.exe` can't carry a line break through a `.cmd` shim. A worker's prompt always has line breaks.
1. Point the override variable at the CLI's `.exe` instead of its `.cmd` shim:
   ```powershell
   $env:COPILOT_BIN = "C:\path\to\copilot.exe"
   ```
2. Or give the role a provider that reads its prompt from stdin, such as Codex or Claude Code (`kumo role set <role> <model>`).
3. A message about a prompt that is too long (over 8,000 characters through a `.cmd` launcher, over 30,000 through any launcher) has the same two fixes, or shorten the task and pass fewer files.

---

## 6. A Confirmed Preview Was Not Applied

### Symptom:
One of these in a write tool's result, under `diff-review` or `interactive`:
- `[STATUS: NO_DIFF]`, with no `previewId`
- `the approved diff could not be applied verbatim (...); nothing was written. Request a new preview.`
- `this previewId is already being applied by another confirmation; wait for it to finish.`

### Solution:
A confirmation in these modes writes the approved diff and nothing else, so in each case nothing was written.
1. `NO_DIFF`: the worker answered without a unified diff. Ask again, name the files to change, and ask for the change as a unified diff.
2. Could not be applied: the files changed after the preview, or the diff was cut short. Request a new preview and confirm that one.
3. Already being applied: the same `previewId` was confirmed twice at once. Wait for the first call to finish.

---

## 7. A Turn Has No Checkpoint

### Symptom:
`Couldn't save a checkpoint, so this work may not rewind: the project has more than 1 GB of new files that git doesn't ignore, so no checkpoint was taken.`

### Solution:
A checkpoint holds every new file git doesn't ignore. Past 1 GB in total Kumo takes none, because a checkpoint with only some of the files could make a rewind delete the rest.
1. Add build output, datasets and dependency folders to `.gitignore`, or commit the files you mean to keep.
2. The next turn gets a checkpoint again. The warning shows once per session.

---

## 8. Kumo Will Not Overwrite a Config File

### Symptom:
`kumo init` lists a file as skipped: `<file> cannot be merged into (it is not valid JSON). Kumo will not overwrite it; fix or remove it, then retry.`

### Solution:
The file (`.agents/mcp_config.json`, or `~/.gemini/config/mcp_config.json`) has content Kumo can't read as a JSON object, such as a comment, a trailing comma or an array. It is yours, so Kumo leaves it as it is.
1. Fix the JSON, or delete the file if you don't need what's in it.
2. Run `kumo init` again.
