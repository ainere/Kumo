/**
 * tool-wire.js — Tool-calling wire formats of the direct-API providers.
 *
 * Pure functions, no I/O: they turn one provider-neutral conversation into the
 * request body of OpenAI-compatible Chat Completions (openai-api, compat-api,
 * ollama), the Anthropic Messages API or Gemini generateContent, and read the
 * reply back into one neutral shape. The transport (api-transport.js) sends
 * the bodies; the lead loop (api-lead.js) owns the conversation.
 *
 * @typedef {{ name: string, description?: string, inputSchema?: Record<string, any> }} ToolSpec
 *
 * @typedef {{ id: string, name: string, args: Record<string, any>, argsError?: string, synthetic?: boolean }} ToolCall
 * `synthetic`: the provider sent no id, so Kumo made one up; it is never echoed back.
 *
 * @typedef {{ id: string, name: string, text: string, isError?: boolean, synthetic?: boolean }} ToolResult
 *
 * @typedef {{ role: "user", text: string, turnStart?: boolean }
 *   | { role: "assistant", text: string, toolCalls?: ToolCall[], wire?: { format: string, content: any } }
 *   | { role: "tool", results: ToolResult[] }} LeadMessage
 * `wire`: the assistant message exactly as its provider sent it (Anthropic
 * thinking blocks and Gemini thought signatures must come back unchanged),
 * used only when the conversation goes to the same wire format again.
 *
 * @typedef {{
 *   text: string,
 *   reasoning: string,
 *   toolCalls: ToolCall[],
 *   stopReason: "end" | "tool_use" | "max_tokens" | "filtered",
 *   usage?: { inputTokens?: number, outputTokens?: number },
 *   wire?: { format: string, content: any },
 * }} LeadReply
 */

import { randomUUID } from "node:crypto";

/** Output ceiling of a lead request on the wires that require one (Anthropic). */
export const LEAD_MAX_TOKENS = 8192;

/** Thinking budget at high effort, as the text path uses it. */
const THINKING_BUDGET_TOKENS = 10000;

const normEffort = (effort) => (effort || "").toLowerCase().trim();
const isHighEffort = (effort) => ["high", "max"].includes(normEffort(effort));

const newCallId = () => `call_${randomUUID().replaceAll("-", "").slice(0, 24)}`;

/** A tool result's text, never empty: several providers reject an empty one. */
const resultText = (r) => (r.text && r.text.length > 0 ? r.text : "(no output)");

/**
 * A tool's JSON Schema as the providers take it: an object schema without the
 * `$schema` marker the MCP SDK adds.
 *
 * @param {Record<string, any>|undefined} schema
 */
function objectSchema(schema) {
  const { $schema: _marker, ...rest } = schema && typeof schema === "object" ? schema : {};
  return { type: "object", ...rest };
}

/** Schema keywords Gemini's function declarations accept. */
const GEMINI_SCHEMA_KEYS = new Set([
  "type", "format", "description", "nullable", "enum", "items", "properties", "required",
  "minimum", "maximum", "minItems", "maxItems", "anyOf", "title",
]);

/**
 * A JSON Schema reduced to what Gemini accepts: it rejects keywords such as
 * `additionalProperties` and `$schema` outright instead of ignoring them.
 *
 * @param {any} schema
 * @returns {any}
 */
export function geminiSchema(schema) {
  if (Array.isArray(schema)) return schema.map(geminiSchema);
  if (!schema || typeof schema !== "object") return schema;
  const out = {};
  for (const [key, value] of Object.entries(schema)) {
    if (!GEMINI_SCHEMA_KEYS.has(key)) continue;
    if (key === "properties" && value && typeof value === "object") {
      out.properties = Object.fromEntries(Object.entries(value).map(([name, prop]) => [name, geminiSchema(prop)]));
    } else if (key === "type" && Array.isArray(value)) {
      // ["string", "null"] becomes a nullable string.
      const types = value.filter((t) => t !== "null");
      out.type = types[0] || "string";
      if (types.length !== value.length) out.nullable = true;
    } else {
      out[key] = key === "items" || key === "anyOf" ? geminiSchema(value) : value;
    }
  }
  return out;
}

