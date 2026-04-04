# VRE-412: Enrichment Run + Normalization Map — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add LLM-based metadata enrichment to `generate-index.mjs` with caching, then build a normalization map to cluster synonyms.

**Architecture:** New enrichment step inserted between `buildRecords` and `generateEmbeddings` in the existing pipeline. Uses the same content-hash caching pattern as embeddings. Enrichment populates `keywords` before embedding generation, improving embedding quality. After enrichment, a normalization pass clusters synonyms via a single LLM call.

**Tech Stack:** Workers AI (Llama 3.3 70B via `config.chatModel`), existing `generate-index.mjs` pipeline

**Important:** Run `export PATH="$HOME/.nvm/versions/node/v24.7.0/bin:$PATH"` before any npm/npx/node commands.

---

## Task 1: Add enrichment cache infrastructure

**Files:**
- Modify: `generate-index.mjs:90-100` (add paths)
- Modify: `generate-index.mjs:108-109` (add model constant)

**Step 1: Add enrichment cache path and chat model constant**

In `generate-index.mjs`, after line 100 (`const markdownCachePath = ...`), add:

```js
/** Path for the enrichment cache (maps record IDs → metadata with content hashes) */
const enrichmentCachePath = path.join(outputDir, 'enrichment-cache.json');
/** Path for the normalization map (maps raw values → normalized values) */
const normalizationMapPath = path.join(outputDir, 'normalization-map.json');
```

After line 109 (`const MAX_EMBED_CHARS = config.maxEmbedChars;`), add:

```js
/** Cloudflare Workers AI chat model for enrichment */
const CHAT_MODEL = config.chatModel;
/** Maximum characters of article text sent to the enrichment model */
const MAX_ENRICH_CHARS = 4000;
```

**Step 2: Add enrichment cache load/save functions**

Add after the existing `saveCache` function (around line 549), before the `fetchEmbeddings` function:

```js
// ──────────────────────────────────────────────
// Enrichment Cache Management
// ──────────────────────────────────────────────

/**
 * Loads the enrichment cache from disk.
 * Cache format: { recordId: { hash: "...", metadata: { city, neighborhoods, ... } } }
 */
async function loadEnrichmentCache() {
  try {
    return JSON.parse(await fs.readFile(enrichmentCachePath, 'utf8'));
  } catch {
    return {};
  }
}

/**
 * Saves the enrichment cache to disk.
 */
async function saveEnrichmentCache(cache) {
  await fs.writeFile(enrichmentCachePath, JSON.stringify(cache), 'utf8');
}
```

**Step 3: Commit**

```bash
git add generate-index.mjs
git commit -m "feat(enrich): add enrichment cache infrastructure to generate-index.mjs"
```

---

## Task 2: Add the enrichment API call function

**Files:**
- Modify: `generate-index.mjs` (add after enrichment cache functions)

**Step 1: Read the enrichment prompt at startup**

Add after the `EXCLUDE_PATTERNS` definition (around line 118):

```js
/** Enrichment system prompt loaded from src/enrichment-prompt.md */
let ENRICHMENT_PROMPT;
try {
  ENRICHMENT_PROMPT = await fs.readFile(path.join(rootDir, 'src', 'enrichment-prompt.md'), 'utf8');
} catch {
  console.warn('Warning: src/enrichment-prompt.md not found. Enrichment will be skipped.');
}
```

**Step 2: Add the single-article enrichment function**

Add after `saveEnrichmentCache`:

```js
/**
 * Calls Workers AI to extract structured metadata from an article.
 * Returns parsed metadata object or null on failure.
 *
 * @param {string} text - Article body text (will be truncated to MAX_ENRICH_CHARS).
 * @returns {Promise<Object|null>} Metadata object or null on failure.
 */
async function fetchEnrichment(text) {
  const truncated = text.slice(0, MAX_ENRICH_CHARS);

  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/ai/run/${CHAT_MODEL}`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${CF_API_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messages: [
          { role: 'system', content: ENRICHMENT_PROMPT },
          { role: 'user', content: truncated },
        ],
        max_tokens: 1024,
        temperature: 0.1,
      }),
    }
  );

  const data = await res.json();
  if (!data.success || !data.result?.response) {
    console.error(`  Enrichment API error: ${JSON.stringify(data.errors || []).slice(0, 200)}`);
    return null;
  }

  const response = data.result.response;

  // Workers AI may return response as parsed object or string
  if (typeof response === 'object') return response;

  try {
    return JSON.parse(response.trim());
  } catch {
    // Try to extract JSON from markdown fencing
    const match = response.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (match) {
      try { return JSON.parse(match[1].trim()); } catch { /* fall through */ }
    }
    console.error(`  Enrichment: invalid JSON response for article`);
    return null;
  }
}

