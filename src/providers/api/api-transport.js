/**
 * api-transport.js — Shared HTTP transport module for direct API providers.
 * Supports openai-api, anthropic-api, gemini-api, and compat-api for text
 * workers (`chatComplete`), and those plus a local Ollama server for leads that
 * call tools (`chatWithTools`).
 * Zero external dependencies: uses Node >=20 global fetch and AbortSignal.timeout.
 */

import { isSafeBaseUrl } from "../../config/settings.js";
import {
  openAiRequest,
  parseOpenAiReply,
  anthropicRequest,
  parseAnthropicReply,
  geminiRequest,
  parseGeminiReply,
} from "./tool-wire.js";

/**
 * Normalizes provider string to canonical format.
 * @param {string} provider
 * @returns {string}
 */
function normalizeProvider(provider) {
  const p = (provider || "").toLowerCase().trim();
  if (p === "openai" || p === "openai-api") return "openai-api";
  if (p === "anthropic" || p === "claude" || p === "anthropic-api") return "anthropic-api";
  if (p === "gemini" || p === "google" || p === "gemini-api") return "gemini-api";
  if (p === "compat" || p === "compat-api") return "compat-api";
  if (p === "ollama") return "ollama";
  return p;
}

/**
 * Returns the primary environment variable name for a provider's API key.
 * @param {string} provider
 * @returns {string}
 */
export function getKeyEnvVarName(provider) {
  const norm = normalizeProvider(provider);
  switch (norm) {
    case "openai-api":
      return "OPENAI_API_KEY";
    case "anthropic-api":
      return "ANTHROPIC_API_KEY";
    case "gemini-api":
      return "GEMINI_API_KEY";
    case "compat-api":
      return "COMPAT_API_KEY";
    default:
      return "API_KEY";
  }
}

/**
 * Retrieves the API key for a provider from process.env.
 * Environment-only, returns string | null, never logs.
 *
 * @param {string} provider
 * @returns {string|null}
 */
export function getApiKey(provider) {
  const norm = normalizeProvider(provider);
  let key = null;
  if (norm === "openai-api") {
    key = process.env.OPENAI_API_KEY;
  } else if (norm === "anthropic-api") {
    key = process.env.ANTHROPIC_API_KEY;
  } else if (norm === "gemini-api") {
    key = process.env.GEMINI_API_KEY || process.env.GOOGLE_GENERATIVE_AI_API_KEY;
  } else if (norm === "compat-api") {
    key = process.env.COMPAT_API_KEY;
  } else {
    return null;
  }

  if (typeof key === "string" && key.trim().length > 0) {
    return key.trim();
  }
  return null;
}

/**
 * Resolves the base URL for a given provider based on config, environment, or default.
 * Priority: config.<name>BaseUrl (non-empty) -> process.env.<NAME>_BASE_URL -> default.
 *
 * @param {string} provider
 * @param {object} [config={}]
 * @returns {string}
 */
export function assertSafeBaseUrl(url) {
  if (!isSafeBaseUrl(url)) {
    throw new Error(
      `Refusing to use base URL '${url}': API keys may only be sent over https, or over plain http to localhost.`
    );
  }
  return url;
}

/**
 * Where Ollama listens, as its own client resolves OLLAMA_HOST: a bare
 * `host:port`, a bare `host` or a full URL, defaulting to http://127.0.0.1:11434.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string | null} null when OLLAMA_HOST is not an address
 */
export function ollamaBaseUrl(env = process.env) {
  const raw = String(env.OLLAMA_HOST ?? "").trim();
  if (!raw) return "http://127.0.0.1:11434";
  try {
    const bare = !raw.includes("://");
    const url = new URL(bare ? `http://${raw}` : raw);
    if (!/^https?:$/.test(url.protocol) || !url.hostname) return null;
    // 0.0.0.0 and :: are where a server binds, not somewhere a client can connect.
    const host = url.hostname.replace(/^\[|\]$/g, "");
    if (host === "0.0.0.0" || host === "::") url.hostname = "127.0.0.1";
    // Ollama's port is the default for a bare host only; a URL without a port
    // means its scheme's. Read from `raw`: URL drops an explicit `:80`.
    if (bare && !/^(\[[^\]]*\]|[^:/]*):\d+/.test(raw)) url.port = "11434";
    return `${url.origin}${url.pathname}`.replace(/\/+$/, "");
  } catch {
    return null;
  }
}