/**
 * Tool-call arguments as the model wrote them: a JSON string (OpenAI wire), an
 * object (the other wires, Ollama) or nothing.
 *
 * @param {unknown} raw
 * @returns {{ args: Record<string, any>, argsError?: string }}
 */
function parseArgs(raw) {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return { args: /** @type {any} */ (raw) };
  if (raw === undefined || raw === null || raw === "") return { args: {} };
  try {
    const value = JSON.parse(String(raw));
    if (value && typeof value === "object" && !Array.isArray(value)) return { args: value };
    return { args: {}, argsError: "the arguments must be a JSON object" };
  } catch (err) {
    return { args: {}, argsError: `the arguments are not valid JSON (${err instanceof Error ? err.message : err})` };
  }
}

// ── OpenAI-compatible Chat Completions ──

/**
 * @param {{ model: string, system?: string, messages: LeadMessage[], tools?: ToolSpec[], effort?: string }} req
 */
export function openAiRequest({ model, system, messages, tools = [], effort }) {
  /** @type {any[]} */
  const out = [];
  if (system) out.push({ role: "system", content: system });
  for (const m of messages) {
    if (m.role === "user") {
      out.push({ role: "user", content: m.text });
    } else if (m.role === "assistant") {
      /** @type {any} */
      const msg = { role: "assistant", content: m.text || "" };
      if (m.toolCalls?.length) {
        msg.tool_calls = m.toolCalls.map((c) => ({
          id: c.id,
          type: "function",
          function: { name: c.name, arguments: JSON.stringify(c.args ?? {}) },
        }));
      }
      out.push(msg);
    } else {
      for (const r of m.results) out.push({ role: "tool", tool_call_id: r.id, content: resultText(r) });
    }
  }

  // No max_tokens: newer OpenAI models refuse it for max_completion_tokens, and
  // compat servers differ; the server's own default ends an answer well enough.
  /** @type {any} */
  const body = { model, messages: out };
  if (tools.length > 0) {
    // No tool_choice: Ollama's compatibility layer rejects it, and "auto" is the default.
    body.tools = tools.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description || "", parameters: objectSchema(t.inputSchema) },
    }));
  }
  const level = normEffort(effort);
  if (level === "high" || level === "max") body.reasoning_effort = "high";
  else if (level === "medium") body.reasoning_effort = "medium";
  return body;
}

/** @param {any} data @returns {LeadReply} */
export function parseOpenAiReply(data) {
  const choice = data?.choices?.[0];
  const message = choice?.message;
  if (!message) throw new Error("the reply has no message");

  let text = "";
  if (typeof message.content === "string") text = message.content;
  else if (Array.isArray(message.content)) {
    text = message.content.map((p) => (typeof p?.text === "string" ? p.text : "")).join("");
  }
  if (!text && typeof message.refusal === "string") text = message.refusal;
  // Reasoning models behind compatible servers report their thinking in one of these.
  const reasoning = [message.reasoning_content, message.reasoning].find((r) => typeof r === "string" && r) || "";

  /** @type {ToolCall[]} */
  const toolCalls = (Array.isArray(message.tool_calls) ? message.tool_calls : []).map((c) => {
    const synthetic = typeof c?.id !== "string" || !c.id;
    return {
      id: synthetic ? newCallId() : c.id,
      name: String(c?.function?.name ?? ""),
      ...parseArgs(c?.function?.arguments),
      ...(synthetic ? { synthetic: true } : {}),
    };
  });

  const finish = choice.finish_reason;
  /** @type {LeadReply["stopReason"]} */
  let stopReason = "end";
  if (toolCalls.length > 0) stopReason = "tool_use";
  else if (finish === "length") stopReason = "max_tokens";
  else if (finish === "content_filter") stopReason = "filtered";

  const u = data.usage;
  const usage =
    u && (u.prompt_tokens !== undefined || u.completion_tokens !== undefined)
      ? { inputTokens: u.prompt_tokens, outputTokens: u.completion_tokens }
      : undefined;
  return { text, reasoning, toolCalls, stopReason, usage };
}

