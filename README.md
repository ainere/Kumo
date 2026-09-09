# Kumo (雲 / 蜘蛛) — Cross-Provider AI Orchestrator

**Kumo** (Japanese for *cloud* / *spider*) is a modular, standalone CLI application that weaves together flagship AI models across competing providers.

Out of the box, it pairs **ChatGPT 6 Astra** (via Codex CLI on ChatGPT Plus) as the high-level architect/orchestrator and **Gemini 3.8 Flash** (via Google AI Pro on Antigravity / Gemini CLI) as the high-throughput grunt worker — with **zero separate API keys**.

Its provider architecture is open-ended, ready for Anthropic Claude (Claude Code / Sonnet / Opus), OpenAI, Google, and future agents.

---

## Architecture

```
                          You run anywhere:
                              $ kumo
                                │
                                ▼
                 ┌─────────────────────────────┐
                 │       Kumo CLI (雲)         │
                 │   • Dynamic Workspace CWD   │
                 │   • Model / Preset Manager  │
                 │   • Provider Dispatcher     │
                 └──────────────┬──────────────┘
                                │
      ┌─────────────────────────┴─────────────────────────┐
      ▼                                                   ▼
┌───────────────────────────┐               ┌───────────────────────────┐
│   Orchestrator Provider   │               │      Worker Provider      │
│   (Default: Codex / OpenAI│               │  (Default: Gemini / Google│
│     ChatGPT 6 Astra Low)  │ ◄─── [MCP] ──►│     Gemini 3.8 Flash)     │
│   • Task decomposition    │               │   • File exploration      │
│   • Architectural design  │               │   • Code implementation   │
│   • Cross-model review    │               │   • Test generation & runs│
└───────────────────────────┘               └───────────────────────────┘
```

---

## Global Installation

From `d:\Projects\Orchestrator`:

```powershell
npm install
npm link --force
```

Now `kumo` is available globally in any terminal and any directory.

---

## Quick Start & Verification

### 1. Pre-flight Doctor Check
Run `kumo doctor` from any folder to check your subscription tools and bridge:

```powershell
kumo doctor
```

```text
🔍 Running Kumo (雲) Cross-Provider Diagnostics...

  ✅ Node.js:               v25.9.0 (Supported)
  ✅ Codex CLI (OpenAI):    Installed (codex-cli 0.153.4)
  ✅ Gemini CLI (Google):   Installed 'gemini' (0.59.0)
  ✅ MCP Bridge Server:     Bridge initialized successfully with 5 tools registered.

✨ All systems operational! Run 'kumo' in any project to start.
```

### 2. Launch Interactive Orchestration in Any Project

```powershell
cd d:\Projects\AnyRepo
kumo
```

- Connects to your active workspace dynamically.
- Launches the native terminal UI (Option A feel with streaming, diff viewing, and approvals).
- Injects Gemini 3.8 Flash tools (`gemini_explore`, `gemini_implement`, `gemini_test`, etc.).
- Leaves **zero footprint** in your target project.

---

## Model Management (`kumo model`)

Kumo is designed so you can use **any model** for either orchestrator or worker, with curated presets for common subscription tiers:

```powershell
# 1. View active models and presets
kumo model

# 2. Switch Orchestrator model to any model name
kumo model orchestrator chatgpt-6-astra low
# Or Sol:
kumo model orchestrator chatgpt-5.6-sol low

# 3. Switch Worker model to any model name
kumo model worker gemini-3.8-flash
# Or 3.7:
kumo model worker gemini-3.7-flash

# 4. Apply a curated preset
kumo model use pro       # Astra Medium + Gemini 3.8 Flash
kumo model use speed     # Sol + Gemini 3.8 Flash
kumo model use default   # Astra Low + Gemini 3.8 Flash (ChatGPT Plus optimized)
```

---

## Command Reference

| Command | Description |
|---|---|
| `kumo` | Start interactive cross-provider session in current folder |
| `kumo -d <path>` | Start interactive session targeting a specific folder |
| `kumo run "<prompt>"` | Execute a single task non-interactively across providers |
| `kumo model` | Inspect or switch orchestrator/worker models and presets |
| `kumo model orchestrator <model> [effort]` | Set orchestrator model (accepts any model string) |
| `kumo model worker <model>` | Set worker model (accepts any model string) |
| `kumo model use <preset>` | Apply a preset (`default`, `pro`, `speed`, `gemini-3.7`) |
| `kumo doctor` | Diagnostics: verify subscription auth, CLIs, and bridge health |
| `kumo config list` | View all global configuration settings (`~/.kumo/config.json`) |
| `kumo config set <key> <val>` | Update any configuration value |
| `kumo config reset` | Reset configuration to defaults |
| `kumo init` | (Optional) Scaffold project guidelines (`AGENTS.md`, `GEMINI.md`) into current directory |

---

## Open-Ended Provider Extensibility

The codebase is organized into modular provider adapters:
- **Orchestrators** ([`src/providers/orchestrators/`](file:///d:/Projects/Orchestrator/src/providers/orchestrators/)):
  - `codex.js`: OpenAI Codex CLI launcher with dynamic MCP injection.
  - `registry.js`: Provider lookup table. Adding Anthropic Claude Code is as simple as adding `claude.js` implementing `{ launch, buildInvocation }`!
- **Workers** ([`src/providers/workers/`](file:///d:/Projects/Orchestrator/src/providers/workers/)):
  - `gemini.js`: Google Gemini adapter via MCP bridge.
  - `registry.js`: Worker lookup table for future worker providers.
- **MCP Bridge** ([`src/bridge/`](file:///d:/Projects/Orchestrator/src/bridge/)):
  - `prompts.js`: System prompts for `explore`, `implement`, `test`, `research`, `review`.
  - `agy-runner.js`: Cross-platform worker subprocess runner.