export function resolveBaseUrl(provider, config = {}) {
  const norm = normalizeProvider(provider);
  const cfg = config || {};

  if (norm === "ollama") {
    // Its OpenAI-compatible API. No key is ever sent, so no key-safety rule applies.
    const base = ollamaBaseUrl();
    if (!base) throw new Error("OLLAMA_HOST is not a valid address");
    return `${base}/v1`;
  }

  if (norm === "openai-api") {
    const url =
      (cfg.openaiBaseUrl && cfg.openaiBaseUrl.trim()) ||
      (process.env.OPENAI_BASE_URL && process.env.OPENAI_BASE_URL.trim()) ||
      "https://api.openai.com/v1";
    return assertSafeBaseUrl(url.replace(/\/+$/, ""));
  }

  if (norm === "anthropic-api") {
    const url =
      (cfg.anthropicBaseUrl && cfg.anthropicBaseUrl.trim()) ||
      (process.env.ANTHROPIC_BASE_URL && process.env.ANTHROPIC_BASE_URL.trim()) ||
      "https://api.anthropic.com";
    return assertSafeBaseUrl(url.replace(/\/+$/, ""));
  }

  if (norm === "gemini-api") {
    const url =
      (cfg.geminiBaseUrl && cfg.geminiBaseUrl.trim()) ||
      (process.env.GEMINI_BASE_URL && process.env.GEMINI_BASE_URL.trim()) ||
      (process.env.GOOGLE_GENERATIVE_AI_BASE_URL && process.env.GOOGLE_GENERATIVE_AI_BASE_URL.trim()) ||
      "https://generativelanguage.googleapis.com";
    return assertSafeBaseUrl(url.replace(/\/+$/, ""));
  }

  if (norm === "compat-api") {
    const url =
      (cfg.compatBaseUrl && cfg.compatBaseUrl.trim()) ||
      (process.env.COMPAT_BASE_URL && process.env.COMPAT_BASE_URL.trim());
    if (!url) {
      throw new Error("compat-api requires compatBaseUrl (config.compatBaseUrl or COMPAT_BASE_URL env var)");
    }
    return assertSafeBaseUrl(url.replace(/\/+$/, ""));
  }

  throw new Error(`Unknown provider: ${provider}`);
}

/** Hard ceiling on a response body; a hostile endpoint must not exhaust memory. */
export const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

/**
 * Read a response body as text, refusing anything past MAX_RESPONSE_BYTES.
 *
 * @param {Response} res
 * @returns {Promise<string>}
 */
export async function readBoundedText(res) {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    throw new Error(`Response body of ${declared} bytes exceeds the ${MAX_RESPONSE_BYTES}-byte cap`);
  }
  const text = await res.text();
  if (text.length > MAX_RESPONSE_BYTES) {
    throw new Error(`Response body exceeds the ${MAX_RESPONSE_BYTES}-byte cap`);
  }
  return text;
}

/**
 * Custom error class for API transport failures.
 */
export class ApiError extends Error {
  constructor(provider, status, message) {
    super(message);
    this.name = "ApiError";
    this.provider = provider;
    this.status = status;
  }
}

/**
 * Redacts secret keys or tokens from error messages to prevent leaking secrets.
 * @param {string} message
 * @param {string} [apiKey]
 * @returns {string}
 */
function sanitizeMessage(message, apiKey) {
  if (!message) return "";
  let text = typeof message === "string" ? message : JSON.stringify(message);
  if (apiKey) {
    text = text.replaceAll(apiKey, "[REDACTED]");
  }
  text = text.replace(/(?:sk-|xoxb-|ghp_|gho_)[A-Za-z0-9_-]{10,}/g, "[REDACTED]");
  // Google API keys, GitHub fine-grained tokens, Slack tokens, and whatever
  // follows an Authorization-style `Bearer`.
  text = text.replace(/AIza[0-9A-Za-z_-]{35}/g, "[REDACTED]");
  text = text.replace(/github_pat_[0-9A-Za-z_]+/g, "[REDACTED]");
  text = text.replace(/xox[abprs]-[0-9A-Za-z-]+/g, "[REDACTED]");
  text = text.replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1[REDACTED]");
  return text;
}

