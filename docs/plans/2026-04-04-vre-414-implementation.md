# VRE-414: Query Intent + D1/Vectorize Retrieval — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the bundled 33MB in-memory index with D1 + Vectorize backed retrieval, adding parallel query intent parsing and progressive filter relaxation.

**Architecture:** `parseQueryIntent` (intent LLM) and `embedQuery` run in parallel; Vectorize narrows the candidate set with metadata filters + progressive relaxation; D1 fetches full article records for BM25 re-ranking; `relaxedFilters` flows to generation so the LLM explains in Dutch when results were broadened.

**Tech Stack:** Cloudflare Workers, Cloudflare D1 (SQLite), Cloudflare Vectorize v2, Workers AI (intent: `llama-3.1-8b-instruct`, generation: `llama-3.3-70b-instruct-fp8-fast`, embedding: `bge-base-en-v1.5`), vanilla ESM JavaScript, wrangler CLI.

**No test framework exists.** Verification is done via `npm run dev` + curl. See CLAUDE.md.

---

### Task 1: Fix VRE-413 bug — Vectorize array metadata

**Context:** `upsertVectorize()` in `generate-index.mjs` serialized `categories`, `cuisine_type`, and `occasion` as JSON strings (`JSON.stringify(arr)`). Vectorize v2 metadata `$in` filters require real arrays, not strings. Fix this before anything else so a re-index produces correct filterable metadata.

**Files:**
- Modify: `generate-index.mjs` (inside `upsertVectorize()`)

**Step 1: Find the broken lines**

In `upsertVectorize()`, locate the metadata object built per vector. It currently looks like:
```js
metadata: {
  site:         record.site,
  type:         record.type,
  name:         record.name,
  city:         meta.city || '',
  categories:   JSON.stringify(cats),
  cuisine_type: JSON.stringify(cuisines),
  occasion:     JSON.stringify(occasions),
},
```

**Step 2: Fix — use real arrays**

Replace the three `JSON.stringify` calls with direct array values:
```js
metadata: {
  site:         record.site,
  type:         record.type,
  name:         record.name,
  city:         meta.city || '',
  categories:   cats,
  cuisine_type: cuisines,
  occasion:     occasions,
},
```

Where `cats`, `cuisines`, `occasions` are already plain arrays at that point in the function.

**Step 3: Verify the edit compiles**

```bash
node --input-type=module <<'EOF'
import('./generate-index.mjs').catch(e => {
  if (e.message.includes('Missing chatjpt.config.mjs')) process.exit(0);
  console.error(e); process.exit(1);
});
EOF
```
Expected: exits 0 (config missing error is normal outside full run).

**Step 4: Commit**

```bash
git add generate-index.mjs
git commit -m "fix: upsertVectorize stores arrays as real arrays for Vectorize \$in filters (VRE-414)"
```

---

### Task 2: Add `intentModel` to config

**Context:** Intent extraction uses a smaller/faster model than generation. The model ID lives in config (not hardcoded) so it can be changed without touching code.

**Files:**
- Modify: `chatjpt.config.mjs`
- Modify: `src/config.js`

**Step 1: Add to `chatjpt.config.mjs`**

After the `chatModel` entry, add:
```js
/**
 * Smaller/faster model for query intent extraction.
 * Intent extraction is a simpler task than generation — an 8B model
 * is sufficient and adds less latency than the 70B generation model.
 */
intentModel: '@cf/meta/llama-3.1-8b-instruct',
```

**Step 2: Export from `src/config.js`**

After the `MODEL` export, add:
```js
/**
 * The Workers AI model used for query intent parsing (extracting structured
 * filters from the user query). Smaller and faster than the generation model.
 */
export const INTENT_MODEL = siteConfig.intentModel || '@cf/meta/llama-3.1-8b-instruct';
```

**Step 3: Verify**