/**
 * Fetches enrichment with retry logic.
 * Retries once on failure with a 3s delay.
 */
async function fetchEnrichmentWithRetry(text) {
  const result = await fetchEnrichment(text);
  if (result !== null) return result;

  // Retry once after 3s
  await new Promise(r => setTimeout(r, 3000));
  return fetchEnrichment(text);
}
```

**Step 3: Commit**

```bash
git add generate-index.mjs
git commit -m "feat(enrich): add Workers AI enrichment API call with retry"
```

---

## Task 3: Add the enrichRecords function

**Files:**
- Modify: `generate-index.mjs` (add after fetchEnrichmentWithRetry)

**Step 1: Add the main enrichment orchestrator**

```js
// ============================================================
// Article Enrichment with Cache
// ============================================================

/** Empty metadata template for failed enrichments */
const EMPTY_METADATA = {
  city: null,
  neighborhoods: [],
  places: [],
  dishes: [],
  categories: [],
  cuisine_type: [],
  occasion: [],
};

/**
 * Enriches all records with structured metadata via Workers AI.
 * Uses content-hash caching to skip unchanged articles.
 *
 * @param {Object[]} records - Array of index records to enrich.
 * @returns {Promise<Object[]>} Array of metadata objects (parallel to records).
 */
async function enrichRecords(records) {
  if (!ENRICHMENT_PROMPT) {
    console.log('  Skipping enrichment (enrichment prompt not loaded)');
    return records.map(() => ({ ...EMPTY_METADATA }));
  }

  if (!CF_ACCOUNT_ID || !CF_API_TOKEN) {
    console.log('  Skipping enrichment (CF_ACCOUNT_ID and CF_API_TOKEN not set)');
    return records.map(() => ({ ...EMPTY_METADATA }));
  }

  const cache = await loadEnrichmentCache();
  const toEnrich = [];
  const metadata = new Array(records.length);

  // Check cache for each record
  for (let i = 0; i < records.length; i++) {
    const hash = contentHash(records[i].text);
    if (cache[records[i].id]?.hash === hash) {
      metadata[i] = cache[records[i].id].metadata;
    } else {
      toEnrich.push({ index: i, hash, id: records[i].id });
    }
  }

  const cached = records.length - toEnrich.length;
  if (cached > 0) console.log(`  Enrichment cache: ${cached} cached, ${toEnrich.length} to enrich`);

  let failed = 0;

  for (let i = 0; i < toEnrich.length; i++) {
    const item = toEnrich[i];
    const record = records[item.index];

    const result = await fetchEnrichmentWithRetry(record.text);
    if (result) {
      metadata[item.index] = result;
      cache[item.id] = { hash: item.hash, metadata: result };
    } else {
      failed++;
      metadata[item.index] = { ...EMPTY_METADATA };
      cache[item.id] = { hash: item.hash, metadata: { ...EMPTY_METADATA } };
    }

    // Progress logging every 50 records
    if ((i + 1) % 50 === 0 || i === toEnrich.length - 1) {
      console.log(`  Enrichment: ${i + 1}/${toEnrich.length} (${failed} failed)`);
    }

    // Save cache every 50 records (crash protection)
    if ((i + 1) % 50 === 0) await saveEnrichmentCache(cache);

    // Rate limiting: 1.5s between API calls
    if (i < toEnrich.length - 1) {
      await new Promise(r => setTimeout(r, 1500));
    }
  }

  // Final cache save
  await saveEnrichmentCache(cache);

  if (failed > 0) console.log(`  Enrichment complete: ${failed} articles failed (stored with empty metadata)`);

  return metadata;
}
```

**Step 2: Commit**

```bash
git add generate-index.mjs
git commit -m "feat(enrich): add enrichRecords function with cache and rate limiting"
```

---

## Task 4: Add normalization map generation

**Files:**
- Modify: `generate-index.mjs` (add after enrichRecords)

**Step 1: Add the normalization functions**

```js
// ============================================================
// Normalization Map
// ============================================================

/**
 * Loads the normalization map from disk.
 * @returns {Promise<Object>} Map of raw → normalized values.
 */
