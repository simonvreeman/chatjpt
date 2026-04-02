/**
 * ChatJPT — Answer Generation Module
 *
 * Responsible for turning search results into conversational AI answers.
 * This module handles:
 *
 * 1. **Context building**: Formats the top search results into a structured
 *    markdown block that the LLM can reference when generating answers.
 *
 * 2. **Message construction**: Assembles the full chat prompt including the
 *    system prompt, conversation history (up to 3 exchanges), and the current
 *    question with its retrieved context.
 *
 * 3. **Answer generation**: Calls the LLM in either streaming (SSE) or
 *    non-streaming (JSON) mode, with timeout protection.
 *
 * 4. **Source extraction**: Parses the LLM's answer for markdown links and
 *    matches them back to the provided sources for citation display.
 *
 * 5. **Fallback summarization**: When the AI is unavailable or fails, generates
 *    a friendly Dutch-language response pointing to the best keyword match.
 */

import { MAX_CONTEXT_CHARS, AI_TIMEOUT_MS, MODEL, MAX_TOKENS, TEMPERATURE, TYPE_LABELS, withTimeout } from './config.js';
import siteConfig from '../chatjpt.config.mjs';
import systemPromptTemplate from './system-prompt.md';

// ──────────────────────────────────────────────
// Site Identity Constants
// ──────────────────────────────────────────────

/** Brand name used in prompts and fallback messages (e.g., "Cityguys"). */
const SITE_NAME = siteConfig.siteName || siteConfig.site || 'this site';

/** Base URL prepended to relative document paths (e.g., "https://cityguys.nl"). */
const SITE_URL = siteConfig.siteUrl || '';

/** One-line site description included in the LLM system prompt for context. */
const SITE_DESCRIPTION = siteConfig.siteDescription || 'a website';

// ──────────────────────────────────────────────
// System Prompt
// ──────────────────────────────────────────────

/**
 * The compiled system prompt sent to the LLM at the start of every conversation.
 * Built by replacing {{SITE_NAME}} and {{SITE_DESCRIPTION}} placeholders in
 * the template loaded from system-prompt.md.
 *
 * The system prompt defines the LLM's personality (casual, enthusiastic,
 * opinionated like the Cityguys team), language behavior (match query language),
 * citation rules, and constraints (never invent information).
 *
 * See src/system-prompt.md for the full template.
 */
const SYSTEM_PROMPT = systemPromptTemplate
  .replace(/\{\{SITE_NAME\}\}/g, SITE_NAME)
  .replace(/\{\{SITE_DESCRIPTION\}\}/g, SITE_DESCRIPTION);

// ──────────────────────────────────────────────
// Context Building
// ──────────────────────────────────────────────

/**
 * Builds a formatted context block from the top search results for inclusion
 * in the LLM prompt. Also extracts source metadata for citation display.
 *
 * Strategy:
 * - Takes up to 5 results (from the 8 returned by search)
 * - Prioritizes WebPage types over BlogPosting (sorted first)
 * - Divides MAX_CONTEXT_CHARS evenly across results, truncating if needed
 * - Formats each result as a markdown section with:
 *   - Title as H2 heading
 *   - Full URL for citation
 *   - Metadata line: content type label + publication date
 *   - Body text (truncated to per-result budget)
 *
 * @param {Object[]} scoredResults - Search results from retrieval.search(),
 *   each with { document, score, keywordScore, semanticScore }.
 * @returns {{ context: string, sources: Object[] }}
 *   - context: Formatted markdown string for the LLM prompt
 *   - sources: Array of { url, title, type, datePublished } for citation tracking
 */
export function buildContext(scoredResults) {
  // Sort: WebPage types first (more likely to be authoritative), then by score
  const sorted = [...scoredResults].sort((a, b) => {
    const aPage = a.document.type === 'WebPage' ? 1 : 0;
    const bPage = b.document.type === 'WebPage' ? 1 : 0;
    return bPage - aPage || b.score - a.score;
  });

  // Limit to 5 results and divide character budget evenly
  const maxResults = Math.min(sorted.length, 5);
  const perResultBudget = Math.floor(MAX_CONTEXT_CHARS / maxResults);
  let context = '';
  const sources = [];

  for (let i = 0; i < maxResults; i++) {
    const { document } = sorted[i];

    // Truncate body text to fit within per-result character budget
    const text = document.text.length > perResultBudget
      ? document.text.slice(0, perResultBudget) + '...'
      : document.text;

    // Build metadata line: type label + publication date (if available)
    const typeLabel = TYPE_LABELS[document.type] || 'content';
    const date = document.datePublished ? document.datePublished.split('T')[0] : null;
    const meta = [`Type: ${typeLabel}`, date ? `Published: ${date}` : null].filter(Boolean).join(' | ');

    // Format as a markdown section the LLM can reference
    context += `## ${document.name}\nURL: ${SITE_URL}${document.url}\n${meta}\n${text}\n\n`;

    // Track source metadata for citation display in the UI
    sources.push({
      url: `${SITE_URL}${document.url}`,
      title: document.name,
      type: typeLabel,
      datePublished: date,
    });
  }

  return { context, sources };
}