```bash
node -e "import('./src/config.js').then(m => console.log('INTENT_MODEL:', m.INTENT_MODEL))"
```
Expected: `INTENT_MODEL: @cf/meta/llama-3.1-8b-instruct`

**Step 4: Commit**

```bash
git add chatjpt.config.mjs src/config.js
git commit -m "feat: add intentModel config for query intent parsing (VRE-414)"
```

---

### Task 3: Add `parseQueryIntent` to `retrieval.js`

**Context:** A new LLM call that extracts structured filters from the user query. Runs in parallel with `embedQuery` (independent). Returns `{}` on any failure — never blocks search.

**Files:**
- Modify: `src/retrieval.js`

**Step 1: Add import**

At the top of `retrieval.js`, add `INTENT_MODEL` to the existing import from `./config.js`:
```js
import { AI_TIMEOUT_MS, EMBEDDING_MODEL, INTENT_MODEL, withTimeout } from './config.js';
```

**Step 2: Add the function**

Add after `embedQuery` and before the `search` function:

```js
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
```

**Step 3: Verify file parses**

```bash
node --input-type=module <<'EOF'
import { parseQueryIntent } from './src/retrieval.js';
console.log('parseQueryIntent exported:', typeof parseQueryIntent);
EOF
```
Expected: `parseQueryIntent exported: function`

**Step 4: Commit**

```bash
git add src/retrieval.js
git commit -m "feat: add parseQueryIntent for structured filter extraction (VRE-414)"
```

---

### Task 4: Add `queryVectorize` with progressive relaxation to `retrieval.js`

**Context:** Calls `env.VECTORIZE.query()` with metadata filters derived from intent. If fewer than 5 results, relaxes filters one level at a time until enough results are found or no filters remain.

**Files:**
- Modify: `src/retrieval.js`

**Step 1: Add the helper that builds Vectorize filter objects**

Add this before `queryVectorize`:

```js
/**
 * Builds a Vectorize metadata filter object from filter hints.
 * Returns null if no filters are applicable (pure semantic search).
 *
 * Vectorize v2 filter syntax:
 *   { fieldName: { $eq: value } }          — scalar equality
 *   { fieldName: { $in: [v1, v2] } }       — array membership
 *   Multiple fields are implicitly ANDed.
 *
 * @param {Object} hints - Filter hints from parseQueryIntent.
 * @returns {Object|null} Vectorize filter object or null.
 */
function buildVectorizeFilter(hints) {
  const filter = {};
  if (hints.city) filter.city = { $eq: hints.city };
  if (hints.categories?.length) filter.categories = { $in: hints.categories };
  if (hints.cuisine_type?.length) filter.cuisine_type = { $in: hints.cuisine_type };
  if (hints.occasion?.length) filter.occasion = { $in: hints.occasion };
  // Note: neighborhood is stored in D1 only (article_places), not in Vectorize metadata.
  // It is used for D1 post-filtering after Vectorize results are fetched.
  return Object.keys(filter).length > 0 ? filter : null;
}
```

**Step 2: Add `queryVectorize`**

Add after `buildVectorizeFilter`:

```js
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
  // Track neighborhood relaxation (D1 only, not a Vectorize dimension)
  if (filterHints.neighborhood) relaxedFilters.push('neighborhood');

  // Build progressive filter stages (each stage is a subset of the previous)
  const stages = [
    // Stage 1: all Vectorize-filterable dimensions
    { city: filterHints.city, categories: filterHints.categories, cuisine_type: filterHints.cuisine_type, occasion: filterHints.occasion },
    // Stage 2: drop occasion
    { city: filterHints.city, categories: filterHints.categories, cuisine_type: filterHints.cuisine_type },
    // Stage 3: drop categories + cuisine_type
    { city: filterHints.city },
    // Stage 4: no filters (pure semantic)
    {},
  ];

  // Remove duplicate/redundant stages (e.g. if filterHints had no occasion, stages 1 and 2 are identical)
  const seen = new Set();
  const uniqueStages = stages.filter((s) => {
    const key = JSON.stringify(s);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const stageNames = ['occasion', 'categories', 'city'];
  let stageIndex = 0;

  for (const stage of uniqueStages) {
    const filter = buildVectorizeFilter(stage);
    const queryOptions = { topK, returnMetadata: 'none' };
    if (filter) queryOptions.filter = filter;

    let matches;
    try {
      if (embedding) {
        const result = await env.VECTORIZE.query(embedding, queryOptions);
        matches = result?.matches || [];
      } else {
        // No embedding — metadata-filter-only mode (lower quality but functional)
        const result = await env.VECTORIZE.query(new Array(768).fill(0), queryOptions);
        matches = result?.matches || [];
      }
    } catch {
      matches = [];
    }

    if (matches.length >= 5) {
      return { ids: matches.map((m) => m.id), relaxedFilters };
    }

    // Track which filter level was just relaxed (for generation explanation)
    if (stageIndex < stageNames.length) {
      // Only add to relaxedFilters if this dimension was actually set (i.e., we actually dropped it)
      const dropped = stageNames[stageIndex];
      const hadFilter = dropped === 'occasion'
        ? !!filterHints.occasion?.length
        : dropped === 'categories'
          ? !!(filterHints.categories?.length || filterHints.cuisine_type?.length)
          : !!filterHints.city;
      if (hadFilter) relaxedFilters.push(dropped);
    }
    stageIndex++;
  }

  // Final fallback: return whatever the last stage gave us (may be < 5)
  const lastFilter = buildVectorizeFilter({});
  try {
    const result = embedding
      ? await env.VECTORIZE.query(embedding, { topK, returnMetadata: 'none' })
      : await env.VECTORIZE.query(new Array(768).fill(0), { topK, returnMetadata: 'none' });
    return { ids: (result?.matches || []).map((m) => m.id), relaxedFilters };
  } catch {
    return { ids: [], relaxedFilters };
  }
}
```

**Step 3: Verify file parses**

```bash
node --input-type=module <<'EOF'
import { queryVectorize } from './src/retrieval.js';
console.log('queryVectorize exported:', typeof queryVectorize);
EOF
```
Expected: `queryVectorize exported: function`

**Step 4: Commit**

```bash
git add src/retrieval.js
git commit -m "feat: add queryVectorize with progressive filter relaxation (VRE-414)"
```

---

### Task 5: Add `fetchArticlesFromD1` to `retrieval.js`

**Context:** Given a list of IDs from Vectorize, fetches full article records from D1 (including `text` for BM25 re-ranking) and joins with `article_places`. Returns records shaped to match the existing `document` interface used by `scoreDocument()` and `buildContext()`.

**Files:**
- Modify: `src/retrieval.js`

**Step 1: Add the function**

Add after `queryVectorize`:

```js
/**
 * Fetches full article records from D1 by their IDs.
 *
 * Fetches both the main article fields and their associated places
 * (from article_places table), then shapes the result to match the
 * document interface expected by scoreDocument() and buildContext().
 *
 * Array columns stored as JSON strings in D1 (keywords, categories, etc.)
 * are parsed back to arrays.
 *
 * @param {Object} env - Worker environment bindings (needs env.DB).
 * @param {string[]} ids - Article IDs returned by queryVectorize.
 * @returns {Promise<Object[]>} Array of document-shaped records.
 */
export async function fetchArticlesFromD1(env, ids) {
  if (!env?.DB || !ids?.length) return [];

  try {
    // D1 prepared statement placeholders: ?,?,?,...
    const placeholders = ids.map(() => '?').join(', ');

    // Fetch main article records
    const articlesResult = await env.DB
      .prepare(`SELECT * FROM articles WHERE id IN (${placeholders})`)
      .bind(...ids)
      .all();
    const rows = articlesResult?.results || [];

    if (!rows.length) return [];

    // Fetch associated places for these articles
    const placesResult = await env.DB
      .prepare(`SELECT article_id, name, neighborhood FROM article_places WHERE article_id IN (${placeholders})`)
      .bind(...ids)
      .all();
    const placesRows = placesResult?.results || [];

    // Group places by article_id
    const placesByArticle = {};
    for (const p of placesRows) {
      if (!placesByArticle[p.article_id]) placesByArticle[p.article_id] = [];
      placesByArticle[p.article_id].push({ name: p.name, neighborhood: p.neighborhood });
    }

    // Shape rows to match the document interface
    return rows.map((row) => {
      const safeParseArray = (val) => {
        if (Array.isArray(val)) return val;
        if (typeof val === 'string' && val.startsWith('[')) {
          try { return JSON.parse(val); } catch { return []; }
        }
        return [];
      };

      return {
        id:            row.id,
        url:           row.url,
        site:          row.site,
        name:          row.name,
        type:          row.type,
        description:   row.description || '',
        datePublished: row.date_published || null,
        keywords:      safeParseArray(row.keywords),
        searchWeight:  row.search_weight ?? 1.0,
        text:          row.text || '',
        schema_object: (() => {
          try { return typeof row.schema_object === 'string' ? JSON.parse(row.schema_object) : (row.schema_object || null); }
          catch { return null; }
        })(),
        // Enrichment metadata (available for generation context)
        city:          row.city || null,
        neighborhoods: safeParseArray(row.neighborhoods),
        categories:    safeParseArray(row.categories),
        cuisine_type:  safeParseArray(row.cuisine_type),
        occasion:      safeParseArray(row.occasion),
        dishes:        safeParseArray(row.dishes),
        places:        placesByArticle[row.id] || [],
      };
    });
  } catch (err) {
    console.error('fetchArticlesFromD1 failed:', err.message);
    return [];
  }
}
```

**Step 2: Verify file parses**

```bash
node --input-type=module <<'EOF'
import { fetchArticlesFromD1 } from './src/retrieval.js';
console.log('fetchArticlesFromD1 exported:', typeof fetchArticlesFromD1);
EOF
```
Expected: `fetchArticlesFromD1 exported: function`

**Step 3: Commit**

```bash
git add src/retrieval.js
git commit -m "feat: add fetchArticlesFromD1 for full-record retrieval (VRE-414)"
```

---

### Task 6: Rewrite `search()` in `retrieval.js`

**Context:** Replaces the in-memory brute-force loop with the new pipeline: Vectorize → D1 → BM25 re-rank. New signature: `search(query, embedding, env, filterHints)`. Same return shape as before so `generation.js` and `worker.js` calling code changes minimally. Also removes `cosineSimilarity()` which is no longer used.

**Files:**
- Modify: `src/retrieval.js`

**Step 1: Remove `cosineSimilarity`**

Delete the entire `cosineSimilarity` function (lines ~215–225). It is no longer needed — Vectorize handles similarity internally.

**Step 2: Replace `search()`**

Replace the existing `search()` function entirely:

```js
/**
 * Hybrid search using Vectorize (semantic + metadata filters) + D1 (full records) + BM25 re-ranking.
 *
 * Pipeline:
 * 1. Query Vectorize with embedding + metadata filters (with progressive relaxation)
 * 2. Fetch full article records from D1 by the returned IDs
 * 3. Re-rank using BM25-inspired keyword scoring on full article text
 * 4. Filter out noise (score ≤ 2), sort descending, return top 8
 *
 * Falls back gracefully:
 * - No env.VECTORIZE → returns []
 * - No env.DB → returns []
 * - No embedding → metadata-filter-only Vectorize query
 *
 * @param {string} query - The user's search query.
 * @param {number[]|null} queryEmbedding - Query embedding vector (null = no semantic).
 * @param {Object} env - Worker environment bindings (env.VECTORIZE + env.DB).
 * @param {Object} [filterHints={}] - Structured filters from parseQueryIntent.
 * @returns {Promise<Object[]>} Top 8 results: { document, score, keywordScore, semanticScore }.
 */
export async function search(query, queryEmbedding, env, filterHints = {}) {
  // Graceful degradation: if bindings are missing, return empty (fallbackSummarize handles it)
  if (!env?.VECTORIZE || !env?.DB) return [];

  const expanded = expandAliases(query);
  const tokens = tokenize(expanded);

  // Step 1: Vectorize semantic search with filter relaxation
  const { ids, relaxedFilters } = await queryVectorize(env, queryEmbedding, filterHints);
  if (!ids.length) return [];

  // Step 2: Fetch full records from D1
  const articles = await fetchArticlesFromD1(env, ids);
  if (!articles.length) return [];

  // Step 3: BM25 re-ranking
  const scored = articles.map((document) => {
    const keywordScore = scoreDocument(document, tokens, expanded);
    // No cosine similarity here — Vectorize already handled semantic ranking.
    // We preserve a semanticScore of 0 so the debug output shape stays consistent.
    const semanticScore = 0;
    const weight = document.searchWeight ?? 1.0;
    const score = (keywordScore + semanticScore) * weight;
    return { document, score, keywordScore, semanticScore, relaxedFilters };
  });

  return scored
    .filter((item) => item.score > 0)   // Remove zero-score results (no keyword overlap at all)
    .sort((a, b) => b.score - a.score)
    .slice(0, 8);
}
```

**Step 3: Verify exports are all present**

```bash
node --input-type=module <<'EOF'
import { search, parseQueryIntent, queryVectorize, fetchArticlesFromD1, embedQuery, augmentQuery, expandAliases } from './src/retrieval.js';
const fns = { search, parseQueryIntent, queryVectorize, fetchArticlesFromD1, embedQuery, augmentQuery, expandAliases };
Object.entries(fns).forEach(([k, v]) => console.log(k + ':', typeof v));
EOF
```
Expected: all `function`.

**Step 4: Commit**

```bash
git add src/retrieval.js
git commit -m "feat: rewrite search() to use Vectorize + D1 + BM25 re-rank, remove cosineSimilarity (VRE-414)"
```

---

### Task 7: Update `generation.js` to accept `relaxedFilters`

**Context:** When filters were relaxed during retrieval, the LLM needs to know so it can explain this naturally in Dutch. We pass `relaxedFilters` to both generation functions and prepend a note to the context block.

**Files:**
- Modify: `src/generation.js`

**Step 1: Update `buildMessages` to accept and use `relaxedFilters`**

Change the signature and add the relaxation note:

```js
function buildMessages(query, context, prevExchanges, relaxedFilters = []) {
```

Inside `buildMessages`, just before the final `messages.push` for the user message, add:

```js
  // Prepend relaxation note when filters were broadened
  let contextWithNote = context;
  if (relaxedFilters.length > 0) {
    const noteLines = [];
    if (relaxedFilters.includes('neighborhood')) {
      noteLines.push(`Note: geen resultaten gevonden voor de opgegeven buurt. Resultaten zijn verbreed naar de stad.`);
    }
    if (relaxedFilters.includes('occasion')) {
      noteLines.push(`Note: geen resultaten gevonden voor het opgegeven moment/gelegenheid. Resultaten zijn verbreed.`);
    }
    if (relaxedFilters.includes('categories')) {
      noteLines.push(`Note: geen resultaten gevonden voor de opgegeven categorie of keuken. Resultaten zijn verbreed.`);
    }
    if (relaxedFilters.includes('city')) {
      noteLines.push(`Note: geen resultaten gevonden voor de opgegeven stad. Resultaten zijn landelijk verbreed.`);
    }
    if (relaxedFilters.includes('all_filters')) {
      noteLines.push(`Note: geen gefilterde resultaten gevonden. Toont meest relevante resultaten zonder filters.`);
    }
    if (noteLines.length) {
      contextWithNote = noteLines.join('\n') + '\n\n' + context;
    }
  }
```

