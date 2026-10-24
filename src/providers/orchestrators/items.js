/**
 * items.js — Provider-neutral helpers for orchestrator item events.
 *
 * Every orchestrator client emits `item_started` / `item_completed` with an
 * `item` object, but each CLI names tool calls differently. Codex app-server
 * reports MCP calls as `type: "mcpToolCall"` with `server` and `tool` fields
 * (see `codex app-server generate-json-schema`); the Antigravity adapter emits
 * `mcp_tool_call` with `name`. Consumers ask these helpers instead of matching
 * type strings themselves, which is how the REPL used to miss every Codex call.
 */

/** Item types that represent a tool invocation, across providers. */
export const TOOL_CALL_ITEM_TYPES = new Set([
  "mcpToolCall",
  "dynamicToolCall",
  "mcp_tool_call",
  "dynamic_tool_call",
  "tool_call",
]);

/**
 * True when an orchestrator item is a tool call.
 *
 * @param {{type?: string}|null|undefined} item
 * @returns {boolean}
 */
export function isToolCallItem(item) {
  return Boolean(item && TOOL_CALL_ITEM_TYPES.has(item.type));
}

/**
 * Display name of a tool-call item (`worker_explore`, …).
 *
 * @param {{name?: string, tool?: string}} item
 * @returns {string}
 */
export function toolNameOf(item) {
  return (item && (item.name || item.tool)) || "tool";
}

/**
 * Parsed arguments of a tool-call item. Providers send either an object or a
 * JSON string; anything unparseable comes back as `{}`.
 *
 * @param {{arguments?: unknown, input?: unknown}} item
 * @returns {Record<string, unknown>}
 */
export function toolArgsOf(item) {
  const raw = item?.arguments ?? item?.input ?? null;
  if (raw && typeof raw === "object") return raw;
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
}
