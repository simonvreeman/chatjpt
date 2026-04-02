/**
 * ChatJPT — Centralized Configuration Constants
 *
 * This module acts as the single source of truth for all runtime configuration
 * used across the ChatJPT application. It imports settings from the root-level
 * `chatjpt.config.mjs` file and re-exports them as named constants with sensible
 * defaults, so the rest of the codebase never needs to handle missing config values.
 *
 * Why a separate config module?
 * - Provides compile-time defaults if a config key is missing.
 * - Keeps imports clean: other modules import from './config.js' rather than
 *   reaching up to '../chatjpt.config.mjs'.
 * - Houses the `withTimeout` utility, which is used by both retrieval and
 *   generation modules to guard against slow AI responses.
 */

import siteConfig from '../chatjpt.config.mjs';

// ──────────────────────────────────────────────
// Context & Query Limits
// ──────────────────────────────────────────────

/**
 * Maximum number of characters of retrieved content to include in the LLM prompt.
 * This budget is divided equally across the top results (see generation.js).
 * Higher values give the LLM more context but increase latency and token cost.
 */
export const MAX_CONTEXT_CHARS = siteConfig.maxContextChars || 10000;

/**
 * Maximum allowed length for user queries (in characters).
 * Queries exceeding this limit are silently truncated in normalizeRequest().
 * Prevents abuse and keeps embedding costs predictable.
 */
export const MAX_QUERY_LENGTH = siteConfig.maxQueryLength || 500;

/**
 * Timeout (in milliseconds) for individual AI API calls (embedding + generation).
 * If the Cloudflare Workers AI backend doesn't respond within this window,
 * the request is aborted and the system falls back to keyword-based summarization.
 */
export const AI_TIMEOUT_MS = siteConfig.aiTimeoutMs || 10000;

// ──────────────────────────────────────────────
// AI Model Identifiers
// ──────────────────────────────────────────────

/**
 * The Cloudflare Workers AI chat/completion model used for answer generation.
 * Default: Meta Llama 3.3 70B (FP8 quantized, optimized for speed).
 * This model receives the system prompt, conversation history, and retrieved
 * context, then generates a conversational answer.
 */
export const MODEL = siteConfig.chatModel || '@cf/meta/llama-3.3-70b-instruct-fp8-fast';

/**
 * The embedding model used to convert queries and documents into 768-dimensional
 * vectors for semantic similarity search.
 * Default: BAAI BGE Base EN v1.5 — a compact, high-quality English embedding model.
 * Despite being English-focused, it works well for Dutch text in practice.
 */
export const EMBEDDING_MODEL = siteConfig.embeddingModel || '@cf/baai/bge-base-en-v1.5';

// ──────────────────────────────────────────────
// Generation Parameters
// ──────────────────────────────────────────────

/**
 * Maximum number of tokens the LLM may generate per response.
 * 512 tokens ≈ 350–400 words, which is enough for concise, link-rich answers.
 */
export const MAX_TOKENS = siteConfig.maxTokens || 512;

/**
 * Controls the randomness/creativity of LLM responses.
 * 0.0 = deterministic (always the most likely token)
 * 1.0 = very creative (more variation, higher hallucination risk)
 * 0.3 = slightly creative — gives natural-sounding answers while staying factual.
 */
export const TEMPERATURE = siteConfig.temperature || 0.3;

// ──────────────────────────────────────────────
// Display Labels
// ──────────────────────────────────────────────

/**
 * Maps schema.org content types to human-readable Dutch labels.
 * Used in the context block sent to the LLM (e.g., "Type: artikel")
 * and potentially in the UI to describe result types.
 */
export const TYPE_LABELS = siteConfig.typeLabels || {
  'WebPage': 'pagina',
  'BlogPosting': 'artikel',
  'VideoObject': 'video',
};

// ──────────────────────────────────────────────
// Utility Functions
// ──────────────────────────────────────────────

/**
 * Wraps a promise with a timeout. If the promise doesn't resolve within `ms`
 * milliseconds, the returned promise rejects with an "AI request timed out" error.
 *
 * Used to guard Cloudflare Workers AI calls (both embeddings and chat completion)
 * against hanging requests. When a timeout fires, the calling code typically
 * falls back to keyword-based summarization (see generation.js).
 *
 * @param {Promise} promise - The async operation to wrap (e.g., ai.run()).
 * @param {number} ms - Timeout duration in milliseconds.
 * @returns {Promise} Resolves with the original value, or rejects on timeout.
 *
 * @example
 *   const result = await withTimeout(ai.run(MODEL, { messages }), 10000);
 */
export function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('AI request timed out')), ms);
    promise.then(
      (val) => { clearTimeout(timer); resolve(val); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}