Then update the final `messages.push` to use `contextWithNote` instead of `context`:
```js
  messages.push({ role: 'user', content: `Context from ${SITE_NAME}:\n\n${contextWithNote}\n\nQuestion: ${query}` });
```

**Step 2: Update `generateStreamingAnswer` signature**

Change:
```js
export async function generateStreamingAnswer(ai, query, scoredResults, prevExchanges, sessionId) {
```
To:
```js
export async function generateStreamingAnswer(ai, query, scoredResults, prevExchanges, sessionId, relaxedFilters = []) {
```

Update its internal `buildMessages` call from:
```js
  const messages = buildMessages(query, context, prevExchanges);
```
To:
```js
  const messages = buildMessages(query, context, prevExchanges, relaxedFilters);
```

**Step 3: Update `generateAnswer` signature**

Change:
```js
export async function generateAnswer(ai, query, scoredResults, prevExchanges, sessionId) {
```
To:
```js
export async function generateAnswer(ai, query, scoredResults, prevExchanges, sessionId, relaxedFilters = []) {
```

Update its internal `buildMessages` call:
```js
  const messages = buildMessages(query, context, prevExchanges, relaxedFilters);
```

**Step 4: Verify file parses**

```bash
node --input-type=module <<'EOF'
import { generateStreamingAnswer, generateAnswer, buildContext, fallbackSummarize, extractSources } from './src/generation.js';
const fns = { generateStreamingAnswer, generateAnswer, buildContext, fallbackSummarize, extractSources };
Object.entries(fns).forEach(([k, v]) => console.log(k + ':', typeof v));
EOF
```
Expected: all `function`.

**Step 5: Commit**

```bash
git add src/generation.js
git commit -m "feat: pass relaxedFilters to generation for natural-language explanation (VRE-414)"
```

---

### Task 8: Update `worker.js`

**Context:** Remove the bundled index import and its availability guard, run `parseQueryIntent` + `embedQuery` in parallel, pass `env` to `search()`, and thread `relaxedFilters` through to generation.

**Files:**
- Modify: `src/worker.js`

**Step 1: Remove bundled index import**

Remove this line:
```js
import chatjptIndex from './generated/chatjpt-index.mjs';
```

**Step 2: Add `parseQueryIntent` to imports from `retrieval.js`**

Change:
```js
import { search, embedQuery, augmentQuery } from './retrieval.js';
```
To:
```js
import { search, embedQuery, augmentQuery, parseQueryIntent } from './retrieval.js';
```

**Step 3: Remove index availability guard**

Remove this block from `handleAsk`:
```js
  // Validate: search index must be loaded and non-empty
  if (!Array.isArray(chatjptIndex) || chatjptIndex.length === 0) {
    return json({
      error: 'Search index is unavailable. Please try again later.',
      query_id: payload.query_id,
    }, 503);
  }
```

**Step 4: Replace the sequential embed → search with parallel intent + embed → search**

Find this block:
```js
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
```

Replace with:
```js
  // Step 3: Augment query with conversation context (for vague follow-ups)
  const searchQuery = augmentQuery(query, prevExchanges);

  // Step 4: Run intent parsing and embedding generation in parallel (independent)
  const ai = env?.AI;
  const embedStart = Date.now();
  const [queryEmbedding, filterHints] = await Promise.all([
    ai ? embedQuery(ai, searchQuery) : Promise.resolve(null),
    ai ? parseQueryIntent(ai, query) : Promise.resolve({}),
  ]);
  const embedMs = Date.now() - embedStart;

  // Step 5: Perform hybrid search (Vectorize + D1 + BM25 re-rank)
  const searchStart = Date.now();
  const scoredResults = await search(searchQuery, queryEmbedding, env, filterHints);
  const searchMs = Date.now() - searchStart;

  // Extract relaxedFilters from results (all results carry the same relaxedFilters array)
  const relaxedFilters = scoredResults[0]?.relaxedFilters || [];
```