/**
 * POST a JSON body and read the JSON reply. The one place that turns a failed
 * request into an {@link ApiError}: timeouts, refused redirects (a redirect
 * would carry the key elsewhere), HTTP errors with the key redacted.
 *
 * @param {object} req
 * @param {string} req.provider - the id the caller used, for the error
 * @param {string} req.normProvider - canonical provider id
 * @param {string} req.url
 * @param {Record<string, string>} req.headers
 * @param {object} req.body
 * @param {string|null} [req.apiKey]
 * @param {number} req.timeoutMs
 * @param {AbortSignal} [req.signal] - the caller's own cancellation, on top of the timeout
 * @returns {Promise<any>}
 */
async function postJson({ provider, normProvider, url, headers, body, apiKey, timeoutMs, signal }) {
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: signal ? AbortSignal.any([AbortSignal.timeout(timeoutMs), signal]) : AbortSignal.timeout(timeoutMs),
      // The fetch spec does NOT strip x-api-key / x-goog-api-key on a
      // cross-origin redirect, so a redirecting endpoint could harvest the key.
      redirect: "manual",
    });
  } catch (err) {
    if (err instanceof ApiError) {
      throw err;
    }
    // The caller's own abort passes through as it is, so it can tell it from a timeout.
    if (signal?.aborted) {
      throw err;
    }
    if (err.name === "TimeoutError" || err.name === "AbortError") {
      throw new ApiError(provider, 0, `timeout after ${timeoutMs}ms`);
    }
    throw err;
  }

  if (res.status >= 300 && res.status < 400) {
    const location = res.headers.get("location") || "(no Location header)";
    throw new ApiError(
      provider,
      res.status,
      `Endpoint attempted to redirect to ${location}; refusing to forward credentials.`
    );
  }

  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      const envVar = getKeyEnvVarName(normProvider);
      throw new ApiError(provider, res.status, `Missing or invalid ${envVar}`);
    }

    let errorText = "";
    try {
      const raw = await readBoundedText(res);
      try {
        const errData = JSON.parse(raw);
        // An error may be a message, or (Ollama) a bare string.
        errorText = errData?.error?.message || (typeof errData?.error === "string" ? errData.error : "") || errData?.message || raw;
      } catch {
        errorText = raw;
      }
    } catch {
      errorText = "";
    }

    const sanitized = sanitizeMessage(errorText, apiKey);
    const msg = sanitized
      ? `HTTP ${res.status}: ${sanitized}`
      : `HTTP ${res.status} ${res.statusText || "Request failed"}`;
    throw new ApiError(provider, res.status, msg);
  }

  const raw = await readBoundedText(res);
  try {
    return JSON.parse(raw);
  } catch {
    // A captive portal or a proxy's page, most often.
    throw new ApiError(provider, 502, `Unusable reply from ${normProvider}: not JSON`);
  }
}

/**
 * Sends a chat completion request to the specified provider.
 *
 * @param {object} options
 * @param {string} options.provider - "openai-api" | "anthropic-api" | "gemini-api" | "compat-api"
 * @param {string} options.model - Target model name
 * @param {string} options.prompt - User prompt text
 * @param {string} [options.systemPrompt] - Optional system prompt
 * @param {string} [options.effort] - "low" | "medium" | "high" | "max"
 * @param {number} [options.timeoutMs=120000] - Request timeout in ms
 * @param {string} [options.baseUrl] - Optional baseUrl override
 * @param {object} [options.config] - Optional configuration object
 * @returns {Promise<{text: string, usage?: {inputTokens?: number, outputTokens?: number}}>}
 */
