/**
 * ChatJPT — Retrieval & Search Module
 *
 * Implements a hybrid search system combining two complementary approaches:
 *
 * 1. **Keyword scoring** (BM25-inspired): Counts token occurrences across
 *    document fields (name, description, keywords, body text) with positional
 *    boosts. Exact phrase matches get a large bonus. This handles precise
 *    queries like restaurant names or specific terms.
 *
 * 2. **Semantic scoring** (cosine similarity): Compares the query's embedding
 *    vector against each document's pre-computed embedding. This captures
 *    meaning — so "beste pizza Amsterdam" finds pizza articles even if those
 *    exact words don't appear in the text.
 *
 * The two scores are combined and multiplied by a per-document weight
 * (WebPage types get a 1.2x boost over BlogPosting's default 1.0x).
 *
 * This module also handles:
 * - Stopword filtering for Dutch + English
 * - Query alias expansion (configurable abbreviation rewrites)
 * - Vague follow-up detection and query augmentation for multi-turn conversations
 */

import { AI_TIMEOUT_MS, EMBEDDING_MODEL, INTENT_MODEL, withTimeout } from './config.js';
import siteConfig from '../chatjpt.config.mjs';

// ──────────────────────────────────────────────
// Stopwords
// ──────────────────────────────────────────────

/**
 * Combined set of Dutch and English stopwords.
 * These extremely common words are filtered out during tokenization because they
 * add noise to keyword scoring without carrying meaningful search intent.
 *
 * Examples: "de" (Dutch "the"), "is", "for", "van" (Dutch "of/from").
 *
 * Note: Single-character tokens are also excluded by the tokenizer (length > 1),
 * so "a", "I" etc. are effectively stopwords too.
 */
const STOPWORDS = new Set([
  // English stopwords
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'how', 'i', 'in', 'is', 'it',
  'of', 'on', 'or', 'that', 'the', 'this', 'to', 'was', 'what', 'when', 'where', 'which', 'who',
  'why', 'with', 'you', 'your',
  // Dutch stopwords
  'de', 'het', 'een', 'en', 'van', 'in', 'is', 'dat', 'die', 'op', 'te', 'zijn', 'voor', 'met',
  'niet', 'ook', 'maar', 'aan', 'er', 'nog', 'al', 'was', 'dan', 'wel', 'om', 'naar', 'bij',
  'uit', 'kan', 'meer', 'ze', 'je', 'we', 'zo', 'wij', 'ik', 'hun', 'hij', 'zij', 'dit',
]);

// ──────────────────────────────────────────────
// Query Alias Expansion
// ──────────────────────────────────────────────

/**
 * Pre-compiled regex patterns from config for query normalization.
 * Each entry is a [RegExp, replacement] pair used to expand abbreviations
 * or normalize jargon before search. For example, "AMS" → "Amsterdam".
 * Configured in chatjpt.config.mjs under `queryAliases`.
 */
const QUERY_ALIASES = (siteConfig.queryAliases || []).map(
  ([pattern, replacement]) => [new RegExp(pattern, 'gi'), replacement]
);

/**
 * Applies all configured query aliases to the input query string.
 * Runs each regex replacement sequentially (global, case-insensitive).
 *
 * @param {string} query - Raw user query.
 * @returns {string} Query with all alias patterns expanded.
 *
 * @example
 *   // If queryAliases contains ["\\bAMS\\b", "Amsterdam"]:
 *   expandAliases("best food AMS") → "best food Amsterdam"
 */
export function expandAliases(query) {
  let expanded = query;
  for (const [pattern, replacement] of QUERY_ALIASES) {
    expanded = expanded.replace(pattern, replacement);
  }
  return expanded;
}

// ──────────────────────────────────────────────
// Tokenization
// ──────────────────────────────────────────────

/**
 * Tokenizes a string into searchable terms by:
 * 1. Converting to lowercase
 * 2. Replacing all non-letter/non-number/non-space/non-hyphen chars with spaces
 *    (using Unicode-aware regex — works for accented characters like ë, é, ü)
 * 3. Splitting on whitespace
 * 4. Removing tokens shorter than 2 characters
 * 5. Filtering out stopwords
 *
 * @param {string} value - The string to tokenize (query or document text).
 * @returns {string[]} Array of cleaned, meaningful tokens.
 *
 * @example
 *   tokenize("Wat is de beste pizza in Amsterdam?")
 *   // → ["beste", "pizza", "amsterdam"]
 *   // ("wat", "is", "de", "in" are stopwords)
 */
