/**
 * api-transport.js — Shared HTTP transport module for direct API providers.
 * Supports openai-api, anthropic-api, gemini-api, and compat-api.
 * Zero external dependencies: uses Node >=20 global fetch and AbortSignal.timeout.
 */

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
export function resolveBaseUrl(provider, config = {}) {
  const norm = normalizeProvider(provider);
  const cfg = config || {};

  if (norm === "openai-api") {
    const url =
      (cfg.openaiBaseUrl && cfg.openaiBaseUrl.trim()) ||
      (process.env.OPENAI_BASE_URL && process.env.OPENAI_BASE_URL.trim()) ||
      "https://api.openai.com/v1";
    return url.replace(/\/+$/, "");
  }

  if (norm === "anthropic-api") {
    const url =
      (cfg.anthropicBaseUrl && cfg.anthropicBaseUrl.trim()) ||
      (process.env.ANTHROPIC_BASE_URL && process.env.ANTHROPIC_BASE_URL.trim()) ||
      "https://api.anthropic.com";
    return url.replace(/\/+$/, "");
  }

  if (norm === "gemini-api") {
    const url =
      (cfg.geminiBaseUrl && cfg.geminiBaseUrl.trim()) ||
      (process.env.GEMINI_BASE_URL && process.env.GEMINI_BASE_URL.trim()) ||
      (process.env.GOOGLE_GENERATIVE_AI_BASE_URL && process.env.GOOGLE_GENERATIVE_AI_BASE_URL.trim()) ||
      "https://generativelanguage.googleapis.com";
    return url.replace(/\/+$/, "");
  }

  if (norm === "compat-api") {
    const url =
      (cfg.compatBaseUrl && cfg.compatBaseUrl.trim()) ||
      (process.env.COMPAT_BASE_URL && process.env.COMPAT_BASE_URL.trim());
    if (!url) {
      throw new Error("compat-api requires compatBaseUrl (config.compatBaseUrl or COMPAT_BASE_URL env var)");
    }
    return url.replace(/\/+$/, "");
  }

  throw new Error(`Unknown provider: ${provider}`);
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
  return text;
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
      requestBody.thinking = {
        type: "enabled",
        budget_tokens: 10000,
      };
    }
  } else if (normProvider === "gemini-api") {
    const geminiBase = effectiveBaseUrl.endsWith("/v1beta")
      ? effectiveBaseUrl
      : `${effectiveBaseUrl}/v1beta`;
    url = `${geminiBase}/models/${encodeURIComponent(model.trim())}:generateContent?key=${encodeURIComponent(apiKey)}`;

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
    let res;
    try {
      res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(requestBody),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      if (err instanceof ApiError) {
        throw err;
      }
      if (err.name === "TimeoutError" || err.name === "AbortError") {
        throw new ApiError(provider, 0, `timeout after ${timeoutMs}ms`);
      }
      throw err;
    }

    if (!res.ok) {
      if (res.status === 401 || res.status === 403) {
        const envVar = getKeyEnvVarName(normProvider);
        throw new ApiError(provider, res.status, `Missing or invalid ${envVar}`);
      }

      let errorText = "";
      try {
        const errData = await res.json();
        errorText = errData?.error?.message || errData?.message || JSON.stringify(errData);
      } catch {
        try {
          errorText = await res.text();
        } catch {
          errorText = "";
        }
      }

      const sanitized = sanitizeMessage(errorText, apiKey);
      const msg = sanitized
        ? `HTTP ${res.status}: ${sanitized}`
        : `HTTP ${res.status} ${res.statusText || "Request failed"}`;
      throw new ApiError(provider, res.status, msg);
    }

    const data = await res.json();
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
