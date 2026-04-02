/**
 * ChatJPT — Cloudflare Worker Entry Point
 *
 * This is the main request handler for the ChatJPT application, deployed as a
 * Cloudflare Worker. It handles three types of requests:
 *
 * 1. **Chat UI** (`GET /chatjpt`): Serves the self-contained HTML chat interface
 * 2. **API endpoint** (`GET/POST /chatjpt/ask`): Processes Q&A queries
 * 3. **CORS preflight** (`OPTIONS`): Returns appropriate CORS headers
 *
 * The API endpoint supports multiple response modes:
 * - `stream` (default): Server-Sent Events (SSE) for real-time token-by-token display
 * - `summarize` / `generate`: Full JSON response with complete answer
 * - `list`: Returns search results only (no AI generation)
 *
 * Request flow:
 *   1. normalizeRequest() extracts and validates parameters from GET query or POST body
 *   2. augmentQuery() adds context from conversation history for follow-up questions
 *   3. embedQuery() converts the query to a vector embedding via Workers AI
 *   4. search() performs hybrid keyword + semantic search over the index
 *   5. generateStreamingAnswer() or generateAnswer() calls the LLM
 *   6. Response is returned as SSE stream or JSON
 *
 * The Worker requires a Workers AI binding named `AI` (configured in wrangler.toml).
 * If the AI binding is unavailable, the system falls back to keyword-based summarization.
 */

import config from '../chatjpt.config.mjs';
import chatjptIndex from './generated/chatjpt-index.mjs';
import { MAX_QUERY_LENGTH, AI_TIMEOUT_MS, MODEL } from './config.js';
import { search, embedQuery, augmentQuery } from './retrieval.js';
import {
  generateStreamingAnswer, generateAnswer,
  fallbackSummarize, extractSources,
} from './generation.js';
import { chatPage } from './ui.js';

// ──────────────────────────────────────────────
// CORS Configuration
// ──────────────────────────────────────────────

/**
 * CORS headers applied to all API responses.
 * Uses wildcard origin ('*') to allow requests from any domain.
 * This is intentional — the API is public and has no authentication.
 */
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// ──────────────────────────────────────────────
// Response Helpers
// ──────────────────────────────────────────────

/**
 * Creates a JSON Response with CORS headers and pretty-printed body.
 *
 * @param {Object} body - Response payload (will be JSON-stringified).
 * @param {number} [status=200] - HTTP status code.
 * @returns {Response} Cloudflare Workers Response object.
 */
function json(body, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json; charset=utf-8' },
  });
}

// ──────────────────────────────────────────────
// Request Normalization
// ──────────────────────────────────────────────

/**
 * Extracts and normalizes request parameters from either GET query string
 * or POST JSON body, providing a unified interface for the handler.
 *
 * Supports both `query` and `q` as parameter names (for convenience).
 * POST body takes precedence over query parameters when both are present.
 *
 * Parameters:
 * - `query` / `q`: The user's search query (truncated to MAX_QUERY_LENGTH chars)
 * - `mode`: Response mode — "stream" (SSE), "summarize", "generate", or "list"
 * - `site`: Target site identifier (defaults to config.site)
 * - `prev`: JSON string of previous conversation exchanges (truncated to 10KB)
 * - `decontextualized_query`: Pre-processed query that overrides the raw query
 *   for search (allows external systems to provide a cleaner query)
 * - `query_id`: Unique identifier for this query (auto-generated UUID if not provided)
 * - `debug`: When true, includes timing metrics and retrieval details in response
 *
 * @param {Request} request - The incoming Cloudflare Workers Request.
 * @returns {Promise<Object>} Normalized parameter object.
 * @throws {Error} If the POST body contains invalid JSON.
 */