// ──────────────────────────────────────────────
// Fallback Summarization (No AI)
// ──────────────────────────────────────────────

/**
 * Generates a friendly Dutch-language response without using the LLM.
 * Called when the AI is unavailable, times out, or returns an empty response.
 *
 * Two cases:
 * 1. **No results found**: Returns a friendly message in Cityguys tone
 *    suggesting the user try a more specific query.
 * 2. **Results available**: Points the user to the best match with a markdown
 *    link, includes the description, and mentions up to 2 related results.
 *
 * @param {string} query - The user's original question.
 * @param {Object[]} results - Document records from the search index (unscored).
 * @returns {{ answer: string, sources: Object[] }} Fallback response with citations.
 */
export function fallbackSummarize(query, results) {
  if (!results.length) {
    return {
      answer: `Hmm, daar heb ik helaas niks over kunnen vinden op ${SITE_NAME}. Probeer het eens met een specifiekere vraag!`,
      sources: [],
    };
  }

  // Use the top result as the primary recommendation
  const top = results[0];
  const extras = results.slice(1, 3).map((r) => r.name);
  const extraText = extras.length ? ` Gerelateerde resultaten: ${extras.join(' en ')}.` : '';
  return {
    answer: `Check eens [${top.name}](${SITE_URL}${top.url}) — dat is je beste match voor "${query}". ${top.description}${extraText}`,
    sources: results.slice(0, 3).map((r) => ({ url: `${SITE_URL}${r.url}`, title: r.name })),
  };
}

// ──────────────────────────────────────────────
// Message Construction
// ──────────────────────────────────────────────

/**
 * Builds the messages array for the LLM chat completion API.
 *
 * Structure:
 * 1. System message: The personality + rules prompt (from system-prompt.md)
 * 2. Conversation history: Up to 3 previous user/assistant exchanges
 *    (assistant answers truncated to 500 chars to save tokens)
 * 3. Current user message: The retrieved context + the user's question
 *
 * The context is prepended to the user message rather than being a separate
 * system message, because instruction-tuned models tend to pay more attention
 * to user messages for factual grounding.
 *
 * @param {string} query - The current user question.
 * @param {string} context - Formatted context block from buildContext().
 * @param {Object[]} prevExchanges - Previous conversation turns: [{ query, answer }].
 * @returns {Object[]} Array of { role, content } message objects for the LLM.
 */
function buildMessages(query, context, prevExchanges) {
  const messages = [{ role: 'system', content: SYSTEM_PROMPT }];

  // Include up to 3 previous exchanges for conversational continuity
  if (prevExchanges && prevExchanges.length > 0) {
    const recent = prevExchanges.slice(-3);
    for (const exchange of recent) {
      messages.push({ role: 'user', content: exchange.query });
      // Truncate previous answers to save context window space
      const prevAnswer = exchange.answer.length > 500
        ? exchange.answer.slice(0, 500) + '...'
        : exchange.answer;
      messages.push({ role: 'assistant', content: prevAnswer });
    }
  }

  // Current question with retrieved context
  messages.push({ role: 'user', content: `Context from ${SITE_NAME}:\n\n${context}\n\nQuestion: ${query}` });
  return messages;
}

// ──────────────────────────────────────────────
// Source Extraction
// ──────────────────────────────────────────────

/**
 * Extracts which sources the LLM actually cited in its answer.
 *
 * Parses the answer text for markdown links [title](url), then matches them
 * against the provided source list by URL or title. This ensures the UI only
 * shows sources that the answer actually references.
 *
 * Matching logic:
 * - URLs are compared after stripping trailing slashes (normalization)
 * - Titles are compared case-insensitively
 * - If no sources are matched (LLM didn't include any links), falls back to
 *   showing the top 3 sources from the context
 *
 * @param {string} answer - The LLM's generated answer text (may contain markdown links).
 * @param {Object[]} allSources - All sources from buildContext() (the candidate pool).
 * @returns {Object[]} Sources that were actually cited, or top 3 as fallback.
 */
export function extractSources(answer, allSources) {
  const usedUrlSet = new Set();
  const usedTitleSet = new Set();

  // Find all markdown links in the answer: [link text](https://...)
  const linkPattern = /\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g;
  let match;
  while ((match = linkPattern.exec(answer)) !== null) {
    usedUrlSet.add(match[2].replace(/\/$/, ''));     // Normalize: strip trailing slash
    usedTitleSet.add(match[1].toLowerCase());         // Case-insensitive title match
  }

  // Match found links against our source pool
  let usedSources = allSources.filter((s) => {
    const urlNorm = s.url.replace(/\/$/, '');
    if (usedUrlSet.has(urlNorm)) return true;         // URL match
    if (usedTitleSet.has(s.title.toLowerCase())) return true;  // Title match
    return false;
  });

  // Fallback: if the LLM didn't cite any recognized sources, show top 3
  if (usedSources.length === 0) usedSources = allSources.slice(0, 3);
  return usedSources;
}