Note: `search()` is now async — add `await`.

**Step 5: Pass `relaxedFilters` to streaming generation**

Find:
```js
      const { stream, fallback, sources } = await generateStreamingAnswer(
        ai, query, scoredResults, prevExchanges, payload.query_id
      );
```
Replace with:
```js
      const { stream, fallback, sources } = await generateStreamingAnswer(
        ai, query, scoredResults, prevExchanges, payload.query_id, relaxedFilters
      );
```

**Step 6: Pass `relaxedFilters` to non-streaming generation**

Find:
```js
      generated = await generateAnswer(ai, query, scoredResults, prevExchanges, payload.query_id);
```
Replace with:
```js
      generated = await generateAnswer(ai, query, scoredResults, prevExchanges, payload.query_id, relaxedFilters);
```

**Step 7: Update debug block**

In the `debug` block, replace:
```js
      index_size: chatjptIndex.length,
```
With:
```js
      filter_hints: filterHints,
      relaxed_filters: relaxedFilters,
```

**Step 8: Verify the Worker starts**

```bash
npm run dev
```
Expected: wrangler starts without import errors. If `src/generated/chatjpt-index.mjs` no longer exists or is unreferenced, that's correct — it's no longer imported.

**Step 9: Smoke test**

With `npm run dev` running:
```bash
curl -s "http://localhost:8787/chatjpt/ask?q=beste+pizza+amsterdam&mode=list" | jq '.results | length'
```
Expected: a number ≥ 0 (will be 0 in local dev without local D1/Vectorize data, but no 500 error).

**Step 10: Commit**

```bash
git add src/worker.js
git commit -m "feat: wire parseQueryIntent + Vectorize/D1 search into worker pipeline, remove bundled index (VRE-414)"
```

---

### Task 9: Final verification + clean up

**Step 1: Run dev server and verify no JS errors**

```bash
npm run dev 2>&1 | head -30
```
Expected: clean start, no import errors, no undefined references.

**Step 2: Verify the chat UI loads**

```bash
curl -s -o /dev/null -w "%{http_code}" http://localhost:8787/chatjpt
```
Expected: `200`

**Step 3: Verify API responds without crashing**

```bash
curl -s "http://localhost:8787/chatjpt/ask?q=amsterdam+restaurants&debug=true" | jq '{results: (.results | length), filter_hints: .debug.filter_hints, relaxed_filters: .debug.relaxed_filters}'
```
Expected: JSON with `results`, `filter_hints`, and `relaxed_filters` fields (values may be empty in local dev without Vectorize data).

**Step 4: Commit any final fixes, then push**

```bash
git push origin claude/vigilant-meitner
```

---

## Summary of Files Changed

| File | Change |
|---|---|
| `generate-index.mjs` | Bug fix: arrays stored as real arrays in Vectorize metadata |
| `chatjpt.config.mjs` | Add `intentModel` |
| `src/config.js` | Export `INTENT_MODEL` |
| `src/retrieval.js` | Add `parseQueryIntent`, `queryVectorize`, `fetchArticlesFromD1`; rewrite `search()`; remove `cosineSimilarity` |
| `src/generation.js` | Accept `relaxedFilters`; prepend Dutch relaxation note to context |
| `src/worker.js` | Remove bundled index; parallel intent+embed; pass `env` + `relaxedFilters` |

## Files NOT Changed

- `src/ui.js` — no changes needed
- `src/system-prompt.md` — no changes needed
- `src/config.js` (except adding `INTENT_MODEL`) — all other constants unchanged
- `wrangler.toml` — D1 and Vectorize bindings already set up in VRE-410
- `migrations/` — schema unchanged