async function normalizeRequest(request) {
  const url = new URL(request.url);
  const query = url.searchParams;
  let body = {};

  // Parse JSON body for non-GET requests with application/json content type
  if (request.method !== 'GET' && request.headers.get('content-type')?.includes('application/json')) {
    try {
      body = await request.json();
    } catch {
      throw new Error('Invalid JSON body');
    }
  }

  return {
    // User's question — support both 'query' and 'q' as parameter names
    query: String(body.query || body.q || query.get('query') || query.get('q') || '').slice(0, MAX_QUERY_LENGTH),
    // Response format: stream (SSE), summarize, generate, or list
    mode: body.mode || query.get('mode') || 'stream',
    // Site identifier (for multi-site support)
    site: body.site || query.get('site') || config.site,
    // Previous conversation exchanges as JSON string (for multi-turn context)
    prev: String(body.prev || query.get('prev') || '').slice(0, 10000),
    // Pre-processed query from external system (overrides raw query for search)
    decontextualized_query: String(body.decontextualized_query || query.get('decontextualized_query') || '').slice(0, MAX_QUERY_LENGTH),
    // Unique query identifier for tracking and session affinity
    query_id: body.query_id || query.get('query_id') || crypto.randomUUID(),
    // Debug mode: include timing metrics and retrieval details
    debug: body.debug || query.get('debug') === 'true',
  };
}

// ──────────────────────────────────────────────
// SSE Stream Handler
// ──────────────────────────────────────────────

/**
 * Processes the AI's streaming response and forwards it to the client as
 * Server-Sent Events (SSE).
 *
 * This function runs asynchronously (fire-and-forget IIFE) so the Response
 * can be returned to the client immediately while tokens are still being
 * generated. The client receives a readable stream that emits:
 *
 * - `data: {"token": "..."}` — Individual tokens as they're generated
 * - `data: {"sources": [...], "done": true}` — Final message with source citations
 * - `data: {"fallback": "...", "sources": [...], "done": true}` — Fallback if AI
 *   response was too short (< 5 chars)
 * - `data: {"error": "...", "done": true}` — Error message if something went wrong
 *
 * Includes a safety timeout (3× AI_TIMEOUT_MS) to ensure the stream always
 * closes, even if the AI hangs mid-response.
 *
 * @param {ReadableStream} stream - The raw SSE stream from Cloudflare Workers AI.
 * @param {Object[]} sources - Source metadata for citation display.
 * @param {string} query - The user's original query (for fallback generation).
 * @param {Object[]} scoredResults - Search results (for fallback generation).
 * @param {WritableStreamDefaultWriter} writer - The writable side of the TransformStream.
 * @param {TextEncoder} encoder - Encoder for converting strings to Uint8Array.
 */
function handleStreamingResponse(stream, sources, query, scoredResults, writer, encoder) {
  (async () => {
    let fullAnswer = '';

    // Safety timeout: close the stream if the AI takes too long
    // Uses 3× the normal timeout to allow for slow but still-producing streams
    const streamTimeout = setTimeout(async () => {
      try {
        const msg = fullAnswer
          ? 'Response was cut short due to a timeout.'
          : 'The AI took too long to respond. Please try again.';
        await writer.write(encoder.encode(`data: ${JSON.stringify({ error: msg, done: true })}\n\n`));
        await writer.close();
      } catch { /* Stream already closed */ }
    }, AI_TIMEOUT_MS * 3);

    try {
      // Read from the AI's SSE stream
      const reader = stream.getReader ? stream.getReader() : null;
      if (reader) {
        const decoder = new TextDecoder();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          // Decode the chunk (may be string or Uint8Array depending on runtime)
          const chunk = typeof value === 'string' ? value : decoder.decode(value, { stream: true });

          // Parse SSE lines: each line starting with "data: " contains a JSON payload
          const lines = chunk.split('\n');
          for (const line of lines) {
            if (line.startsWith('data: ')) {
              const data = line.slice(6);
              if (data === '[DONE]') continue; // OpenAI-style stream terminator
              try {
                const parsed = JSON.parse(data);
                // Extract the token from the response (supports multiple AI response formats)
                const token = parsed.response || parsed.choices?.[0]?.delta?.content || '';
                if (token) {
                  fullAnswer += token;
                  // Forward the token to the client
                  await writer.write(encoder.encode(`data: ${JSON.stringify({ token })}\n\n`));
                }
              } catch {
                // Non-JSON data line (e.g., empty line, comment) — skip silently
              }
            }
          }
        }
      }

      // Stream completed successfully — clear the safety timeout
      clearTimeout(streamTimeout);

      // Check if the AI produced a meaningful answer
      if (fullAnswer.trim().length < 5) {
        // Answer too short — use keyword-based fallback instead
        const fallback = fallbackSummarize(query, scoredResults.map((r) => r.document));
        await writer.write(encoder.encode(`data: ${JSON.stringify({ fallback: fallback.answer, sources: fallback.sources, done: true })}\n\n`));
      } else {
        // Good answer — extract which sources were actually cited
        const usedSources = extractSources(fullAnswer, sources);
        await writer.write(encoder.encode(`data: ${JSON.stringify({ sources: usedSources, done: true })}\n\n`));
      }
    } catch (err) {
      clearTimeout(streamTimeout);
      // Send error to client
      await writer.write(encoder.encode(`data: ${JSON.stringify({ error: err.message, done: true })}\n\n`));
    } finally {
      // Always close the writer to end the SSE connection
      try { await writer.close(); } catch { /* Already closed */ }
    }
  })();
}