// ──────────────────────────────────────────────
// Streaming Answer Generation (SSE Mode)
// ──────────────────────────────────────────────

/**
 * Generates an AI answer in streaming mode (Server-Sent Events).
 *
 * This is the primary generation path used by the chat UI. The LLM streams
 * tokens one-by-one via SSE, which the frontend renders in real-time for a
 * typewriter effect.
 *
 * Flow:
 * 1. Build context from search results
 * 2. If no context (no results), return a keyword-based fallback immediately
 * 3. Construct the message array (system prompt + history + context + question)
 * 4. Call the LLM with `stream: true` and return the raw SSE stream
 *
 * The x-session-affinity header hints to Cloudflare to route follow-up
 * requests in the same conversation to the same AI instance, improving
 * response consistency in multi-turn chats.
 *
 * @param {Object} ai - Cloudflare Workers AI binding.
 * @param {string} query - The user's question.
 * @param {Object[]} scoredResults - Search results from retrieval.search().
 * @param {Object[]} prevExchanges - Conversation history.
 * @param {string} sessionId - Unique session/query ID for affinity routing.
 * @returns {Promise<{ stream: ReadableStream|null, fallback?: Object, sources: Object[] }>}
 */
export async function generateStreamingAnswer(ai, query, scoredResults, prevExchanges, sessionId) {
  const { context, sources } = buildContext(scoredResults);

  // No context means no results — return keyword-based fallback
  if (!context.trim()) {
    const fallback = fallbackSummarize(query, scoredResults.map((r) => r.document));
    return { stream: null, fallback };
  }

  const messages = buildMessages(query, context, prevExchanges);

  // Call LLM with streaming enabled; withTimeout guards against hangs
  const response = await withTimeout(
    ai.run(MODEL, {
      messages,
      max_tokens: MAX_TOKENS,
      temperature: TEMPERATURE,
      stream: true,
    }, {
      // Session affinity: Cloudflare routes same-session requests to same instance
      headers: { 'x-session-affinity': sessionId },
    }),
    AI_TIMEOUT_MS,
  );

  return { stream: response, sources };
}

// ──────────────────────────────────────────────
// Non-Streaming Answer Generation (JSON Mode)
// ──────────────────────────────────────────────

/**
 * Generates an AI answer in non-streaming mode (returns complete JSON response).
 *
 * Used for the `summarize` and `generate` API modes. Unlike streaming mode,
 * the entire answer is generated before responding, so the client receives
 * the full text at once.
 *
 * Includes comprehensive error handling:
 * - Empty or malformed LLM responses trigger fallback summarization
 * - API errors or timeouts also trigger fallback
 * - Errors are logged to console for debugging
 *
 * The response format from Cloudflare Workers AI can vary between models,
 * so we check multiple possible response paths:
 * - response.response (standard Workers AI format)
 * - response.result?.response (wrapped format)
 * - response.choices?.[0]?.message?.content (OpenAI-compatible format)
 *
 * @param {Object} ai - Cloudflare Workers AI binding.
 * @param {string} query - The user's question.
 * @param {Object[]} scoredResults - Search results from retrieval.search().
 * @param {Object[]} prevExchanges - Conversation history.
 * @param {string} sessionId - Unique session/query ID.
 * @returns {Promise<{ answer: string, sources: Object[] }>}
 */
export async function generateAnswer(ai, query, scoredResults, prevExchanges, sessionId) {
  const { context, sources } = buildContext(scoredResults);

  // No context = no results → return keyword-based fallback
  if (!context.trim()) {
    return fallbackSummarize(query, scoredResults.map((r) => r.document));
  }

  try {
    const messages = buildMessages(query, context, prevExchanges);

    const response = await withTimeout(
      ai.run(MODEL, {
        messages,
        max_tokens: MAX_TOKENS,
        temperature: TEMPERATURE,
      }, {
        headers: { 'x-session-affinity': sessionId },
      }),
      AI_TIMEOUT_MS,
    );

    // Extract the answer text from the model's response
    // (Cloudflare Workers AI can return in multiple formats)
    const answer = response.response
      || response.result?.response
      || response.choices?.[0]?.message?.content;
    if (!answer || typeof answer !== 'string' || answer.trim().length < 5) {
      throw new Error('Empty or malformed model response');
    }

    return { answer, sources: extractSources(answer, sources) };
  } catch (err) {
    // Log the error and fall back to keyword-based summarization
    console.error('AI generation failed, falling back:', err.message);
    return fallbackSummarize(query, scoredResults.map((r) => r.document));
  }
}
