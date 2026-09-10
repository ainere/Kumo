# Getting Started with the Codex × Gemini Orchestrator

This guide walks you through setting up and running your first cross-provider orchestration task using **ChatGPT Plus** and **Google AI Pro**.

---

## 1. Authentication Setup (No API Keys Needed)

Both CLIs connect using your existing subscription credentials.

### A. Codex CLI (ChatGPT Plus)

1. Verify Codex CLI is installed:
   ```bash
   codex --version
   ```
2. Log in with your ChatGPT account:
   ```bash
   codex login
   ```
   Follow the interactive browser prompt to authenticate your ChatGPT Plus account.

### B. Antigravity CLI (Google AI Pro)

1. Verify `agy` is installed:
   ```bash
   agy --version
   ```
   *(Note: If using `gemini` CLI or a custom binary location, you can set the `AGY_BIN` environment variable, e.g. `$env:AGY_BIN = "gemini"`)*.
2. Log in with your Google AI Pro account:
   ```bash
   agy auth login
   ```

---

## 2. Setting Up the Bridge

Inside `d:\Projects\Kumo`:

1. Ensure dependencies are installed:
   ```bash
   npm install
   ```
2. Run the test suite:
   ```bash
   npm test
   ```
   You should see all unit tests passing.

---

## 3. Running Your First Orchestrated Task

1. From the repository root (`d:\Projects\Kumo`):
   ```bash
   node ./bin/kumo.js
   # or simply
   kumo
   ```
2. You will be greeted by the Codex CLI session running **ChatGPT 6 Astra** (reasoning effort: `low`).
3. Enter a task request. For example:
   > "Explore the project structure, locate where the bridge server is defined, and create a utility script that validates environment configuration."

### What happens behind the scenes:
1. **Astra** receives your request and decides on the task scope.
2. **Astra** calls `gemini_explore` via MCP to find file paths without bloating Codex context.
3. The bridge launches `agy` in read-only mode with Gemini 3.8 Flash, captures findings, and returns them to Astra.
4. **Astra** analyzes the structure and calls `gemini_implement` with precise specifications to write the utility script.
5. The bridge launches `agy` with workspace write permissions to write the code.
6. **Astra** (or the `reviewer` subagent) reviews the created diff and reports back to you with a summary of actions taken.

---

## 4. Helpful Tips for ChatGPT Plus Users

- **Avoid manual code dumping**: If you have a question about existing files, ask Astra to inspect them using Gemini rather than pasting large code blocks into the chat.
- **Let Gemini write tests**: Astra can instruct Gemini to write and execute unit tests in one command via `gemini_test`.
- **Reviewer Subagent**: To trigger a deep, independent cross-model code review, you can ask Astra:
  > "Please have the reviewer subagent inspect the latest changes for edge cases and security issues."