// ──────────────────────────────────────────────
// Main API Handler
// ──────────────────────────────────────────────

/**
 * Handles `/chatjpt/ask` API requests — the core Q&A pipeline.
 *
 * Orchestrates the entire flow from query to answer:
 * 1. Parse and validate the request
 * 2. Augment the query with conversation context (for follow-ups)
 * 3. Generate a query embedding via Workers AI
 * 4. Perform hybrid search over the index
 * 5. Generate an answer (streaming or non-streaming)
 * 6. Return the response with optional debug information
 *
 * Error handling:
 * - Invalid JSON body → 400 error
 * - Missing query → 400 error
 * - Index unavailable → 503 error
 * - AI failure → automatic fallback to keyword summarization
 *
 * @param {Request} request - The incoming HTTP request.
 * @param {Object} env - Cloudflare Worker environment bindings (includes env.AI).
 * @returns {Promise<Response>} JSON or SSE Response.
 */
async function handleAsk(request, env) {
  const startTime = Date.now();

  // Step 1: Parse and validate the request
  let payload;
  try {
    payload = await normalizeRequest(request);
  } catch (err) {
    return json({ error: err.message }, 400);
  }

  // Use decontextualized query if provided (external preprocessing), else raw query
  const query = payload.decontextualized_query || payload.query;

  // Validate: query is required
  if (!query.trim()) {
    return json({
      error: 'Missing required query parameter: query',
      query_id: payload.query_id,
    }, 400);
  }

  // Validate: search index must be loaded and non-empty
  if (!Array.isArray(chatjptIndex) || chatjptIndex.length === 0) {
    return json({
      error: 'Search index is unavailable. Please try again later.',
      query_id: payload.query_id,
    }, 503);
  }

  // Step 2: Parse conversation history (if any) for multi-turn support
  let prevExchanges = [];
  if (payload.prev) {
    try {
      prevExchanges = JSON.parse(payload.prev);
    } catch { /* Invalid JSON in prev — ignore and continue without history */ }
  }

  // Step 3: Augment query with conversation context (for vague follow-ups)
  const searchQuery = augmentQuery(query, prevExchanges);

  // Step 4: Generate query embedding for semantic search
  const ai = env?.AI;
  const embedStart = Date.now();
  const queryEmbedding = ai ? await embedQuery(ai, searchQuery) : null;
  const embedMs = Date.now() - embedStart;

  // Step 5: Perform hybrid search (keyword + semantic)
  const searchStart = Date.now();
  const scoredResults = search(searchQuery, queryEmbedding, chatjptIndex);
  const searchMs = Date.now() - searchStart;

  // Format results for the API response
  const results = scoredResults.map(({ document, score }) => ({
    url: document.url,
    name: document.name,
    site: payload.site,
    score,
    description: document.description,
    schema_object: document.schema_object,
  }));

  const response = {
    query_id: payload.query_id,
    site: payload.site,
    mode: payload.mode,
    query,
    results,
  };

  // ── Streaming mode (SSE) ──────────────────────
  if (payload.mode === 'stream' && ai) {
    try {
      const { stream, fallback, sources } = await generateStreamingAnswer(
        ai, query, scoredResults, prevExchanges, payload.query_id
      );

      // If no stream was returned (e.g., no search results), return JSON fallback
      if (!stream && fallback) {
        return json({ ...fallback, query_id: payload.query_id, mode: 'stream' });
      }

      // Set up a TransformStream to pipe AI tokens to the client as SSE
      const { readable, writable } = new TransformStream();
      const writer = writable.getWriter();
      const encoder = new TextEncoder();

      // SSE-specific response headers
      const sseHeaders = {
        ...corsHeaders,
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      };

      // Start processing the AI stream in the background (fire-and-forget)
      handleStreamingResponse(stream, sources, query, scoredResults, writer, encoder);

      // Return the readable side immediately — client starts receiving tokens
      return new Response(readable, { headers: sseHeaders });
    } catch (err) {
      // AI streaming failed — return a JSON fallback response
      const generated = fallbackSummarize(query, scoredResults.map((r) => r.document));
      return json({ ...generated, query_id: payload.query_id, mode: 'stream', fallback: true });
    }
  }

  // ── Non-streaming modes (summarize / generate / list) ──
  let generateMs = 0;
  if (payload.mode === 'summarize' || payload.mode === 'generate') {
    let generated;

    const genStart = Date.now();
    if (ai) {
      // Use the LLM for answer generation
      generated = await generateAnswer(ai, query, scoredResults, prevExchanges, payload.query_id);
    } else {
      // No AI binding available — use keyword-based fallback
      generated = fallbackSummarize(query, scoredResults.map((r) => r.document));
    }
    generateMs = Date.now() - genStart;

    response.answer = generated.answer;
    response.summary = generated.answer;  // Alias for backward compatibility
    response.sources = generated.sources;
  }

  // ── Debug information ─────────────────────────
  // When debug=true, include timing metrics and detailed retrieval info
  if (payload.debug) {
    response.debug = {
      timing: {
        total_ms: Date.now() - startTime,
        embed_ms: embedMs,         // Time to generate query embedding
        search_ms: searchMs,       // Time to search the index
        generate_ms: generateMs,   // Time to generate the answer
      },
      retrieval: scoredResults.map(({ document, score, keywordScore, semanticScore }) => ({
        id: document.id || document.url,
        name: document.name,
        url: document.url,
        type: document.type,
        datePublished: document.datePublished,
        score,                     // Combined score
        keywordScore,              // Keyword-only component
        semanticScore,             // Semantic-only component
      })),
      index_size: chatjptIndex.length,
      had_embedding: !!queryEmbedding,
      model: MODEL,
    };
  }

  return json(response);
}

// ============================================================
// Worker Entry Point — Cloudflare Workers fetch handler
// ============================================================

/**
 * The default export is the Cloudflare Worker module, which must expose a
 * `fetch` method. This is the entry point for all HTTP requests hitting
 * the Worker's configured routes.
 *
 * Routing:
 * - OPTIONS *           → CORS preflight response (204 No Content)
 * - GET /chatjpt        → Chat UI HTML page
 * - GET/POST /chatjpt/ask → Q&A API endpoint
 * - Everything else     → 404 Not Found
 */
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // CORS preflight: respond with allowed methods/headers
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    // Chat UI: serve the self-contained HTML page
    if (url.pathname === '/chatjpt' || url.pathname === '/chatjpt/') {
      return new Response(chatPage(), {
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
    }

    // API endpoint: process Q&A queries
    if (url.pathname === '/chatjpt/ask' || url.pathname === '/chatjpt/ask/') {
      return handleAsk(request, env);
    }

    // All other paths: 404
    return new Response('Not found', { status: 404 });
  },
};