// ── Anthropic Messages ──

/**
 * @param {{ model: string, system?: string, messages: LeadMessage[], tools?: ToolSpec[], effort?: string }} req
 */
export function anthropicRequest({ model, system, messages, tools = [], effort }) {
  const thinking = isHighEffort(effort);
  /** @type {any[]} */
  const out = [];
  for (const m of messages) {
    if (m.role === "user") {
      out.push({ role: "user", content: m.text });
    } else if (m.role === "assistant") {
      /** @type {any[]} */
      let content;
      if (m.wire?.format === "anthropic" && Array.isArray(m.wire.content)) {
        // Thinking blocks go back as received, and only while thinking is on.
        content = m.wire.content.filter((b) => thinking || (b?.type !== "thinking" && b?.type !== "redacted_thinking"));
      } else {
        content = [];
        if (m.text) content.push({ type: "text", text: m.text });
        for (const c of m.toolCalls || []) content.push({ type: "tool_use", id: c.id, name: c.name, input: c.args ?? {} });
      }
      if (content.length > 0) out.push({ role: "assistant", content });
    } else {
      out.push({
        role: "user",
        content: m.results.map((r) => ({
          type: "tool_result",
          tool_use_id: r.id,
          content: resultText(r),
          ...(r.isError ? { is_error: true } : {}),
        })),
      });
    }
  }

  /** @type {any} */
  const body = { model, max_tokens: LEAD_MAX_TOKENS, messages: out };
  if (system) body.system = system;
  if (tools.length > 0) {
    body.tools = tools.map((t) => ({
      name: t.name,
      description: t.description || "",
      input_schema: objectSchema(t.inputSchema),
    }));
  }
  if (thinking) {
    body.thinking = { type: "enabled", budget_tokens: THINKING_BUDGET_TOKENS };
    // The Messages API rejects budget_tokens >= max_tokens with HTTP 400.
    body.max_tokens = THINKING_BUDGET_TOKENS + LEAD_MAX_TOKENS;
  }
  return body;
}

/** @param {any} data @returns {LeadReply} */
export function parseAnthropicReply(data) {
  if (!Array.isArray(data?.content)) throw new Error("the reply has no content");
  let text = "";
  let reasoning = "";
  /** @type {ToolCall[]} */
  const toolCalls = [];
  for (const block of data.content) {
    if (block?.type === "text") text += block.text || "";
    else if (block?.type === "thinking") reasoning += block.thinking || "";
    else if (block?.type === "tool_use") {
      toolCalls.push({
        id: String(block.id || newCallId()),
        name: String(block.name ?? ""),
        ...parseArgs(block.input),
        ...(block.id ? {} : { synthetic: true }),
      });
    }
  }

  /** @type {LeadReply["stopReason"]} */
  let stopReason = "end";
  if (toolCalls.length > 0 || data.stop_reason === "tool_use") stopReason = "tool_use";
  else if (data.stop_reason === "max_tokens") stopReason = "max_tokens";
  else if (data.stop_reason === "refusal") stopReason = "filtered";

  const u = data.usage;
  const usage =
    u && (u.input_tokens !== undefined || u.output_tokens !== undefined)
      ? { inputTokens: u.input_tokens, outputTokens: u.output_tokens }
      : undefined;
  return { text, reasoning, toolCalls, stopReason, usage, wire: { format: "anthropic", content: data.content } };
}

// ── Gemini generateContent ──