function tokenize(value = '') {
  return String(value)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]+/gu, ' ')
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token && token.length > 1 && !STOPWORDS.has(token));
}

// ──────────────────────────────────────────────
// Keyword Scoring
// ──────────────────────────────────────────────

/**
 * Builds a searchable "needle" string from a document by concatenating all
 * text fields separated by newlines. This flattened string is used for
 * both exact-phrase matching and per-token occurrence counting.
 *
 * Fields included: name, description, type, keywords array, and full body text.
 *
 * @param {Object} document - A record from the search index.
 * @returns {string} Lowercased concatenation of all searchable fields.
 */
function buildNeedle(document) {
  return [
    document.name,
    document.description,
    document.type,
    ...(document.keywords || []),
    document.text,
  ].join(' \n ').toLowerCase();
}

/**
 * Computes a BM25-inspired keyword relevance score for a document.
 *
 * Scoring breakdown:
 * - **Exact phrase match** (+20): If the full query appears as a substring
 *   in any of the document's text fields. This strongly rewards documents
 *   that contain the user's exact question or phrase.
 *
 * - **Per-token scoring**: For each query token found in the document:
 *   - Base: min(occurrences, 3) + log2(max(occurrences - 3, 1))
 *     → Diminishing returns after 3 hits (prevents long documents from
 *       dominating just because they repeat common words).
 *   - Positional boosts (cumulative):
 *     - Token in document name:        +10 (strongest signal — title match)
 *     - Token in keywords array:        +7  (explicit metadata match)
 *     - Token in description:           +5  (excerpt/summary match)
 *     - Token in URL path:              +4  (slug often contains key terms)
 *
 * @param {Object} document - A record from the search index.
 * @param {string[]} tokens - Tokenized query terms (output of tokenize()).
 * @param {string} fullQuery - The original query string (for phrase matching).
 * @returns {number} The keyword relevance score (0 = no match).
 */
function scoreDocument(document, tokens, fullQuery) {
  const needle = buildNeedle(document);
  const nameLower = document.name.toLowerCase();
  const descLower = document.description.toLowerCase();
  const urlLower = document.url.toLowerCase();
  const keywordsLower = (document.keywords || []).map((k) => String(k).toLowerCase());
  let score = 0;

  // Exact phrase bonus: reward documents containing the full query verbatim
  if (fullQuery && needle.includes(fullQuery.toLowerCase())) {
    score += 20;
  }

  // Per-token scoring with positional boosts
  for (const token of tokens) {
    // Count total occurrences of this token across all document fields
    const occurrences = needle.split(token).length - 1;
    if (!occurrences) continue;

    // Diminishing returns: first 3 occurrences count fully, then logarithmic
    score += Math.min(occurrences, 3) + Math.log2(Math.max(occurrences - 3, 1));

    // Positional boosts — reward matches in high-signal fields
    if (nameLower.includes(token)) score += 10;   // Title is the strongest signal
    if (descLower.includes(token)) score += 5;    // Description/excerpt match
    if (keywordsLower.some((kw) => kw.includes(token))) score += 7;  // Metadata match
    if (urlLower.includes(token)) score += 4;     // URL slug often contains key terms
  }

  return score;
}

// ──────────────────────────────────────────────
// Semantic Scoring (Vector Similarity)
// ──────────────────────────────────────────────

/**
 * Computes the cosine similarity between two vectors.
 *
 * Cosine similarity measures the angle between two vectors in high-dimensional
 * space, returning a value from -1 (opposite) to +1 (identical direction).
 * For normalized embedding vectors (which BGE produces), this is equivalent
 * to the dot product.
 *
 * Formula: cos(θ) = (A · B) / (|A| × |B|)
 *
 * Returns 0 if either vector is null/undefined or they have different lengths.
 *
 * @param {number[]} a - First embedding vector (768 dimensions for BGE).
 * @param {number[]} b - Second embedding vector (same dimensionality).
 * @returns {number} Similarity score between -1 and 1 (typically 0 to 1 for embeddings).
 */