export function chatComplete({
  provider,
  model,
  prompt,
  systemPrompt,
  effort,
  timeoutMs = 120000,
  baseUrl,
  config,
} = {}) {
  // Empty or missing model throws before fetch
  if (!model || typeof model !== "string" || !model.trim()) {
    throw new ApiError(provider || "unknown", 400, "Model is required");
  }

  const normProvider = normalizeProvider(provider);
  if (!["openai-api", "anthropic-api", "gemini-api", "compat-api"].includes(normProvider)) {
    throw new ApiError(provider || "unknown", 400, `Unknown provider: ${provider}`);
  }

  // Missing key (except keyless compat-api) throws before fetch naming env var
  const apiKey = getApiKey(normProvider);
  if (!apiKey && normProvider !== "compat-api") {
    const envVar = getKeyEnvVarName(normProvider);
    throw new ApiError(provider, 401, `Missing ${envVar}`);
  }

  const effectiveBaseUrl = (baseUrl || resolveBaseUrl(normProvider, config)).replace(/\/+$/, "");

  let url;
  const headers = {
    "Content-Type": "application/json",
  };
  let requestBody;

  if (normProvider === "openai-api" || normProvider === "compat-api") {
    url = `${effectiveBaseUrl}/chat/completions`;
    if (apiKey) {
      headers["Authorization"] = `Bearer ${apiKey}`;
    }

    const messages = [];
    if (systemPrompt && typeof systemPrompt === "string" && systemPrompt.trim()) {
      messages.push({ role: "system", content: systemPrompt });
    }
    messages.push({ role: "user", content: prompt || "" });

    requestBody = {
      model: model.trim(),
      messages,
      max_tokens: 4096,
    };

    const normEffort = (effort || "").toLowerCase().trim();
    if (normEffort === "high" || normEffort === "max") {
      requestBody.reasoning_effort = "high";
    } else if (normEffort === "medium") {
      requestBody.reasoning_effort = "medium";
    }
    // low / unset → reasoning_effort omitted for strict compat servers.
  } else if (normProvider === "anthropic-api") {
    const anthropicBase = effectiveBaseUrl.endsWith("/v1")
      ? effectiveBaseUrl
      : `${effectiveBaseUrl}/v1`;
    url = `${anthropicBase}/messages`;

    headers["x-api-key"] = apiKey;
    headers["anthropic-version"] = "2023-06-01";

    requestBody = {
      model: model.trim(),
      max_tokens: 4096,
      messages: [{ role: "user", content: prompt || "" }],
    };

    if (systemPrompt && typeof systemPrompt === "string" && systemPrompt.trim()) {
      requestBody.system = systemPrompt;
    }

    const normEffort = (effort || "").toLowerCase().trim();
    if (normEffort === "high" || normEffort === "max") {
      const budgetTokens = 10000;
      requestBody.thinking = {
        type: "enabled",
        budget_tokens: budgetTokens,
      };
      // The Messages API rejects budget_tokens >= max_tokens with HTTP 400.
      requestBody.max_tokens = budgetTokens + 4096;
    }
  } else if (normProvider === "gemini-api") {
    const geminiBase = effectiveBaseUrl.endsWith("/v1beta")
      ? effectiveBaseUrl
      : `${effectiveBaseUrl}/v1beta`;
    // Authenticate with the header only: query strings land in proxy logs.
    url = `${geminiBase}/models/${encodeURIComponent(model.trim())}:generateContent`;

    headers["x-goog-api-key"] = apiKey;

    let userText = prompt || "";
    const normEffort = (effort || "").toLowerCase().trim();
    if (normEffort === "high" || normEffort === "max") {
      userText = `${userText}\n\n[Reasoning effort: high]`;
    }

    requestBody = {
      contents: [
        {
          parts: [{ text: userText }],
        },
      ],
    };

    if (systemPrompt && typeof systemPrompt === "string" && systemPrompt.trim()) {
      requestBody.system_instruction = {
        parts: [{ text: systemPrompt }],
      };
    }
  }

  return (async () => {
    const data = await postJson({ provider, normProvider, url, headers, body: requestBody, apiKey, timeoutMs });
    let text = "";
    let usage;

    if (normProvider === "openai-api" || normProvider === "compat-api") {
      text = data.choices?.[0]?.message?.content || "";
      if (
        data.usage &&
        (data.usage.prompt_tokens !== undefined || data.usage.completion_tokens !== undefined)
      ) {
        usage = {
          inputTokens: data.usage.prompt_tokens,
          outputTokens: data.usage.completion_tokens,
        };
      }
    } else if (normProvider === "anthropic-api") {
      if (Array.isArray(data.content)) {
        text = data.content
          .filter((c) => c.type === "text")
          .map((c) => c.text || "")
          .join("");
        if (!text && data.content[0]?.text) {
          text = data.content[0].text;
        }
      }
      if (
        data.usage &&
        (data.usage.input_tokens !== undefined || data.usage.output_tokens !== undefined)
      ) {
        usage = {
          inputTokens: data.usage.input_tokens,
          outputTokens: data.usage.output_tokens,
        };
      }
    } else if (normProvider === "gemini-api") {
      if (Array.isArray(data.candidates?.[0]?.content?.parts)) {
        text = data.candidates[0].content.parts.map((p) => p.text || "").join("");
      }
      if (
        data.usageMetadata &&
        (data.usageMetadata.promptTokenCount !== undefined ||
          data.usageMetadata.candidatesTokenCount !== undefined)
      ) {
        usage = {
          inputTokens: data.usageMetadata.promptTokenCount,
          outputTokens: data.usageMetadata.candidatesTokenCount,
        };
      }
    }

    return { text, usage };
  })();
}

