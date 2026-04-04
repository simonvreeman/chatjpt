# ChatJPT Migration Plan: Bundled ESM Index to Cloudflare D1 + Vectorize

> Technical plan for migrating from the ~33MB bundled `chatjpt-index.mjs` to Cloudflare D1 (structured data) + Vectorize (vector search). Includes the new enriched metadata fields.

---

## Table of Contents

1. [D1 Setup](#1-d1-setup)
2. [Vectorize Setup](#2-vectorize-setup)
3. [Migration of generate-index.mjs](#3-migration-of-generate-indexmjs)
4. [Worker Changes](#4-worker-changes)
5. [wrangler.toml Configuration](#5-wranglertoml-configuration)
6. [Migration Sequence](#6-migration-sequence)

---

## 1. D1 Setup

### 1.1 Database Schema Design

Two tables: `articles` for the main content and `article_places` for the structured places array (one-to-many).

```sql
-- articles: main content table (replaces the bundled index records)
CREATE TABLE articles (
  id            TEXT PRIMARY KEY,       -- relative URL path, e.g. "/food/beste-pizza-amsterdam"
  url           TEXT NOT NULL,          -- same as id (relative path)
  site          TEXT NOT NULL DEFAULT 'cityguys.nl',
  name          TEXT NOT NULL,          -- article title
  type          TEXT NOT NULL DEFAULT 'BlogPosting',  -- schema.org type
  description   TEXT,                   -- first 280 chars excerpt
  date_published TEXT,                  -- ISO date string or NULL
  keywords      TEXT,                   -- JSON array as text, e.g. '["pizza","amsterdam"]'
  search_weight REAL NOT NULL DEFAULT 1.0,
  text          TEXT NOT NULL,          -- full cleaned body text
  schema_object TEXT,                   -- JSON string of schema.org object

  -- Enriched metadata fields (stored as individual columns for query flexibility)
  city          TEXT,                   -- e.g. "Amsterdam"
  neighborhoods TEXT,                   -- JSON array, e.g. '["Centrum","De Pijp"]'
  categories    TEXT,                   -- JSON array, e.g. '["diner"]'
  cuisine_type  TEXT,                   -- JSON array, e.g. '["Italiaans"]'
  occasion      TEXT,                   -- JSON array, e.g. '["date night","met vrienden"]'
  dishes        TEXT,                   -- JSON array, e.g. '["biefstuk","pizza"]' (for keyword synonym expansion, not Vectorize filtering)

  content_hash  TEXT                    -- SHA-256 prefix for cache invalidation
);

-- article_places: normalized table for the places array
-- Enables queries like "find articles mentioning Pizzeria Firma"
CREATE TABLE article_places (
  article_id    TEXT NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  neighborhood  TEXT,
  PRIMARY KEY (article_id, name)
);

-- Indexes for common query patterns
CREATE INDEX idx_articles_city ON articles(city);
CREATE INDEX idx_articles_type ON articles(type);
CREATE INDEX idx_places_name ON article_places(name);
```

**Design decisions:**
- Array fields (`neighborhoods`, `categories`, `cuisine_type`, `occasion`, `dishes`, `keywords`) are stored as JSON text in D1. `dishes` is not indexed in Vectorize — it exists for keyword synonym expansion (e.g., query "steak" matching "biefstuk") and populates the `keywords` field. D1 supports `json_extract()` for querying these, but primary filtering will happen in Vectorize metadata (see section 2). D1 is mainly the "detail store" looked up by ID after Vectorize returns matches.
- `article_places` is normalized into its own table because it has two fields per entry and may be useful for direct lookups.
- `content_hash` is stored to enable the index generator to detect unchanged content without re-reading the full text.

### 1.2 Creating the D1 Database

```bash
npx wrangler d1 create chatjpt-db
```

This outputs the database ID. Select "Yes" when prompted to add the binding to `wrangler.toml`, or add it manually (see section 5).

### 1.3 Binding in wrangler.toml

```toml
[[d1_databases]]
binding = "DB"
database_name = "chatjpt-db"
database_id = "<your-database-id>"
```

The database is then available in the Worker as `env.DB`.

### 1.4 Running Migrations

Create a migration file and apply it:

```bash
# Create the migration file
npx wrangler d1 migrations create chatjpt-db init-schema

# This creates migrations/0001_init-schema.sql — paste the schema SQL above into it

# Apply locally (for dev)
npx wrangler d1 migrations apply chatjpt-db --local

# Apply to production
npx wrangler d1 migrations apply chatjpt-db --remote
```

### 1.5 Worker Queries

The Worker will execute these queries at runtime (after Vectorize returns matching IDs):

```js
// Fetch full article data for a set of IDs returned by Vectorize
const placeholders = ids.map(() => '?').join(',');
const { results } = await env.DB
  .prepare(`SELECT * FROM articles WHERE id IN (${placeholders})`)
  .bind(...ids)
  .run();

// Fetch places for those articles (optional, for enriched responses)
const { results: places } = await env.DB
  .prepare(`SELECT * FROM article_places WHERE article_id IN (${placeholders})`)
  .bind(...ids)
  .run();
```

Using `batch()` to run both in a single round-trip:

```js
const placeholders = ids.map(() => '?').join(',');
const [articlesResult, placesResult] = await env.DB.batch([
  env.DB.prepare(`SELECT * FROM articles WHERE id IN (${placeholders})`).bind(...ids),
  env.DB.prepare(`SELECT * FROM article_places WHERE article_id IN (${placeholders})`).bind(...ids),
]);
```

`batch()` executes as a transaction and is more efficient than separate calls.

---

## 2. Vectorize Setup

### 2.1 Index Configuration

```bash
npx wrangler vectorize create chatjpt-vectors \
  --dimensions=768 \
  --metric=cosine
```

- **Dimensions: 768** — matches `@cf/baai/bge-base-en-v1.5` output
- **Metric: cosine** — same similarity measure currently used in `retrieval.js`

### 2.2 Metadata Fields for Filtering

Vectorize supports metadata filtering with up to **10 metadata indexes** per Vectorize index. Each vector can store up to **10 KiB of metadata**. Filterable string values are indexed on the **first 64 bytes** (truncated at UTF-8 boundaries).

**Supported filter types:** `string`, `number`, `boolean`

**Supported filter operators:**
- `$eq`, `$ne` — equality/inequality
- `$in`, `$nin` — array membership (is the value in this list?)
- `$lt`, `$lte`, `$gt`, `$gte` — range comparisons
- Strings use lexicographic ordering for range queries

**Important limitations:**
- Metadata indexes must be created **before** vectors are inserted. Vectors inserted before a metadata index exists will NOT be filterable on that property.
- Max 10 metadata indexes per Vectorize index.
- String filter values use only the first 64 bytes for comparison.
- Filter JSON must be under 2,048 bytes (compact).
- Very large datasets (~10M+ vectors) may have reduced accuracy on range queries.
- `$in` / `$nin` operators are available (added in a recent update).

**Metadata indexes to create (7 of 10 available):**

```bash
npx wrangler vectorize create-metadata-index chatjpt-vectors \
  --property-name=city --type=string

npx wrangler vectorize create-metadata-index chatjpt-vectors \
  --property-name=type --type=string

npx wrangler vectorize create-metadata-index chatjpt-vectors \
  --property-name=category --type=string

npx wrangler vectorize create-metadata-index chatjpt-vectors \
  --property-name=cuisine --type=string

npx wrangler vectorize create-metadata-index chatjpt-vectors \
  --property-name=occasion --type=string

npx wrangler vectorize create-metadata-index chatjpt-vectors \
  --property-name=neighborhood --type=string

npx wrangler vectorize create-metadata-index chatjpt-vectors \
  --property-name=search_weight --type=number
```

**Why these fields:** These are the fields we want to pre-filter on before semantic ranking. Each vector carries a single `neighborhood` value (the primary neighborhood for that category/occasion combination). Places are omitted as metadata indexes because they are arrays of objects — place lookups go through D1's `article_places` table instead.

**Multiple vectors per article:**

Since Vectorize metadata filtering operates on single string values (not arrays), we generate **multiple vectors per article** — one for each category/occasion combination. All vectors share the same embedding but carry different filter metadata. This ensures complete filterability.

Example: an article with `categories: ["koffie", "lunch"]`, `occasion: ["met vrienden"]`, and `neighborhoods: ["De Pijp"]` produces 2 vectors:

```json
// Vector 1: /food/beste-brunch#koffie-met-vrienden
{
  "city": "Amsterdam",
  "type": "BlogPosting",
  "neighborhood": "De Pijp",
  "category": "koffie",
  "cuisine": "Italiaans",
  "occasion": "met vrienden",
  "search_weight": 1.0,
  "name": "Beste brunch Amsterdam",
  "url": "/food/beste-brunch-amsterdam"
}

// Vector 2: /food/beste-brunch#lunch-met-vrienden
{
  "city": "Amsterdam",
  "type": "BlogPosting",
  "neighborhood": "De Pijp",
  "category": "lunch",
  "cuisine": "Italiaans",
  "occasion": "met vrienden",
  "search_weight": 1.0,
  "name": "Beste brunch Amsterdam",
  "url": "/food/beste-brunch-amsterdam"
}
```

**Vector ID format:** `{article_id}#{category}-{occasion}` — the `url` field always points back to the D1 article record. The `neighborhood` field stores the primary neighborhood; articles covering multiple neighborhoods use the first/most prominent one per vector.

**Combinatorial cap:** If an article has many categories × occasions (e.g., 5 × 4 = 20), cap at 10 vectors per article using the most relevant combinations. Estimated total: ~1500 articles × ~6 vectors avg = ~9,000 vectors (well within Vectorize limits of 200K free / 5M+ paid).

**`dishes` field:** Not used in Vectorize metadata. Lives in D1 only and populates the `keywords` field for keyword scoring and synonym expansion at query time.

### 2.3 Binding in wrangler.toml

```toml
[[vectorize]]
binding = "VECTORIZE"
index_name = "chatjpt-vectors"
```

Available in the Worker as `env.VECTORIZE`.

### 2.4 Upserting Vectors (Worker Binding API)

From within a Worker (or during indexing via a Worker endpoint):

```js
await env.VECTORIZE.upsert([
  {
    id: "/food/beste-pizza-amsterdam",
    values: [0.123, 0.456, ...], // 768-dim Float32 array
    metadata: {
      city: "Amsterdam",
      type: "BlogPosting",
      neighborhood: "Centrum",
      category: "diner",
      cuisine: "Italiaans",
      occasion: "date night",
      search_weight: 1.0,
      name: "Beste pizza Amsterdam",
      url: "/food/beste-pizza-amsterdam"
    }
  },
  // ... more vectors
]);
```

**Batch limits:**
- Worker binding API: max **1,000 vectors per upsert call**
- HTTP REST API: max **5,000 vectors per upsert call**
- Vectorize batches internally up to 200,000 vectors or 1,000 individual updates per job

### 2.5 Querying with Metadata Filters

```js
const results = await env.VECTORIZE.query(queryEmbedding, {
  topK: 20,
  returnMetadata: 'all',
  filter: {
    city: { $eq: "Amsterdam" },
    category: { $in: ["diner", "restaurant"] }
  }
});

// results.matches is an array of:
// {
//   id: "/food/beste-pizza-amsterdam",
//   score: 0.89,
//   metadata: { city: "Amsterdam", type: "BlogPosting", ... }
// }
```

**Filter is applied first**, then topK results are taken from the filtered set. This is important for the progressive relaxation pattern (section 4).

**Query limits:**
- `topK` max: **50** when using `returnMetadata: 'all'` or `returnValues: true`
- `topK` max: **100** without metadata/values
- `returnMetadata` options: `'none'`, `'indexed'`, `'all'`

---

## 3. Migration of generate-index.mjs

### 3.1 Overview of Changes

The script currently:
1. Crawls sitemap -> fetches markdown -> builds records -> generates embeddings -> writes JSON/ESM files

After migration:
1. Crawls sitemap -> fetches markdown -> builds records -> generates embeddings -> **enriches with metadata (new LLM step)** -> writes to D1 + upserts to Vectorize

The local JSON/ESM files are no longer needed for the Worker, but we may keep the JSON output for debugging.

### 3.2 Writing to D1 from a Local Node.js Script

**Option A: `wrangler d1 execute` (recommended for simplicity)**

Generate SQL INSERT statements and execute them via wrangler CLI:

```js
import { execSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

function insertArticlesToD1(records, dbName) {
  // Generate SQL
  const statements = records.map(r => {
    const escaped = (s) => s ? s.replace(/'/g, "''") : null;
    return `INSERT OR REPLACE INTO articles (id, url, site, name, type, description, date_published, keywords, search_weight, text, schema_object, city, neighborhoods, categories, cuisine_type, occasion, dishes, content_hash)
VALUES ('${escaped(r.id)}', '${escaped(r.url)}', '${escaped(r.site)}', '${escaped(r.name)}', '${escaped(r.type)}', '${escaped(r.description)}', ${r.datePublished ? `'${r.datePublished}'` : 'NULL'}, '${escaped(JSON.stringify(r.keywords))}', ${r.searchWeight}, '${escaped(r.text)}', '${escaped(JSON.stringify(r.schema_object))}', ${r.metadata?.city ? `'${escaped(r.metadata.city)}'` : 'NULL'}, ${r.metadata?.neighborhoods ? `'${escaped(JSON.stringify(r.metadata.neighborhoods))}'` : 'NULL'}, ${r.metadata?.categories ? `'${escaped(JSON.stringify(r.metadata.categories))}'` : 'NULL'}, ${r.metadata?.cuisine_type ? `'${escaped(JSON.stringify(r.metadata.cuisine_type))}'` : 'NULL'}, ${r.metadata?.occasion ? `'${escaped(JSON.stringify(r.metadata.occasion))}'` : 'NULL'}, ${r.metadata?.dishes ? `'${escaped(JSON.stringify(r.metadata.dishes))}'` : 'NULL'}, '${r.contentHash}');`;
  });

  // Write to temp file and execute
  const sqlPath = '/tmp/chatjpt-seed.sql';
  writeFileSync(sqlPath, statements.join('\n'), 'utf8');
  execSync(`npx wrangler d1 execute ${dbName} --remote --file=${sqlPath} --yes`, {
    stdio: 'inherit'
  });
}
```

**Option B: D1 REST API (for programmatic use)**

The D1 REST API uses a multi-step import process:
1. `POST /accounts/{account_id}/d1/database/{database_id}/import` with `action: "init"` and an MD5 hash
2. Upload SQL to the returned R2 URL
3. Trigger ingestion with `action: "ingest"`
4. Poll with `action: "poll"` until complete

This is more complex but avoids shelling out to wrangler. See the Cloudflare tutorial "Bulk import to D1 with REST API" for the full implementation.

**Recommendation:** Use Option A (`wrangler d1 execute`) for the initial implementation. It is simpler, well-tested, and the script already requires wrangler to be installed. For ~1,500 records the SQL file will be a few MB — well within limits.

### 3.3 Writing to Vectorize from a Local Node.js Script

**Option A: Vectorize REST API (recommended)**

```js
async function upsertToVectorize(vectors, indexName) {
  const BATCH_SIZE = 5000; // HTTP API allows up to 5000

  for (let i = 0; i < vectors.length; i += BATCH_SIZE) {
    const batch = vectors.slice(i, i + BATCH_SIZE);

    // Build NDJSON body
    const ndjson = batch.map(v => JSON.stringify({
      id: v.id,
      values: v.values,
      metadata: v.metadata
    })).join('\n');

    const res = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/vectorize/v2/indexes/${indexName}/upsert`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${CF_API_TOKEN}`,
          'Content-Type': 'application/x-ndjson',
        },
        body: ndjson,
      }
    );

    const data = await res.json();
    if (!data.success) {
      throw new Error(`Vectorize upsert error: ${JSON.stringify(data.errors)}`);
    }
    console.log(`  Vectorize batch ${Math.floor(i / BATCH_SIZE) + 1}: mutationId=${data.result.mutationId}`);
  }
}
```

**Option B: Wrangler CLI**

```bash
npx wrangler vectorize upsert chatjpt-vectors --file=vectors.ndjson
```

Where `vectors.ndjson` contains one JSON object per line:
```json
{"id":"/food/beste-pizza-amsterdam","values":[0.123,0.456,...],"metadata":{"city":"Amsterdam",...}}
```

Max 5,000 vectors per file for the CLI.

**Recommendation:** Use the REST API (Option A) directly from the Node.js script for a seamless pipeline. Writing NDJSON to a temp file and calling wrangler CLI (Option B) is also viable.

### 3.4 Cache Strategy

The existing cache strategy can be preserved:

- **Markdown cache** (`markdown-cache.json`): No change. Continue caching fetched markdown by URL.
- **Embedding cache** (`embedding-cache.json`): No change. Continue caching embeddings by content hash. The only difference is that after generating embeddings, they go to Vectorize instead of the ESM file.

The `content_hash` column in D1 enables an optimization: before re-indexing, the script can query D1 for existing hashes and skip records whose content hasn't changed, avoiding unnecessary D1 writes (the embedding cache already handles skipping unchanged embeddings).

### 3.5 Updated Pipeline (Pseudocode)

```
1. Fetch sitemap URLs (unchanged)
2. Fetch markdown with cache (unchanged)
3. Build records (unchanged)
4. Enrich records with metadata via LLM (NEW)
5. Generate embeddings with cache (unchanged)
6. Upsert articles to D1 (NEW — replaces writing JSON/ESM)
   - INSERT OR REPLACE for each record
   - INSERT OR REPLACE for article_places
7. Upsert vectors to Vectorize (NEW — replaces writing JSON/ESM)
   - Build vector objects with metadata
   - Batch upsert via REST API
8. (Optional) Write JSON for debugging
```

---

## 4. Worker Changes

### 4.1 Revised Retrieval Flow

**Current flow** (brute-force):
```
embedQuery() -> iterate ALL 1500 records -> score each -> sort -> top 8
```

**New flow** (Vectorize + D1):
```
embedQuery() -> Vectorize.query(embedding, filters) -> get top 20 IDs
  -> D1.select(IDs) -> keyword re-rank -> top 8
```

### 4.2 Changes to retrieval.js

The `search()` function is completely rewritten. The keyword scoring, cosine similarity, and brute-force iteration are replaced by Vectorize queries and D1 lookups.

```js
// src/retrieval.js — new search function

import { AI_TIMEOUT_MS, EMBEDDING_MODEL, withTimeout } from './config.js';
import siteConfig from '../chatjpt.config.mjs';

// ... keep: STOPWORDS, QUERY_ALIASES, expandAliases(), tokenize(),
//     scoreDocument(), augmentQuery(), embedQuery()
// ... remove: cosineSimilarity() (Vectorize handles this now)

/**
 * Performs hybrid search using Vectorize (semantic) + D1 (full data) + keyword re-ranking.
 *
 * @param {string} query - User's search query.
 * @param {number[]|null} queryEmbedding - 768-dim query embedding.
 * @param {Object} env - Worker env with VECTORIZE and DB bindings.
 * @param {Object} [filterHints] - Optional metadata filters from query analysis.
 * @returns {Promise<Object[]>} Top 8 results with { document, score, ... }.
 */
export async function search(query, queryEmbedding, env, filterHints = {}) {
  const expanded = expandAliases(query);
  const tokens = tokenize(expanded);

  // Step 1: Vectorize query — get semantically similar articles
  let vectorResults = [];
  if (queryEmbedding && env.VECTORIZE) {
    const filter = buildVectorizeFilter(filterHints);
    vectorResults = await queryVectorize(env.VECTORIZE, queryEmbedding, filter);
  }

  // Step 2: If Vectorize returned too few results, relax filters and retry
  if (vectorResults.length < 5 && Object.keys(filterHints).length > 0) {
    const relaxedResults = await queryVectorize(env.VECTORIZE, queryEmbedding, {});
    // Merge, preferring filtered results
    const seen = new Set(vectorResults.map(r => r.id));
    for (const r of relaxedResults) {
      if (!seen.has(r.id)) vectorResults.push(r);
    }
  }

  // Step 3: Fetch full article data from D1
  const ids = vectorResults.map(r => r.id);
  const articles = ids.length > 0 ? await fetchArticlesFromD1(env.DB, ids) : [];

  // Step 4: Combine Vectorize scores with keyword re-ranking
  const articleMap = new Map(articles.map(a => [a.id, a]));

  return vectorResults
    .map(vr => {
      const article = articleMap.get(vr.id);
      if (!article) return null;

      const semanticScore = vr.score; // Vectorize cosine similarity (0-1)
      const keywordScore = scoreDocument(article, tokens, expanded);
      const weight = article.search_weight ?? 1.0;

      // Scale semantic to comparable range: (similarity - 0.3) * 100
      const scaledSemantic = Math.max(0, semanticScore - 0.3) * 100;
      const combinedScore = (keywordScore + scaledSemantic) * weight;

      return {
        document: article,
        score: combinedScore,
        keywordScore,
        semanticScore: scaledSemantic,
      };
    })
    .filter(Boolean)
    .filter(item => item.score > 2)
    .sort((a, b) => b.score - a.score)
    .slice(0, 8);
}

/**
 * Query Vectorize with optional metadata filters.
 */
async function queryVectorize(vectorize, embedding, filter) {
  const options = {
    topK: 20,
    returnMetadata: 'all',
  };
  if (filter && Object.keys(filter).length > 0) {
    options.filter = filter;
  }

  const result = await vectorize.query(embedding, options);
  return result.matches || [];
}

/**
 * Build a Vectorize filter object from query hints.
 * Example: { city: "Amsterdam" } -> { city: { $eq: "Amsterdam" } }
 */
function buildVectorizeFilter(hints) {
  const filter = {};
  if (hints.city) filter.city = { $eq: hints.city };
  if (hints.neighborhood) filter.neighborhood = { $eq: hints.neighborhood };
  if (hints.category) filter.category = { $eq: hints.category };
  if (hints.cuisine) filter.cuisine = { $eq: hints.cuisine };
  if (hints.occasion) filter.occasion = { $eq: hints.occasion };
  return filter;
}

/**
 * Fetch full article records from D1 by IDs.
 */
async function fetchArticlesFromD1(db, ids) {
  const placeholders = ids.map(() => '?').join(',');
  const { results } = await db
    .prepare(`SELECT * FROM articles WHERE id IN (${placeholders})`)
    .bind(...ids)
    .run();

  // Parse JSON fields back to arrays
  return results.map(r => ({
    ...r,
    keywords: r.keywords ? JSON.parse(r.keywords) : [],
    neighborhoods: r.neighborhoods ? JSON.parse(r.neighborhoods) : [],
    categories: r.categories ? JSON.parse(r.categories) : [],
    cuisine_type: r.cuisine_type ? JSON.parse(r.cuisine_type) : [],
    occasion: r.occasion ? JSON.parse(r.occasion) : [],
    dishes: r.dishes ? JSON.parse(r.dishes) : [],
    schema_object: r.schema_object ? JSON.parse(r.schema_object) : {},
    searchWeight: r.search_weight,
  }));
}
```

### 4.3 Changes to worker.js

Remove the bundled index import and add the new search call:

```js
// REMOVE this line:
// import chatjptIndex from './generated/chatjpt-index.mjs';

// UPDATE handleAsk():
// Replace:
//   const scoredResults = search(searchQuery, queryEmbedding, chatjptIndex);
// With:
//   const scoredResults = await search(searchQuery, queryEmbedding, env);

// Remove the chatjptIndex availability check:
// if (!Array.isArray(chatjptIndex) || chatjptIndex.length === 0) { ... }
// Replace with a check for env.VECTORIZE and env.DB bindings
```

### 4.4 Progressive Filter Relaxation Pattern

When the user asks something like "Italian restaurants in Amsterdam for a date", the system should:

1. **First query**: Apply all detected filters (`city=Amsterdam`, `cuisine=Italiaans`, `occasion=date night`)
2. **If < 5 results**: Drop the least important filter (e.g., `occasion`) and retry
3. **If still < 5**: Drop another filter (e.g., `cuisine`) and retry
4. **Fallback**: No filters (pure semantic search)

This ensures users always get results, even for very specific queries.

```js
async function searchWithRelaxation(vectorize, embedding, hints) {
  const filterKeys = ['neighborhood', 'occasion', 'cuisine', 'category', 'city']; // relaxation order (neighborhood first to drop, city last)
  let activeHints = { ...hints };

  for (let i = 0; i <= filterKeys.length; i++) {
    const filter = buildVectorizeFilter(activeHints);
    const results = await queryVectorize(vectorize, embedding, filter);

    if (results.length >= 5) return results;

    // Remove the least important remaining filter
    if (i < filterKeys.length) {
      delete activeHints[filterKeys[i]];
    }
  }

  // Final fallback: no filters
  return queryVectorize(vectorize, embedding, {});
}
```

### 4.5 Fallback Behavior

The existing fallback pattern (keyword-only when AI is unavailable) needs adaptation:

- If `env.VECTORIZE` is unavailable: fall back to a D1 full-text query (D1 does not have built-in FTS, but a LIKE query on `text` column can serve as a basic fallback)
- If `env.DB` is unavailable: return a 503 error
- If `env.AI` is unavailable for embedding: query Vectorize with a zero vector or skip Vectorize entirely and use D1 keyword search

---

## 5. wrangler.toml Configuration

Complete updated `wrangler.toml`:

```toml
#:schema node_modules/wrangler/config-schema.json
name = "chatjpt"
main = "src/worker.js"
compatibility_date = "2025-04-01"
workers_dev = true

# Route: serve at vreeman.ai/chatjpt
routes = [
  { pattern = "vreeman.ai/chatjpt*", zone_name = "vreeman.ai" }
]

# Import .md files as text strings
[[rules]]
type = "Text"
globs = ["**/*.md"]
fallthrough = true

# Workers AI binding — required for embeddings + LLM
[ai]
binding = "AI"

# D1 database binding — article content and metadata
[[d1_databases]]
binding = "DB"
database_name = "chatjpt-db"
database_id = "<your-database-id>"

# Vectorize index binding — vector search
[[vectorize]]
binding = "VECTORIZE"
index_name = "chatjpt-vectors"
```

---

## 6. Migration Sequence

### Phase 1: Infrastructure Setup

```bash
# 1. Create D1 database
npx wrangler d1 create chatjpt-db
# Note the database_id from the output

# 2. Create Vectorize index
npx wrangler vectorize create chatjpt-vectors --dimensions=768 --metric=cosine

# 3. Create metadata indexes (MUST be done before inserting vectors)
npx wrangler vectorize create-metadata-index chatjpt-vectors --property-name=city --type=string
npx wrangler vectorize create-metadata-index chatjpt-vectors --property-name=type --type=string
npx wrangler vectorize create-metadata-index chatjpt-vectors --property-name=category --type=string
npx wrangler vectorize create-metadata-index chatjpt-vectors --property-name=cuisine --type=string
npx wrangler vectorize create-metadata-index chatjpt-vectors --property-name=occasion --type=string
npx wrangler vectorize create-metadata-index chatjpt-vectors --property-name=neighborhood --type=string
npx wrangler vectorize create-metadata-index chatjpt-vectors --property-name=search_weight --type=number

# 4. Apply D1 schema migration
npx wrangler d1 migrations create chatjpt-db init-schema
# Paste schema SQL into the migration file
npx wrangler d1 migrations apply chatjpt-db --remote
```

### Phase 2: Update generate-index.mjs

1. Add D1 seeding step (via `wrangler d1 execute --remote`)
2. Add Vectorize upserting step (via REST API)
3. Keep existing caches (markdown + embedding)
4. Add article enrichment step (metadata extraction via LLM)
5. Run `npm run generate` to populate both D1 and Vectorize

### Phase 3: Update Worker Code

1. Update `wrangler.toml` with D1 and Vectorize bindings
2. Rewrite `retrieval.js` to use Vectorize + D1
3. Update `worker.js` to remove bundled index import, pass `env` to search
4. Keep `generation.js` unchanged (it receives articles the same way)
5. Test locally with `npm run dev` (wrangler automatically provides local D1 + Vectorize)

### Phase 4: Deploy and Verify

1. `npm run deploy`
2. Test the API with various queries
3. Verify metadata filtering works (city-specific queries)
4. Verify fallback behavior (keyword-only when AI is down)
5. Compare response quality with the old brute-force approach
6. Remove the `src/generated/` import from `worker.js`

### Expected Benefits

- **Bundle size**: ~33MB -> ~50KB (Worker code only, no bundled index)
- **Cold start**: Significantly faster (no 33MB module to parse)
- **Scalability**: Vectorize handles up to 10M vectors; D1 handles structured queries
- **Filtering**: Native metadata filtering enables city/category/cuisine scoping
- **Incremental updates**: Can update individual articles without re-deploying the Worker
- **Search quality**: Vectorize's optimized ANN search vs. brute-force cosine similarity

### Risks and Mitigations

| Risk | Mitigation |
|------|-----------|
| Vectorize query latency higher than in-memory | Vectorize runs on CF edge; expect ~10-50ms. Current brute-force over 1500 records is already ~5-15ms. Acceptable tradeoff for the other benefits. |
| D1 lookup adds a network hop | Use `batch()` to combine queries. D1 co-locates with Workers. Expect ~5-20ms. |
| Metadata filter too restrictive | Progressive relaxation pattern (section 4.4) ensures results are always returned. |
| Vectorize metadata index limit (10) | We use 7 of 10. Leaves room for future fields (e.g., price_signal in v2). |
| Embedding cache invalidation | `content_hash` in D1 + existing `embedding-cache.json` provide dual-layer cache validation. |

---

## Appendix: Key Cloudflare Documentation References

- [D1 Getting Started](https://developers.cloudflare.com/d1/get-started/)
- [D1 Worker Binding API](https://developers.cloudflare.com/d1/worker-api/d1-database/)
- [D1 Wrangler Commands](https://developers.cloudflare.com/d1/wrangler-commands/)
- [D1 Bulk Import via REST API](https://developers.cloudflare.com/d1/tutorials/import-to-d1-with-rest-api/)
- [Vectorize Overview](https://developers.cloudflare.com/vectorize/)
- [Vectorize Client API](https://developers.cloudflare.com/vectorize/reference/client-api/)
- [Vectorize Metadata Filtering](https://developers.cloudflare.com/vectorize/reference/metadata-filtering/)
- [Vectorize Insert Best Practices](https://developers.cloudflare.com/vectorize/best-practices/insert-vectors/)
- [Vectorize Wrangler Commands](https://developers.cloudflare.com/vectorize/reference/wrangler-commands/)
- [Vectorize Limits](https://developers.cloudflare.com/vectorize/platform/limits/)
- [Vectorize REST API — Upsert](https://developers.cloudflare.com/api/resources/vectorize/subresources/indexes/methods/upsert/)
