# VRE-414: Query Intent Parsing + D1/Vectorize Retrieval

**Date:** 2026-04-04
**Status:** Approved
**Depends on:** VRE-410 (D1/Vectorize infra), VRE-411 (enrichment prompt), VRE-412 (enrichment run), VRE-413 (generate-index migration)

## Problem

The current Worker bundles a ~33MB in-memory index and brute-force scans all ~1500 records on every query. VRE-410–413 set up D1 + Vectorize as the new backend. This task rewrites the retrieval layer to use them.

## Pipeline: Before vs After

**Before:**
```
normalizeRequest → augmentQuery → embedQuery → search(query, embedding, index[]) → generateAnswer
```

**After:**
```
normalizeRequest → augmentQuery → [parseQueryIntent || embedQuery] (parallel)
  → queryVectorize(embedding, filters) with progressive relaxation
  → fetchArticlesFromD1(ids)
  → scoreAndRank(query, articles)
  → generateAnswer(query, results, relaxedFilters)
```

`parseQueryIntent` and `embedQuery` run in parallel — the intent LLM call's latency is hidden behind the embed call.

## Decisions

| Question | Decision | Rationale |
|---|---|---|
| Intent model | `intentModel` in `chatjpt.config.mjs` defaulting to `@cf/meta/llama-3.1-8b-instruct` | Configurable without code changes; smaller/faster than generation model |
| D1 fetch scope | Full records including `text` | BM25 re-ranking needs full body; Vectorize narrows to ~20–50 candidates first so D1 payload is acceptable |
| Relaxation communication | Pass `relaxedFilters` to generation, LLM explains in Dutch | Natural-language explanation beats silent broadening or raw API flags |

## Component Changes

### `chatjpt.config.mjs`
- Add `intentModel: '@cf/meta/llama-3.1-8b-instruct'`

### `generate-index.mjs` (bug fix)
- `upsertVectorize()`: store `categories`, `cuisine_type`, `occasion` as actual arrays (not JSON strings) so Vectorize `$in` filters work

### `retrieval.js`
**Remove:**
- `cosineSimilarity()` — Vectorize handles similarity internally
- in-memory `search()` loop over full index

**Add:**
- `parseQueryIntent(ai, query)` — LLM call returning `{ city, neighborhood, categories, cuisine_type, occasion }`; uses `intentModel`; returns `{}` on any failure
- `queryVectorize(env, embedding, filters, topK)` — calls `env.VECTORIZE.query()` with progressive filter relaxation; returns `{ ids, relaxedFilters }`
- `fetchArticlesFromD1(env, ids)` — `SELECT * FROM articles WHERE id IN (...)` + `article_places`; JSON-parses array columns; returns records matching existing document interface

**Keep unchanged:**
- `scoreDocument()`, `tokenize()`, `expandAliases()`, `augmentQuery()`, `embedQuery()`

**Update:**
- `search(query, embedding, env, filterHints)` — new signature orchestrating the above; returns same `{ document, score, keywordScore, semanticScore }` shape

### `worker.js`
- Remove `import chatjptIndex from './generated/chatjpt-index.mjs'`
- Remove index availability guard
- Run `parseQueryIntent` + `embedQuery` in parallel via `Promise.all()`
- Pass `env` instead of index to `search()`
- Pass `relaxedFilters` to generation functions
- Add graceful fallback when `env.VECTORIZE` or `env.DB` is missing

### `generation.js`
- `generateStreamingAnswer` + `generateAnswer`: accept `relaxedFilters` parameter
- `buildMessages()`: when `relaxedFilters` non-empty, prepend Dutch-language note to context block

## Progressive Filter Relaxation

```
1. All filters           → if ≥5 results: done
2. Drop neighborhood     → if ≥5 results: done  [relaxedFilters = ["neighborhood"]]
3. Drop occasion         → if ≥5 results: done  [relaxedFilters = [..., "occasion"]]
4. Drop categories+cuisine → if ≥5 results: done  [relaxedFilters = [..., "categories"]]
5. Drop city             → if ≥5 results: done  [relaxedFilters = [..., "city"]]
6. No filters (pure semantic) → always done     [relaxedFilters = ["all_filters"]]
```

Threshold: 5 results. Worst case: 6 Vectorize calls. Typical case: resolves at step 1 or 2.

## Fallback Chain

1. `env.VECTORIZE` missing → `fallbackSummarize`
2. `parseQueryIntent` fails → `filterHints = {}`, proceed without filters
3. Vectorize returns 0 after full relaxation → `fallbackSummarize`
4. D1 fetch fails → `fallbackSummarize`
5. `embedQuery` returns null → metadata-filter-only Vectorize query (lower quality, still works)

## Relaxation Note Format (in context block)

```
Note: geen resultaten gevonden voor buurt "De Pijp". Resultaten zijn verbreed naar Amsterdam.
```

Prepended to the context block (not system prompt) so the LLM sees it as grounding information and incorporates it naturally.

## What Is Not Changed

- `scoreDocument()` — unchanged, BM25 logic still valid
- `buildContext()` — unchanged, document shape is preserved
- `extractSources()` — unchanged
- `fallbackSummarize()` — unchanged
- SSE streaming infrastructure in `worker.js` — unchanged
- API response shape — unchanged (backward compatible)