/**
 * @param {{ system?: string, messages: LeadMessage[], tools?: ToolSpec[], effort?: string }} req
 */
export function geminiRequest({ system, messages, tools = [], effort }) {
  /** @type {any[]} */
  const contents = [];
  for (const m of messages) {
    if (m.role === "user") {
      contents.push({ role: "user", parts: [{ text: m.text }] });
    } else if (m.role === "assistant") {
      /** @type {any[]} */
      let parts;
      if (m.wire?.format === "gemini" && Array.isArray(m.wire.content)) {
        parts = m.wire.content;
      } else {
        parts = [];
        if (m.text) parts.push({ text: m.text });
        for (const c of m.toolCalls || []) parts.push({ functionCall: { name: c.name, args: c.args ?? {} } });
      }
      if (parts.length > 0) contents.push({ role: "model", parts });
    } else {
      contents.push({
        role: "user",
        parts: m.results.map((r) => ({
          functionResponse: {
            ...(r.synthetic ? {} : { id: r.id }),
            name: r.name,
            response: r.isError ? { error: resultText(r) } : { output: resultText(r) },
          },
        })),
      });
    }
  }

  /** @type {any} */
  const body = { contents };
  // The text path asks for effort in the prompt; here it rides with the instruction.
  const instruction = [system, isHighEffort(effort) ? "[Reasoning effort: high]" : ""].filter(Boolean).join("\n\n");
  if (instruction) body.system_instruction = { parts: [{ text: instruction }] };
  if (tools.length > 0) {
    body.tools = [
      {
        functionDeclarations: tools.map((t) => {
          const parameters = geminiSchema(objectSchema(t.inputSchema));
          return {
            name: t.name,
            description: t.description || "",
            // An object schema without properties is refused.
            ...(parameters.properties && Object.keys(parameters.properties).length > 0 ? { parameters } : {}),
          };
        }),
      },
    ];
  }
  return body;
}

/** @param {any} data @returns {LeadReply} */
export function parseGeminiReply(data) {
  const candidate = data?.candidates?.[0];
  if (!candidate) {
    const blocked = data?.promptFeedback?.blockReason;
    throw new Error(blocked ? `the prompt was blocked (${blocked})` : "the reply has no candidate");
  }
  const parts = Array.isArray(candidate.content?.parts) ? candidate.content.parts : [];
  let text = "";
  let reasoning = "";
  /** @type {ToolCall[]} */
  const toolCalls = [];
  for (const part of parts) {
    if (part?.functionCall) {
      const fc = part.functionCall;
      toolCalls.push({
        id: typeof fc.id === "string" && fc.id ? fc.id : newCallId(),
        name: String(fc.name ?? ""),
        ...parseArgs(fc.args),
        ...(typeof fc.id === "string" && fc.id ? {} : { synthetic: true }),
      });
    } else if (typeof part?.text === "string") {
      if (part.thought === true) reasoning += part.text;
      else text += part.text;
    }
  }

  const finish = candidate.finishReason;
  if (finish === "MALFORMED_FUNCTION_CALL" && toolCalls.length === 0) {
    throw new Error("the model wrote a malformed tool call");
  }
  /** @type {LeadReply["stopReason"]} */
  let stopReason = "end";
  if (toolCalls.length > 0) stopReason = "tool_use";
  else if (finish === "MAX_TOKENS") stopReason = "max_tokens";
  else if (finish && !["STOP", "FINISH_REASON_UNSPECIFIED"].includes(finish)) stopReason = "filtered";

  const u = data.usageMetadata;
  const usage =
    u && (u.promptTokenCount !== undefined || u.candidatesTokenCount !== undefined)
      ? { inputTokens: u.promptTokenCount, outputTokens: u.candidatesTokenCount }
      : undefined;
  return { text, reasoning, toolCalls, stopReason, usage, wire: { format: "gemini", content: parts } };
}