function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];     // Dot product accumulator
    magA += a[i] * a[i];    // Magnitude of vector A (squared)
    magB += b[i] * b[i];    // Magnitude of vector B (squared)
  }
  const mag = Math.sqrt(magA) * Math.sqrt(magB);
  return mag === 0 ? 0 : dot / mag;
}

// ──────────────────────────────────────────────
// Query Embedding
// ──────────────────────────────────────────────

/**
 * Converts a user query into a 768-dimensional embedding vector using
 * Cloudflare Workers AI. This vector is then compared against pre-computed
 * document embeddings for semantic similarity scoring.
 *
 * Gracefully returns null on failure (timeout, API error, missing AI binding),
 * allowing search to fall back to keyword-only scoring.
 *
 * @param {Object} ai - The Cloudflare Workers AI binding (env.AI).
 * @param {string} query - The user's search query.
 * @returns {Promise<number[]|null>} 768-dim float array, or null on failure.
 */
export async function embedQuery(ai, query) {
  if (!ai) return null;
  try {
    const res = await withTimeout(ai.run(EMBEDDING_MODEL, { text: [query] }), AI_TIMEOUT_MS);
    return res?.data?.[0] || null;
  } catch {
    return null;
  }
}

// ──────────────────────────────────────────────
// Vectorize Query with Progressive Filter Relaxation
// ──────────────────────────────────────────────

/**
 * Builds a Vectorize metadata filter object from filter hints.
 * Returns null if no filters are applicable (pure semantic search).
 *
 * Vectorize v2 filter syntax:
 *   { fieldName: { $eq: value } }          — scalar equality
 *   { fieldName: { $in: [v1, v2] } }       — array membership
 *   Multiple fields are implicitly ANDed.
 *
 * Note: neighborhood is NOT a Vectorize dimension (stored in D1 only).
 *
 * @param {Object} hints - Filter hints subset (only Vectorize-filterable dims).
 * @returns {Object|null} Vectorize filter object or null.
 */
function buildVectorizeFilter(hints) {
  const filter = {};
  if (hints.city) filter.city = { $eq: hints.city };
  if (hints.categories?.length) filter.categories = { $in: hints.categories };
  if (hints.cuisine_type?.length) filter.cuisine_type = { $in: hints.cuisine_type };
  if (hints.occasion?.length) filter.occasion = { $in: hints.occasion };
  return Object.keys(filter).length > 0 ? filter : null;
}

/**
 * Queries the Vectorize index with progressive filter relaxation.
 *
 * Relaxation order (drops one level at a time until ≥5 results):
 *   1. All filters (city + categories + cuisine_type + occasion)
 *   2. Drop occasion
 *   3. Drop categories + cuisine_type
 *   4. Drop city (pure semantic)
 *
 * Neighborhood is not a Vectorize filter (stored in D1 only).
 * It is tracked in relaxedFilters so generation can explain it.
 *
 * @param {Object} env - Worker environment bindings (needs env.VECTORIZE).
 * @param {number[]|null} embedding - Query embedding vector (null = no semantic).
 * @param {Object} filterHints - Intent hints from parseQueryIntent.
 * @param {number} [topK=50] - Number of candidates to retrieve per Vectorize call.
 * @returns {Promise<{ ids: string[], relaxedFilters: string[] }>}
 */