async function loadNormalizationMap() {
  try {
    return JSON.parse(await fs.readFile(normalizationMapPath, 'utf8'));
  } catch {
    return {};
  }
}

/**
 * Collects all unique values across specified fields from enrichment metadata.
 * @param {Object[]} metadataList - Array of metadata objects.
 * @param {string[]} fields - Field names to collect from.
 * @returns {Set<string>} Set of unique lowercase values.
 */
function collectUniqueValues(metadataList, fields) {
  const values = new Set();
  for (const meta of metadataList) {
    for (const field of fields) {
      const arr = meta[field];
      if (Array.isArray(arr)) {
        arr.forEach(v => { if (typeof v === 'string' && v.trim()) values.add(v.trim().toLowerCase()); });
      }
    }
  }
  return values;
}

/**
 * Generates or updates the normalization map by asking the LLM to cluster synonyms.
 * Only calls the LLM if new values are found that aren't in the existing map.
 *
 * @param {Object[]} metadataList - Array of enrichment metadata objects.
 * @returns {Promise<Object>} Updated normalization map.
 */
async function buildNormalizationMap(metadataList) {
  const fieldsToNormalize = ['categories', 'cuisine_type', 'occasion', 'dishes'];
  const allValues = collectUniqueValues(metadataList, fieldsToNormalize);
  const existingMap = await loadNormalizationMap();
  const knownValues = new Set(Object.keys(existingMap).concat(Object.values(existingMap)));

  // Check for new values not yet in the map
  const newValues = [...allValues].filter(v => !knownValues.has(v));

  if (newValues.length === 0) {
    console.log('  Normalization: no new values found, reusing existing map');
    return existingMap;
  }

  console.log(`  Normalization: ${newValues.length} new values found, running LLM clustering...`);

  // Build the full value list for clustering (LLM needs all values for consistent clusters)
  const allValuesList = [...allValues].sort();

  const prompt = `Je krijgt een lijst met termen die zijn geëxtraheerd uit artikelen. Groepeer synoniemen en varianten onder één gestandaardiseerde term (bij voorkeur Nederlands).

Regels:
- Antwoord met ALLEEN valid JSON. Geen uitleg, geen markdown fencing.
- Het JSON object mapt elke variant naar de gestandaardiseerde term: {"variant": "standaard", ...}
- Termen die al gestandaardiseerd zijn hoeven niet in het resultaat.
- Gebruik Nederlandse termen als standaard waar mogelijk (bijv. "dinner" → "diner", "Italian" → "Italiaans").
- Houd termen die duidelijk verschillend zijn apart (bijv. "koffie" en "cocktails" zijn geen synoniemen).

Termen om te clusteren:
${allValuesList.join(', ')}`;

  try {
    const res = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/ai/run/${CHAT_MODEL}`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${CF_API_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messages: [
            { role: 'system', content: 'Je bent een taalkundige assistent die synoniemen clustert.' },
            { role: 'user', content: prompt },
          ],
          max_tokens: 4096,
          temperature: 0.1,
        }),
      }
    );

    const data = await res.json();
    if (!data.success || !data.result?.response) {
      console.warn('  Normalization: LLM call failed, keeping existing map');
      return existingMap;
    }

    const response = data.result.response;
    let newMap;
    if (typeof response === 'object') {
      newMap = response;
    } else {
      try {
        newMap = JSON.parse(response.trim());
      } catch {
        const match = response.match(/```(?:json)?\s*([\s\S]*?)```/);
        if (match) {
          try { newMap = JSON.parse(match[1].trim()); } catch { /* fall through */ }
        }
      }
    }

    if (!newMap || typeof newMap !== 'object') {
      console.warn('  Normalization: could not parse LLM response, keeping existing map');
      return existingMap;
    }

    // Merge new map into existing (new entries override)
    const merged = { ...existingMap, ...newMap };
    await fs.writeFile(normalizationMapPath, JSON.stringify(merged, null, 2), 'utf8');
    console.log(`  Normalization: ${Object.keys(newMap).length} mappings from LLM, ${Object.keys(merged).length} total`);
    return merged;

  } catch (err) {
    console.warn(`  Normalization: error — ${err.message}. Keeping existing map`);
    return existingMap;
  }
}

/**
 * Applies the normalization map to a metadata object.
 * Adds `_normalized` suffixed fields alongside the raw values.
 *
 * @param {Object} metadata - Raw enrichment metadata.
 * @param {Object} normMap - Normalization map (raw → normalized).
 * @returns {Object} Metadata with both raw and normalized values.
 */
function applyNormalization(metadata, normMap) {
  const normalize = (arr) => {
    if (!Array.isArray(arr)) return arr;
    return arr.map(v => {
      const key = typeof v === 'string' ? v.trim().toLowerCase() : v;
      return normMap[key] || v;
    });
  };

  return {
    ...metadata,
    categories_normalized: normalize(metadata.categories),
    cuisine_type_normalized: normalize(metadata.cuisine_type),
    occasion_normalized: normalize(metadata.occasion),
    dishes_normalized: normalize(metadata.dishes),
  };
}
```

**Step 2: Commit**

```bash
git add generate-index.mjs
git commit -m "feat(enrich): add normalization map generation and application"
```

---

## Task 5: Add keywords population helper

**Files:**
- Modify: `generate-index.mjs` (add after applyNormalization)

**Step 1: Add the keywords builder**

```js
/**
 * Builds a keywords array from enrichment metadata.
 * Combines place names, dish names, and category names.
 * These keywords boost the existing keyword scorer in retrieval.js.
 *
 * @param {Object} metadata - Enrichment metadata (with normalization applied).
 * @returns {string[]} Array of keyword strings.
 */
function buildKeywords(metadata) {
  const keywords = new Set();

  // Add place names
  if (Array.isArray(metadata.places)) {
    metadata.places.forEach(p => {
      if (p?.name) keywords.add(p.name);
    });
  }

  // Add dishes (use normalized if available)
  const dishes = metadata.dishes_normalized || metadata.dishes || [];
  dishes.forEach(d => { if (d) keywords.add(d); });

  // Add categories (use normalized if available)
  const cats = metadata.categories_normalized || metadata.categories || [];
  cats.forEach(c => { if (c) keywords.add(c); });

  // Add cuisine types (use normalized if available)
  const cuisines = metadata.cuisine_type_normalized || metadata.cuisine_type || [];
  cuisines.forEach(c => { if (c) keywords.add(c); });

  return [...keywords];
}
```

**Step 2: Commit**

```bash
git add generate-index.mjs
git commit -m "feat(enrich): add keywords population from enrichment metadata"
```

---

## Task 6: Integrate enrichment into the main pipeline

**Files:**
- Modify: `generate-index.mjs:667-709` (the `main()` function)

**Step 1: Update the main function**

Replace the current `main()` function with:

```js
async function main() {
  // Validate required credentials
  if (!CF_ACCOUNT_ID || !CF_API_TOKEN) {
    console.error('Set CF_ACCOUNT_ID and CF_API_TOKEN environment variables.');
    process.exit(1);
  }

  // Ensure output directory exists (creates recursively if needed)
  await fs.mkdir(outputDir, { recursive: true });

  // Step 1: Discover all indexable URLs from the sitemap
  const urls = await fetchSitemapUrls();

  // Step 2: Fetch markdown content for each page (cached + rate-limited)
  console.log(`\nFetching markdown for ${urls.length} pages...`);
  const pages = await fetchAllMarkdown(urls);
  console.log(`\nGot markdown for ${pages.length} pages`);

  // Step 3: Build index records, filtering out thin pages (< 50 chars of text)
  const records = pages
    .filter((p) => p.markdown && cleanMarkdown(p.markdown).length > 50)
    .map(buildRecord);
  // Sort by publication date (newest first) for consistent ordering
  records.sort((a, b) => (b.datePublished || '').localeCompare(a.datePublished || ''));
  console.log(`Built ${records.length} index records (filtered out ${pages.length - records.length} thin pages)`);

  // Step 4: Enrich records with structured metadata (cached — only new/changed content)
  console.log(`\nEnriching ${records.length} records with metadata...`);
  const metadataList = await enrichRecords(records);

  // Step 5: Build normalization map from enrichment output
  console.log(`\nBuilding normalization map...`);
  const normMap = await buildNormalizationMap(metadataList);

  // Step 6: Attach metadata to records and populate keywords
  for (let i = 0; i < records.length; i++) {
    const normalizedMeta = applyNormalization(metadataList[i], normMap);
    records[i].metadata = normalizedMeta;
    records[i].keywords = buildKeywords(normalizedMeta);
  }

  // Step 7: Generate vector embeddings (cached — only new/changed content)
  // Note: keywords are now populated, so embeddingInput() includes them
  console.log(`\nGenerating embeddings for ${records.length} records...`);
  const embeddings = await generateEmbeddings(records);
  // Attach embeddings to their corresponding records
  for (let i = 0; i < records.length; i++) {
    records[i].embedding = embeddings[i];
  }

  // Step 8: Write the index files
  const json = JSON.stringify(records, null, 2) + '\n';
  await fs.writeFile(outputJsonPath, json, 'utf8');         // Raw JSON (for debugging)
  await fs.writeFile(outputModulePath, `export default ${json};`, 'utf8');  // ESM module

  // Summary
  const sizeKB = Math.round(Buffer.byteLength(json) / 1024);
  const enriched = metadataList.filter(m => m.city !== null).length;
  console.log(`\nGenerated ChatJPT index: ${records.length} records (${sizeKB}KB)`);
  console.log(`  Enriched: ${enriched}/${records.length} articles with metadata`);
  console.log(`  Normalization map: ${Object.keys(normMap).length} mappings`);
}
```

**Step 2: Commit**

```bash
git add generate-index.mjs
git commit -m "feat(enrich): integrate enrichment + normalization into main pipeline"
```

---

## Task 7: Test the enrichment pipeline

**Step 1: Run a dry test on a small subset**

To test without enriching all 1500 articles, temporarily test with the validation script first to ensure the cache mechanism works:

Run:
```bash
node scripts/validate-enrichment.mjs
```

Expected: Same results as before — confirms Workers AI is still responding correctly.

**Step 2: Run the full pipeline**

Run:
```bash
node generate-index.mjs
```

Expected output pattern:
```
Fetching sitemap: https://cityguys.nl/sitemap.xml
  ...
Found XXXX URLs, XXXX after filtering

Fetching markdown for XXXX pages...
  Markdown: 50/XXXX (XX cached, X failed)
  ...

Built XXXX index records (filtered out X thin pages)

Enriching XXXX records with metadata...
  Enrichment cache: 0 cached, XXXX to enrich
  Enrichment: 50/XXXX (0 failed)
  Enrichment: 100/XXXX (0 failed)
  ...

Building normalization map...
  Normalization: XXX new values found, running LLM clustering...
  Normalization: XX mappings from LLM, XX total

Generating embeddings for XXXX records...
  ...

Generated ChatJPT index: XXXX records (XXXXKB)
  Enriched: XXXX/XXXX articles with metadata
  Normalization map: XX mappings
```

This will take ~40-60 minutes on first run (1500 articles × 1.5s rate limit). The enrichment cache will persist so subsequent runs are fast.

**Step 3: Verify cache works**

Run again immediately:
```bash
node generate-index.mjs
```

Expected: Enrichment step should show all records cached (0 to enrich). The full run should complete in seconds.

**Step 4: Spot-check enrichment quality**

Check a few records in `src/generated/chatjpt-index.json`:
```bash
node -e "
const records = JSON.parse(require('fs').readFileSync('src/generated/chatjpt-index.json', 'utf8'));
const samples = records.filter(r => r.metadata?.city).slice(0, 5);
samples.forEach(r => {
  console.log(r.id, '→', r.metadata.city, '|', r.metadata.categories?.join(', '));
  console.log('  keywords:', r.keywords.slice(0, 8).join(', '));
  console.log();
});
"
```

**Step 5: Check the normalization map**

```bash
node -e "
const map = JSON.parse(require('fs').readFileSync('src/generated/normalization-map.json', 'utf8'));
console.log('Total mappings:', Object.keys(map).length);
Object.entries(map).slice(0, 20).forEach(([k, v]) => console.log('  ', k, '→', v));
"
```

**Step 6: Commit**

```bash
git add generate-index.mjs
git commit -m "feat(enrich): verified enrichment pipeline on full article set"
```

---

## Task 8: Update Linear

**Step 1: Mark VRE-412 as Done**

Mark VRE-412 as complete — all ~1500 articles enriched, normalization map built, keywords populated, cache working.

---

## Verification Checklist

Before marking complete, verify:

- [ ] `src/generated/enrichment-cache.json` exists and contains ~1500 entries
- [ ] `src/generated/normalization-map.json` exists with synonym mappings
- [ ] `src/generated/chatjpt-index.json` records have `metadata` and populated `keywords`
- [ ] Warm re-run completes in seconds (all cached)
- [ ] Spot-check confirms extraction quality across article types
- [ ] All changes committed