/** Providers a lead can run on: the four HTTP APIs and a local Ollama server. */
const LEAD_PROVIDERS = ["openai-api", "anthropic-api", "gemini-api", "compat-api", "ollama"];

/** A lead's request carries the whole conversation and may wait on a model that thinks first. */
const LEAD_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * One model request of a tool-calling conversation: the messages so far and the
 * tools on offer go in, the model's text and the tool calls it wants made come
 * out. The caller runs the calls and asks again. Not streamed.
 *
 * Unlike {@link chatComplete} (a one-shot text call for a worker) this keeps
 * the provider's tool wire format; see tool-wire.js for the message shapes.
 *
 * @param {object} options
 * @param {string} options.provider - "openai-api" | "anthropic-api" | "gemini-api" | "compat-api" | "ollama"
 * @param {string} options.model
 * @param {string} [options.system] - system prompt
 * @param {import("./tool-wire.js").LeadMessage[]} options.messages
 * @param {import("./tool-wire.js").ToolSpec[]} [options.tools]
 * @param {string} [options.effort] - "low" | "medium" | "high" | "max"
 * @param {number} [options.timeoutMs]
 * @param {AbortSignal} [options.signal] - cancels the request
 * @param {string} [options.baseUrl] - overrides the configured endpoint
 * @param {object} [options.config]
 * @returns {Promise<import("./tool-wire.js").LeadReply>}
 */
export function chatWithTools({
  provider,
  model,
  system,
  messages,
  tools = [],
  effort,
  timeoutMs = LEAD_TIMEOUT_MS,
  signal,
  baseUrl,
  config,
} = /** @type {any} */ ({})) {
  if (!model || typeof model !== "string" || !model.trim()) {
    throw new ApiError(provider || "unknown", 400, "Model is required");
  }
  const normProvider = normalizeProvider(provider);
  if (!LEAD_PROVIDERS.includes(normProvider)) {
    throw new ApiError(provider || "unknown", 400, `Unknown provider: ${provider}`);
  }

  // Ollama and keyless compat servers need no key; the others name the missing variable before any request.
  const apiKey = getApiKey(normProvider);
  if (!apiKey && normProvider !== "compat-api" && normProvider !== "ollama") {
    throw new ApiError(provider, 401, `Missing ${getKeyEnvVarName(normProvider)}`);
  }

  const base = (baseUrl || resolveBaseUrl(normProvider, config)).replace(/\/+$/, "");
  const modelName = model.trim();
  /** @type {Record<string, string>} */
  const headers = { "Content-Type": "application/json" };
  let url;
  let body;
  let parse;

  if (normProvider === "anthropic-api") {
    url = `${base.endsWith("/v1") ? base : `${base}/v1`}/messages`;
    headers["x-api-key"] = /** @type {string} */ (apiKey);
    headers["anthropic-version"] = "2023-06-01";
    body = anthropicRequest({ model: modelName, system, messages, tools, effort });
    parse = parseAnthropicReply;
  } else if (normProvider === "gemini-api") {
    // Authenticate with the header only: query strings land in proxy logs.
    url = `${base.endsWith("/v1beta") ? base : `${base}/v1beta`}/models/${encodeURIComponent(modelName)}:generateContent`;
    headers["x-goog-api-key"] = /** @type {string} */ (apiKey);
    body = geminiRequest({ system, messages, tools, effort });
    parse = parseGeminiReply;
  } else {
    url = `${base}/chat/completions`;
    if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
    body = openAiRequest({ model: modelName, system, messages, tools, effort });
    parse = parseOpenAiReply;
  }

  return (async () => {
    const data = await postJson({ provider, normProvider, url, headers, body, apiKey, timeoutMs, signal });
    try {
      return parse(data);
    } catch (err) {
      throw new ApiError(provider, 502, `Unusable reply from ${normProvider}: ${err instanceof Error ? err.message : err}`);
    }
  })();
}