export async function queryVectorize(env, embedding, filterHints, topK = 50) {
  if (!env?.VECTORIZE) return { ids: [], relaxedFilters: [] };

  const relaxedFilters = [];
  // Neighborhood is D1-only — mark as relaxed up-front so generation can explain
  if (filterHints.neighborhood) relaxedFilters.push('neighborhood');

  // Build progressive filter stages (each drops one more dimension)
  const stages = [
    { city: filterHints.city, categories: filterHints.categories, cuisine_type: filterHints.cuisine_type, occasion: filterHints.occasion },
    { city: filterHints.city, categories: filterHints.categories, cuisine_type: filterHints.cuisine_type },
    { city: filterHints.city },
    {},
  ];

  // Deduplicate stages (e.g. if filterHints had no occasion, stages 1 and 2 are identical)
  const seen = new Set();
  const uniqueStages = stages.filter((s) => {
    const key = JSON.stringify(s);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Names of the dimensions being dropped at each relaxation step
  const dropNames = ['occasion', 'categories', 'city'];
  // Track whether each dimension was actually set (so we only report real relaxations)
  const wasSet = {
    occasion:   !!filterHints.occasion?.length,
    categories: !!(filterHints.categories?.length || filterHints.cuisine_type?.length),
    city:       !!filterHints.city,
  };

  // Zero vector fallback for metadata-only queries (when no embedding available)
  const zeroVector = new Array(768).fill(0);
  const queryVector = Array.isArray(embedding) ? embedding : zeroVector;

  let dropIndex = 0;
  let lastMatches = [];

  for (let i = 0; i < uniqueStages.length; i++) {
    const filter = buildVectorizeFilter(uniqueStages[i]);
    const queryOptions = { topK, returnMetadata: 'none' };
    if (filter) queryOptions.filter = filter;

    try {
      const result = await env.VECTORIZE.query(queryVector, queryOptions);
      lastMatches = result?.matches || [];
    } catch {
      lastMatches = [];
    }

    if (lastMatches.length >= 5) {
      return { ids: lastMatches.map((m) => m.id), relaxedFilters };
    }

    // Record what we're about to drop for the next stage
    if (dropIndex < dropNames.length) {
      const dropped = dropNames[dropIndex];
      if (wasSet[dropped]) relaxedFilters.push(dropped);
      dropIndex++;
    }
  }

  // All stages exhausted — return whatever the last stage gave us
  return { ids: lastMatches.map((m) => m.id), relaxedFilters };
}

// ──────────────────────────────────────────────
// Intent Parsing (Structured Filter Extraction)
// ──────────────────────────────────────────────

/**
 * Extracts structured search filters from the user query using a fast LLM.
 *
 * Returns an object with any combination of these fields:
 *   { city, neighborhood, categories, cuisine_type, occasion }
 * All fields are optional — missing means "no filter for this dimension".
 *
 * Runs in parallel with embedQuery (they are independent).
 * Returns {} on any failure so search always proceeds.
 *
 * @param {Object} ai - Cloudflare Workers AI binding (env.AI).
 * @param {string} query - The user's search query.
 * @returns {Promise<Object>} Extracted filter hints (partial, may be empty).
 */
export async function parseQueryIntent(ai, query) {
  if (!ai) return {};
  try {
    const res = await withTimeout(
      ai.run(INTENT_MODEL, {
        messages: [
          {
            role: 'system',
            content: `Extract search filters from the user query as JSON.
Return ONLY a JSON object with these optional fields:
- city: string (e.g. "Amsterdam", "Rotterdam") or null
- neighborhood: string (e.g. "De Pijp", "Jordaan") or null
- categories: string[] (e.g. ["restaurants", "bars"]) or null
- cuisine_type: string[] (e.g. ["italiaans", "japans"]) or null
- occasion: string[] (e.g. ["lunch", "diner", "date"]) or null

Only include fields you are confident about. Return {} if nothing is clear.
Respond with ONLY the JSON object, no explanation.`,
          },
          { role: 'user', content: query },
        ],
        max_tokens: 200,
        temperature: 0,
      }),
      AI_TIMEOUT_MS,
    );

    const raw = res?.response;
    if (!raw || typeof raw !== 'string') return {};

    // Parse JSON — strip markdown fences if present
    const jsonStr = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
    const parsed = JSON.parse(jsonStr);
    if (typeof parsed !== 'object' || Array.isArray(parsed)) return {};

    // Sanitize: only keep known keys, strip nulls
    const result = {};
    if (parsed.city && typeof parsed.city === 'string') result.city = parsed.city;
    if (parsed.neighborhood && typeof parsed.neighborhood === 'string') result.neighborhood = parsed.neighborhood;
    if (Array.isArray(parsed.categories) && parsed.categories.length) result.categories = parsed.categories;
    if (Array.isArray(parsed.cuisine_type) && parsed.cuisine_type.length) result.cuisine_type = parsed.cuisine_type;
    if (Array.isArray(parsed.occasion) && parsed.occasion.length) result.occasion = parsed.occasion;

    return result;
  } catch {
    return {};
  }
}

// ──────────────────────────────────────────────
// Hybrid Search
// ──────────────────────────────────────────────

/**
 * Performs hybrid search across the entire index, combining keyword and semantic scores.
 *
 * Algorithm:
 * 1. Expand query aliases (e.g., abbreviations → full terms)
 * 2. Tokenize the expanded query (lowercase, remove stopwords)
 * 3. For each document in the index:
 *    a. Compute keyword score (BM25-inspired, see scoreDocument)
 *    b. Compute semantic score (cosine similarity with threshold)
 *    c. Combine: (keywordScore + semanticScore) × document.searchWeight
 * 4. Filter out documents with score ≤ 2 (noise threshold)
 * 5. Sort by descending score, return top 8
 *
 * Semantic scoring uses a threshold of 0.3: similarities below this are treated
 * as 0 (irrelevant). Above the threshold, the score is scaled to 0–100 range:
 *   semanticScore = max(0, similarity - 0.3) × 100
 * This means a perfect cosine similarity of 1.0 gives a semantic score of 70.
 *
 * @param {string} query - The user's search query.
 * @param {number[]|null} queryEmbedding - Query embedding vector (null = keyword-only).
 * @param {Object[]} index - The full search index (array of document records).
 * @returns {Object[]} Top 8 results, each with { document, score, keywordScore, semanticScore }.
 */
export function search(query, queryEmbedding, index) {
  const expanded = expandAliases(query);
  const tokens = tokenize(expanded);

  return index
    .map((document) => {
      // Step 1: Keyword-based scoring (BM25-inspired)
      const keywordScore = scoreDocument(document, tokens, expanded);

      // Step 2: Semantic similarity scoring (embedding-based)
      let semanticScore = 0;
      if (queryEmbedding && document.embedding) {
        const similarity = cosineSimilarity(queryEmbedding, document.embedding);
        // Apply threshold: ignore weak similarities (< 0.3), scale the rest to 0–100
        semanticScore = Math.max(0, similarity - 0.3) * 100;
      }

      // Step 3: Combine scores with document-level weight multiplier
      const weight = document.searchWeight ?? 1.0;
      const score = (keywordScore + semanticScore) * weight;
      return { document, score, keywordScore, semanticScore };
    })
    // Filter out noise (score must exceed minimum threshold)
    .filter((item) => item.score > 2)
    // Sort by relevance (highest score first)
    .sort((a, b) => b.score - a.score)
    // Return top 8 results
    .slice(0, 8);
}

// ──────────────────────────────────────────────
// Follow-Up Query Augmentation
// ──────────────────────────────────────────────

/**
 * Detects vague follow-up questions in a multi-turn conversation and augments
 * them with context from the previous exchange.
 *
 * Problem: If a user asks "beste pizza Amsterdam?" and then follows up with
 * "en Napels?", the follow-up alone doesn't carry enough context for search.
 * This function appends the previous query as context: "en Napels? (context: beste pizza Amsterdam?)"
 *
 * Detection heuristics for vague follow-ups:
 * - Query is 5 words or fewer (short queries are likely follow-ups)
 * - Query starts with connective patterns like "what about", "tell me more",
 *   "and", "how about", or Dutch equivalents ("wat is", "vertel", "hoe zit", "en de")
 *
 * @param {string} query - The current user query.
 * @param {Object[]} prevExchanges - Previous conversation exchanges (array of { query, answer }).
 * @returns {string} The original query, optionally augmented with previous context.
 */
export function augmentQuery(query, prevExchanges) {
  // No augmentation needed if there's no conversation history
  if (!prevExchanges || prevExchanges.length === 0) return query;

  // Check if this looks like a vague follow-up question
  const isVagueFollowUp = query.split(/\s+/).length <= 5
    || /^(what about|tell me more|and |how about|why|can you|more on|wat is|vertel|hoe zit|en de)/i.test(query);

  if (!isVagueFollowUp) return query;

  // Append the previous query as context to improve search relevance
  const lastQuery = prevExchanges[prevExchanges.length - 1]?.query;
  if (lastQuery) return `${query} (context: ${lastQuery})`;

  return query;
}
