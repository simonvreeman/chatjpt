#!/usr/bin/env node

/**
 * ChatJPT — Index Generator
 *
 * Offline build script that creates the searchable index for the ChatJPT Worker.
 * This script crawls a website via its sitemap, converts each page to markdown,
 * generates vector embeddings, and outputs the complete index as JSON + ESM files.
 *
 * The generated index is bundled directly into the Cloudflare Worker at deploy time,
 * enabling fast in-memory search at the edge without any database or external service.
 *
 * Pipeline:
 * 1. Fetch sitemap(s) → discover all indexable URLs
 * 2. Fetch markdown for each URL → Cloudflare Browser Rendering API
 * 3. Build records → clean text, extract titles, create schema.org objects
 * 4. Enrich records → extract structured metadata via Workers AI (cached)
 * 5. Build normalization map → cluster synonyms via LLM
 * 6. Generate embeddings → Cloudflare Workers AI (BGE model, 768 dimensions)
 * 7. Write output → JSON + ESM index files
 *
 * Caching strategy:
 * - **Markdown cache** (markdown-cache.json): Maps URL → markdown text.
 *   Pages already in the cache are not re-fetched, saving API calls and time.
 *   Cache is saved every 50 pages to prevent data loss on interruption.
 *
 * - **Embedding cache** (embedding-cache.json): Maps record ID → { hash, embedding }.
 *   Content is hashed (SHA-256, first 16 hex chars), so embeddings are only
 *   regenerated when the content actually changes. This makes re-indexing fast
 *   and cheap — typically only new/modified pages need new embeddings.
 *
 * Rate limiting:
 * - 1.5s delay between markdown fetch requests (Cloudflare API rate limits)
 * - 200ms delay between embedding batches (lighter endpoint)
 * - 3 retries with exponential backoff (5s, 10s, 15s) for failed fetches
 *
 * Usage:
 *   CF_ACCOUNT_ID=xxx CF_API_TOKEN=xxx node generate-index.mjs
 *
 * Or with .dev.vars file (auto-loaded):
 *   npm run generate
 *
 * Output files (written to config.outputDir):
 *   - chatjpt-index.json  → Raw JSON array (for inspection/debugging)
 *   - chatjpt-index.mjs   → ESM module (imported by the Worker)
 *   - embedding-cache.json → Persistent embedding cache
 *   - markdown-cache.json  → Persistent markdown cache
 */

import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

// ──────────────────────────────────────────────
// Environment Setup
// ──────────────────────────────────────────────

/**
 * Auto-load .dev.vars file if present.
 * This file contains CF_ACCOUNT_ID and CF_API_TOKEN for local development.
 * Format: KEY=VALUE (one per line, # comments supported).
 * Environment variables already set take precedence (won't be overwritten).
 */
const rootDir = process.cwd();
try {
  const vars = await fs.readFile(path.join(rootDir, '.dev.vars'), 'utf8');
  for (const line of vars.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;  // Skip empty lines and comments
    const eq = trimmed.indexOf('=');
    if (eq > 0) {
      const key = trimmed.slice(0, eq).trim();
      const val = trimmed.slice(eq + 1).trim();
      if (!process.env[key]) process.env[key] = val;   // Don't override existing env vars
    }
  }
} catch { /* No .dev.vars file — rely on environment variables */ }

// ──────────────────────────────────────────────
// Configuration Loading
// ──────────────────────────────────────────────

/** @type {Object} Project configuration from chatjpt.config.mjs */
let config;
try {
  config = (await import(path.join(rootDir, 'chatjpt.config.mjs'))).default;
} catch {
  console.error('Missing chatjpt.config.mjs in project root.');
  process.exit(1);
}

// ── Derived paths ────────────────────────────
/** Directory for all generated output files */
const outputDir = path.join(rootDir, config.outputDir);
/** Path for the JSON index file */
const outputJsonPath = path.join(outputDir, `${config.indexFile}.json`);
/** Path for the ESM index module */
const outputModulePath = path.join(outputDir, `${config.indexFile}.mjs`);
/** Path for the embedding cache (maps record IDs → embeddings with content hashes) */
const embeddingCachePath = path.join(outputDir, 'embedding-cache.json');
/** Path for the markdown cache (maps URLs → fetched markdown text) */
const markdownCachePath = path.join(outputDir, 'markdown-cache.json');
const enrichmentCachePath = path.join(outputDir, 'enrichment-cache.json');
const normalizationMapPath = path.join(outputDir, 'normalization-map.json');

// ── CLI / Env output-target flags ────────────
/**
 * Control which output targets are written during a generate run.
 *
 * CLI flags:    --skip-json  --skip-d1  --skip-vectorize  --d1-local
 * Env vars:     SKIP_JSON=1  SKIP_D1=1  SKIP_VECTORIZE=1  D1_LOCAL=1
 *
 * By default all three targets are active (JSON/ESM + D1 + Vectorize).
 * Use --skip-* to disable individual targets for incremental migrations.
 * Use --d1-local to execute against a local D1 SQLite file instead of remote.
 */
const _args = process.argv.slice(2);
const SKIP_JSON      = _args.includes('--skip-json')      || process.env.SKIP_JSON      === '1';
const SKIP_D1        = _args.includes('--skip-d1')        || process.env.SKIP_D1        === '1';
const SKIP_VECTORIZE = _args.includes('--skip-vectorize') || process.env.SKIP_VECTORIZE === '1';
const D1_LOCAL       = _args.includes('--d1-local')       || process.env.D1_LOCAL       === '1';

/** D1 database name — must match wrangler.toml [[d1_databases]] database_name */
const D1_DATABASE = 'chatjpt-db';
/** Vectorize index name — must match wrangler.toml [[vectorize]] index_name */
const VECTORIZE_INDEX = 'chatjpt-vectors';

// ── Cloudflare API credentials ───────────────
const CF_ACCOUNT_ID = process.env.CF_ACCOUNT_ID;
const CF_API_TOKEN = process.env.CF_API_TOKEN;

// ── Model and content settings ───────────────
/** Cloudflare Workers AI embedding model identifier */
const EMBEDDING_MODEL = config.embeddingModel;
/** Maximum characters of document text sent to the embedding model */
const MAX_EMBED_CHARS = config.maxEmbedChars;
const CHAT_MODEL = config.chatModel;
/** Maximum characters of article text sent to the enrichment model (balances context quality vs token cost) */
const MAX_ENRICH_CHARS = 4000;

/**
 * Pre-compiled regex patterns for URL exclusion.
 * Compiled once at startup from config.crawl.excludePatterns for performance.
 */
const EXCLUDE_PATTERNS = (config.crawl.excludePatterns || []).map(
  (p) => new RegExp(p, 'i')
);

let ENRICHMENT_PROMPT;
try {
  ENRICHMENT_PROMPT = await fs.readFile(path.join(rootDir, 'src', 'enrichment-prompt.md'), 'utf8');
} catch {
  console.warn('Warning: src/enrichment-prompt.md not found. Enrichment will be skipped.');
}

// ============================================================
// Sitemap Fetching
// ============================================================

/**
 * Extracts text content from XML tags using regex.
 * A lightweight XML parser — no need for a full XML library since sitemaps
 * have a simple, predictable structure.
 *
 * Handles two cases:
 * 1. Multi-line XML: standard regex matching `<tag>content</tag>`
 * 2. Single-line XML: fallback split-based parsing for minified XML
 *
 * @param {string} xml - Raw XML string.
 * @param {string} tag - Tag name to extract (e.g., 'loc' for URLs).
 * @returns {string[]} Array of text content found within the specified tags.
 */
function extractFromXml(xml, tag) {
  const results = [];
  const regex = new RegExp(`<${tag}>([^<]+)</${tag}>`, 'g');
  let match;
  while ((match = regex.exec(xml)) !== null) {
    results.push(match[1].trim());
  }
  // Fallback: handle single-line/minified XML where regex may miss matches
  if (results.length === 0) {
    const split = xml.split(`<${tag}>`);
    for (let i = 1; i < split.length; i++) {
      const end = split[i].indexOf(`</${tag}>`);
      if (end > -1) results.push(split[i].slice(0, end).trim());
    }
  }
  return results;
}

/**
 * Fetches all indexable URLs from the site's sitemap.
 *
 * Supports both:
 * - **Direct sitemap**: A single sitemap.xml containing <url><loc> entries
 * - **Sitemap index**: A <sitemapindex> pointing to multiple sub-sitemaps
 *   (common for large sites with 1000+ pages)
 *
 * After collecting all URLs, filters them through shouldIndex() to exclude
 * URLs matching the configured exclude patterns.
 *
 * @returns {Promise<string[]>} Array of indexable URLs.
 */
async function fetchSitemapUrls() {
  const sitemapUrl = config.crawl.sitemapUrl || `${config.siteUrl}/sitemap.xml`;
  console.log(`Fetching sitemap: ${sitemapUrl}`);

  const res = await fetch(sitemapUrl);
  if (!res.ok) throw new Error(`Failed to fetch sitemap: ${res.status}`);
  const xml = await res.text();

  // Detect whether this is a sitemap index (contains multiple sitemaps)
  const isSitemapIndex = xml.includes('<sitemapindex');
  let allUrls = [];

  if (isSitemapIndex) {
    // Sitemap index: fetch each sub-sitemap and collect URLs
    const sitemapLocs = extractFromXml(xml, 'loc');
    console.log(`  Sitemap index with ${sitemapLocs.length} sub-sitemaps`);

    for (const loc of sitemapLocs) {
      const subRes = await fetch(loc);
      if (!subRes.ok) {
        console.log(`  Skipping ${loc}: ${subRes.status}`);
        continue;
      }
      const subXml = await subRes.text();
      const urls = extractFromXml(subXml, 'loc');
      console.log(`  ${loc.split('/').pop()}: ${urls.length} URLs`);
      allUrls.push(...urls);
    }
  } else {
    // Direct sitemap: extract URLs directly
    allUrls = extractFromXml(xml, 'loc');
  }

  // Apply URL exclusion filters
  const filtered = allUrls.filter((url) => shouldIndex(url));
  console.log(`\nFound ${allUrls.length} URLs, ${filtered.length} after filtering`);
  return filtered;
}

// ============================================================
// Cloudflare Browser Rendering /markdown API
// ============================================================

/**
 * Fetches the markdown representation of a web page via the Cloudflare
 * Browser Rendering API.
 *
 * This API uses a headless browser to render the page (including JavaScript),
 * then converts the rendered DOM to clean markdown. This is significantly
 * better than raw HTML scraping because:
 * - It handles SPAs and JavaScript-rendered content
 * - It extracts readable text, stripping navigation, ads, and chrome
 * - The markdown is well-structured with headings, links, and lists
 *
 * @param {string} url - The full URL of the page to fetch.
 * @returns {Promise<string|null>} Markdown text, or null on failure.
 */
async function fetchMarkdown(url) {
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/browser-rendering/markdown`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${CF_API_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ url }),
    }
  );

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    console.error(`  /markdown HTTP ${res.status} for ${url}: ${text.slice(0, 200)}`);
    return null;
  }

  const data = await res.json();
  if (!data.success) {
    console.error(`  /markdown API error for ${url}: ${JSON.stringify(data.errors || data).slice(0, 200)}`);
    return null;
  }

  // Response format varies: may be a string directly or nested under .markdown
  const markdown = typeof data.result === 'string' ? data.result : data.result?.markdown || null;
  return markdown;
}

// ──────────────────────────────────────────────
// Markdown Cache Management
// ──────────────────────────────────────────────

/**
 * Loads the markdown cache from disk.
 * Returns an empty object if the cache file doesn't exist or is corrupt.
 *
 * @returns {Promise<Object>} Cache mapping URL → markdown text.
 */
async function loadMarkdownCache() {
  try {
    return JSON.parse(await fs.readFile(markdownCachePath, 'utf8'));
  } catch {
    return {};
  }
}

/**
 * Saves the markdown cache to disk (overwrites the entire file).
 *
 * @param {Object} cache - The cache object to persist.
 */
async function saveMarkdownCache(cache) {
  await fs.writeFile(markdownCachePath, JSON.stringify(cache), 'utf8');
}

/**
 * Fetches markdown for a URL with retry logic and exponential backoff.
 *
 * Retry strategy: up to 3 attempts with increasing delays:
 * - Attempt 1: immediate
 * - Attempt 2: 5s delay
 * - Attempt 3: 10s delay
 * - Attempt 4 (if retries=4): 15s delay
 *
 * This handles transient API errors and rate limiting gracefully.
 *
 * @param {string} url - The URL to fetch markdown for.
 * @param {number} [retries=3] - Maximum number of retry attempts.
 * @returns {Promise<string|null>} Markdown text, or null after all retries exhausted.
 */
async function fetchMarkdownWithRetry(url, retries = 3) {
  for (let attempt = 0; attempt < retries; attempt++) {
    const markdown = await fetchMarkdown(url);
    if (markdown !== null) return markdown;

    // Exponential backoff: 5s, 10s, 15s...
    const delay = (attempt + 1) * 5000;
    await new Promise((r) => setTimeout(r, delay));
  }
  return null;
}

/**
 * Fetches markdown for all URLs, using the cache to avoid redundant API calls.
 *
 * Processing strategy:
 * - Cached URLs are served instantly from disk
 * - Non-cached URLs are fetched sequentially with a 1.5s delay between requests
 *   (rate limiting protection for the Cloudflare Browser Rendering API)
 * - Cache is saved to disk every 50 pages (crash protection)
 * - Progress is logged every 50 pages
 *
 * @param {string[]} urls - Array of URLs to fetch markdown for.
 * @returns {Promise<Object[]>} Array of { url, markdown } objects (only successful fetches).
 */
async function fetchAllMarkdown(urls) {
  const mdCache = await loadMarkdownCache();
  const results = [];
  let completed = 0;
  let cached = 0;
  let failed = 0;

  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];

    // Use cached version if available (skip the API call entirely)
    if (mdCache[url]) {
      cached++;
      results.push({ url, markdown: mdCache[url] });
      completed++;
      if (completed % 50 === 0) {
        console.log(`  Markdown: ${completed}/${urls.length} (${cached} cached, ${failed} failed)`);
      }
      continue;
    }

    // Not cached — fetch from the API with retry logic
    try {
      const markdown = await fetchMarkdownWithRetry(url);
      if (markdown) {
        mdCache[url] = markdown;  // Store in cache for next run
        results.push({ url, markdown });
      } else {
        failed++;
      }
    } catch {
      failed++;
    }
    completed++;

    // Log progress every 50 pages or at the end
    if (completed % 50 === 0 || completed === urls.length) {
      console.log(`  Markdown: ${completed}/${urls.length} (${cached} cached, ${failed} failed)`);
    }

    // Save cache periodically to prevent data loss on interruption
    if (completed % 50 === 0) await saveMarkdownCache(mdCache);

    // Rate limiting: 1.5s delay between API requests (only for non-cached URLs)
    if (i < urls.length - 1 && !mdCache[urls[i + 1]]) {
      await new Promise((r) => setTimeout(r, 1500));
    }
  }

  // Final cache save (captures the last batch of fetches)
  await saveMarkdownCache(mdCache);
  return results;
}

// ============================================================
// Content Processing
// ============================================================

/**
 * Checks whether a URL should be included in the index.
 * Returns false if the URL matches any of the configured exclude patterns.
 *
 * @param {string} url - The URL to check.
 * @returns {boolean} True if the URL should be indexed.
 */
function shouldIndex(url) {
  return !EXCLUDE_PATTERNS.some((re) => re.test(url));
}

/**
 * Extracts a title from a page record.
 *
 * Priority:
 * 1. Pre-existing title field (from metadata)
 * 2. First H1 heading in the markdown (# Title)
 * 3. URL path segments as a fallback (e.g., "/food/pizza" → "food pizza")
 * 4. Raw URL as last resort
 *
 * @param {Object} page - Page object with { url, markdown, title? }.
 * @returns {string} The extracted title.
 */
function extractTitle(page) {
  if (page.title) return page.title;

  // Look for a markdown H1 heading
  const match = page.markdown.match(/^#\s+(.+)$/m);
  if (match) return match[1].trim();

  // Fall back to URL path segments
  const slug = new URL(page.url).pathname.replace(/\//g, ' ').trim();
  return slug || page.url;
}

/**
 * Cleans markdown text by removing formatting, images, links, and HTML tags.
 * Produces plain text suitable for search indexing and embedding generation.
 *
 * Transformations:
 * - ![alt](url) → removed (images)
 * - [text](url) → text (keep link text, remove URL)
 * - <tags> → removed (strip HTML)
 * - # headings → removed (strip heading markers)
 * - >, *, _, ~, | → removed (strip markdown formatting)
 * - Multiple whitespace → single space
 *
 * @param {string} md - Raw markdown text.
 * @returns {string} Clean plain text.
 */
function cleanMarkdown(md = '') {
  return md
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')      // Remove images
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')     // Links → link text only
    .replace(/<[^>]+>/g, ' ')                     // Strip HTML tags
    .replace(/^#{1,6}\s+/gm, '')                  // Remove heading markers
    .replace(/[>*_~|]/g, ' ')                     // Remove markdown formatting chars
    .replace(/\s+/g, ' ')                         // Collapse whitespace
    .trim();
}

/**
 * Builds a search index record from a crawled page.
 *
 * Each record contains all the data needed for search and display:
 * - Identity: id (relative path), url, site
 * - Content: name (title), description (first 280 chars), full text
 * - Metadata: type (WebPage or BlogPosting), datePublished, keywords
 * - Search: searchWeight (WebPage=1.2, BlogPosting=1.0)
 * - SEO: schema_object (schema.org structured data)
 *
 * The embedding field is added later by generateEmbeddings().
 *
 * @param {Object} page - Page object with { url, markdown }.
 * @returns {Object} Complete index record (without embedding).
 */
function buildRecord(page) {
  const url = new URL(page.url);
  const relativeUrl = url.pathname;
  const title = extractTitle(page);
  const bodyText = cleanMarkdown(page.markdown);
  const excerpt = bodyText.slice(0, 280);  // First 280 chars as description

  // Homepage gets WebPage type (higher search weight); everything else is BlogPosting
  const isHomepage = relativeUrl === '/';
  const type = isHomepage ? 'WebPage' : 'BlogPosting';

  return {
    id: relativeUrl,              // Unique identifier (URL path)
    url: relativeUrl,             // Relative URL (SITE_URL prepended at runtime)
    site: config.site,            // Site identifier
    name: title,                  // Document title
    type,                         // schema.org type
    description: excerpt,         // First 280 chars of body text
    datePublished: null,          // Not extracted from content (could be enhanced)
    keywords: [],                 // Empty by default (could be extracted from meta tags)
    searchWeight: type === 'WebPage' ? 1.2 : 1.0,  // WebPage gets a ranking boost
    text: bodyText,               // Full cleaned text for keyword search
    schema_object: {              // schema.org structured data
      '@context': 'https://schema.org',
      '@type': type,
      headline: title,
      url: relativeUrl,
      description: excerpt,
    },
  };
}

// ============================================================
// Embedding Generation with Cache
// ============================================================

/**
 * Generates a short content hash for cache invalidation.
 * Uses SHA-256 truncated to the first 16 hex characters (64 bits).
 * This is used to detect whether a document's content has changed
 * since its embedding was last generated.
 *
 * @param {string} text - The text content to hash.
 * @returns {string} 16-character hex hash string.
 */
function contentHash(text) {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

/**
 * Builds the text input for embedding generation from a record.
 * Concatenates the most important fields:
 * - Title (name): Highest signal for what the document is about
 * - Description: Summary/excerpt
 * - Keywords: Explicit topic tags
 * - Body text (truncated to MAX_EMBED_CHARS): Main content
 *
 * Truncation to MAX_EMBED_CHARS keeps embedding API costs predictable
 * and focuses the embedding on the most relevant content (typically the
 * beginning of an article, which contains the key information).
 *
 * @param {Object} record - An index record.
 * @returns {string} Concatenated text for the embedding model.
 */
function embeddingInput(record) {
  return [record.name, record.description, record.keywords.join(', '), record.text.slice(0, MAX_EMBED_CHARS)].join('\n');
}

// ──────────────────────────────────────────────
// Embedding Cache Management
// ──────────────────────────────────────────────

/**
 * Loads the embedding cache from disk.
 * Cache format: { recordId: { hash: "...", embedding: [...768 floats...] } }
 *
 * @returns {Promise<Object>} The embedding cache object.
 */
async function loadCache() {
  try {
    return JSON.parse(await fs.readFile(embeddingCachePath, 'utf8'));
  } catch {
    return {};
  }
}

/**
 * Saves the embedding cache to disk.
 *
 * @param {Object} cache - The cache object to persist.
 */
async function saveCache(cache) {
  await fs.writeFile(embeddingCachePath, JSON.stringify(cache), 'utf8');
}

// ──────────────────────────────────────────────
// Enrichment Cache Management
// ──────────────────────────────────────────────

async function loadEnrichmentCache() {
  try {
    return JSON.parse(await fs.readFile(enrichmentCachePath, 'utf8'));
  } catch {
    return {};
  }
}

async function saveEnrichmentCache(cache) {
  await fs.writeFile(enrichmentCachePath, JSON.stringify(cache), 'utf8');
}

// ──────────────────────────────────────────────
// Article Enrichment via Workers AI
// ──────────────────────────────────────────────

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

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    console.error(`  Enrichment HTTP ${res.status}: ${text.slice(0, 200)}`);
    return null;
  }

  const data = await res.json();
  if (!data.success || !data.result?.response) {
    console.error(`  Enrichment API error: ${JSON.stringify(data.errors || []).slice(0, 200)}`);
    return null;
  }

  const response = data.result.response;
  if (typeof response === 'object') return response;

  try {
    return JSON.parse(response.trim());
  } catch {
    const match = response.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (match) {
      try { return JSON.parse(match[1].trim()); } catch { /* fall through */ }
    }
    console.error(`  Enrichment: invalid JSON response`);
    return null;
  }
}

async function fetchEnrichmentWithRetry(text) {
  const result = await fetchEnrichment(text);
  if (result !== null) return result;
  await new Promise(r => setTimeout(r, 3000));
  return fetchEnrichment(text);
}

const EMPTY_METADATA = {
  city: null,
  neighborhoods: [],
  places: [],
  dishes: [],
  categories: [],
  cuisine_type: [],
  occasion: [],
};

async function enrichRecords(records) {
  if (!ENRICHMENT_PROMPT) {
    console.log('  Skipping enrichment (enrichment prompt not loaded)');
    return records.map(() => ({ ...EMPTY_METADATA }));
  }

  if (!CF_ACCOUNT_ID || !CF_API_TOKEN) {
    console.log('  Skipping enrichment (credentials not set)');
    return records.map(() => ({ ...EMPTY_METADATA }));
  }

  const cache = await loadEnrichmentCache();
  const toEnrich = [];
  const metadata = new Array(records.length);

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

    if ((i + 1) % 50 === 0 || i === toEnrich.length - 1) {
      console.log(`  Enrichment: ${i + 1}/${toEnrich.length} (${failed} failed)`);
    }

    if ((i + 1) % 50 === 0) await saveEnrichmentCache(cache);

    if (i < toEnrich.length - 1) {
      await new Promise(r => setTimeout(r, 1500));
    }
  }

  await saveEnrichmentCache(cache);

  if (failed > 0) console.log(`  Enrichment complete: ${failed} articles failed (stored with empty metadata)`);

  return metadata;
}

// ============================================================
// Normalization Map
// ============================================================

async function loadNormalizationMap() {
  try {
    return JSON.parse(await fs.readFile(normalizationMapPath, 'utf8'));
  } catch {
    return {};
  }
}

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

async function buildNormalizationMap(metadataList) {
  const fieldsToNormalize = ['categories', 'cuisine_type', 'occasion', 'dishes'];
  const allValues = collectUniqueValues(metadataList, fieldsToNormalize);
  const existingMap = await loadNormalizationMap();
  const knownValues = new Set(Object.keys(existingMap).concat(Object.values(existingMap)));

  const newValues = [...allValues].filter(v => !knownValues.has(v));

  if (newValues.length === 0) {
    console.log('  Normalization: no new values found, reusing existing map');
    return existingMap;
  }

  console.log(`  Normalization: ${newValues.length} new values found, running LLM clustering...`);

  // Send the full value set (not just new values) so the LLM can cluster consistently
  // across all terms. Sending only new values would miss cross-cluster relationships.
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

    if (!res.ok) {
      console.warn(`  Normalization: HTTP ${res.status}`);
      return existingMap;
    }

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

    const merged = { ...existingMap, ...newMap };
    await fs.writeFile(normalizationMapPath, JSON.stringify(merged, null, 2), 'utf8');
    console.log(`  Normalization: ${Object.keys(newMap).length} mappings from LLM, ${Object.keys(merged).length} total`);
    return merged;

  } catch (err) {
    console.warn(`  Normalization: error — ${err.message}. Keeping existing map`);
    return existingMap;
  }
}

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

function buildKeywords(metadata) {
  const keywords = new Set();

  if (Array.isArray(metadata.places)) {
    metadata.places.forEach(p => {
      if (p?.name) keywords.add(p.name);
    });
  }

  const dishes = metadata.dishes_normalized || metadata.dishes || [];
  dishes.forEach(d => { if (d) keywords.add(d); });

  const cats = metadata.categories_normalized || metadata.categories || [];
  cats.forEach(c => { if (c) keywords.add(c); });

  const cuisines = metadata.cuisine_type_normalized || metadata.cuisine_type || [];
  cuisines.forEach(c => { if (c) keywords.add(c); });

  return [...keywords];
}

// ──────────────────────────────────────────────
// Cloudflare Workers AI Embedding API
// ──────────────────────────────────────────────

/**
 * Calls the Cloudflare Workers AI embedding API for a batch of texts.
 * Returns an array of 768-dimensional vectors (one per input text).
 *
 * @param {string[]} texts - Array of text strings to embed (max ~100 per call).
 * @returns {Promise<number[][]>} Array of embedding vectors.
 * @throws {Error} If the API returns an error or unexpected format.
 */
async function fetchEmbeddings(texts) {
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/ai/run/${EMBEDDING_MODEL}`,
    {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${CF_API_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: texts }),
    }
  );
  const data = await res.json();
  if (!data.success || !data.result?.data) {
    throw new Error(`Embedding API error: ${JSON.stringify(data.errors)}`);
  }
  return data.result.data;
}

/**
 * Generates embeddings for all records, using the cache to skip unchanged content.
 *
 * Cache strategy:
 * 1. For each record, compute a content hash of its embedding input text
 * 2. If the cache has an entry with a matching hash → reuse the cached embedding
 * 3. Otherwise, add to the "to embed" queue
 * 4. Process the queue in batches of 20 (API batch limit)
 * 5. Save the updated cache to disk
 *
 * This makes re-indexing fast: only new or modified pages need new embeddings.
 * A full re-index of ~1500 pages with warm cache takes seconds instead of minutes.
 *
 * @param {Object[]} records - Array of index records to embed.
 * @returns {Promise<(number[]|null)[]>} Array of embeddings (parallel to records).
 *   Returns null for each record if credentials are not set.
 */
async function generateEmbeddings(records) {
  // Skip embedding generation if API credentials are not configured
  if (!CF_ACCOUNT_ID || !CF_API_TOKEN) {
    console.log('  Skipping embeddings (CF_ACCOUNT_ID and CF_API_TOKEN not set)');
    return records.map(() => null);
  }

  const cache = await loadCache();
  const toEmbed = [];                              // Records that need new embeddings
  const embeddings = new Array(records.length);    // Output array (parallel to records)

  // Check cache for each record
  for (let i = 0; i < records.length; i++) {
    const text = embeddingInput(records[i]);
    const hash = contentHash(text);
    if (cache[records[i].id]?.hash === hash) {
      // Cache hit: content hasn't changed, reuse existing embedding
      embeddings[i] = cache[records[i].id].embedding;
    } else {
      // Cache miss: queue for embedding generation
      toEmbed.push({ index: i, text, hash, id: records[i].id });
    }
  }

  const cached = records.length - toEmbed.length;
  if (cached > 0) console.log(`  Embedding cache: ${cached} cached, ${toEmbed.length} to generate`);

  // Process the queue in batches of 20 (API batch size limit)
  const BATCH_SIZE = 20;
  for (let i = 0; i < toEmbed.length; i += BATCH_SIZE) {
    const batch = toEmbed.slice(i, i + BATCH_SIZE);
    console.log(`  Embedding batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(toEmbed.length / BATCH_SIZE)} (${batch.length} items)...`);

    // Call the embedding API for this batch
    const vectors = await fetchEmbeddings(batch.map((b) => b.text));

    // Store results in both the output array and the cache
    for (let j = 0; j < batch.length; j++) {
      embeddings[batch[j].index] = vectors[j];
      cache[batch[j].id] = { hash: batch[j].hash, embedding: vectors[j] };
    }

    // Small delay between batches to avoid overwhelming the API
    if (i + BATCH_SIZE < toEmbed.length) await new Promise((r) => setTimeout(r, 200));
  }

  // Persist the updated cache to disk
  await saveCache(cache);
  return embeddings;
}

// ============================================================
// D1 Seeding
// ============================================================

/**
 * Escapes a JavaScript value into a safe SQL literal.
 * null/undefined → NULL, numbers → bare number, strings → single-quoted
 * with internal single quotes doubled (standard SQL escaping).
 *
 * @param {*} val - The value to escape.
 * @returns {string} SQL literal fragment.
 */
function sqlEscape(val) {
  if (val === null || val === undefined) return 'NULL';
  if (typeof val === 'number') return String(val);
  return "'" + String(val).replace(/'/g, "''") + "'";
}

/**
 * Builds INSERT OR REPLACE SQL for one article record plus its places.
 *
 * Arrays (keywords, neighborhoods, categories, cuisine_type, occasion, dishes)
 * are stored as JSON strings so they can be queried with json_each() in SQLite.
 * schema_object is serialized as a JSON string for the same reason.
 *
 * @param {Object} record - Fully-assembled index record (with .metadata attached).
 * @returns {string} One or more SQL statements ending with newlines.
 */
function recordToSQL(record) {
  const meta = record.metadata || {};
  const places = Array.isArray(meta.places) ? meta.places : [];

  const cats      = meta.categories_normalized  || meta.categories   || [];
  const cuisines  = meta.cuisine_type_normalized || meta.cuisine_type || [];
  const occasions = meta.occasion_normalized     || meta.occasion     || [];
  const dishes    = meta.dishes_normalized       || meta.dishes       || [];

  const articleSQL = `INSERT OR REPLACE INTO articles ` +
    `(id, url, site, name, type, description, date_published, keywords, ` +
    `search_weight, text, schema_object, city, neighborhoods, categories, ` +
    `cuisine_type, occasion, dishes, content_hash) VALUES (` +
    [
      sqlEscape(record.id),
      sqlEscape(record.url),
      sqlEscape(record.site),
      sqlEscape(record.name),
      sqlEscape(record.type),
      sqlEscape(record.description),
      sqlEscape(record.datePublished),
      sqlEscape(JSON.stringify(record.keywords || [])),
      record.searchWeight ?? 1.0,
      sqlEscape(record.text),
      sqlEscape(JSON.stringify(record.schema_object || null)),
      sqlEscape(meta.city || null),
      sqlEscape(JSON.stringify(Array.isArray(meta.neighborhoods) ? meta.neighborhoods : [])),
      sqlEscape(JSON.stringify(cats)),
      sqlEscape(JSON.stringify(cuisines)),
      sqlEscape(JSON.stringify(occasions)),
      sqlEscape(JSON.stringify(dishes)),
      sqlEscape(contentHash(record.text)),
    ].join(', ') + `);`;

  const placesLines = places
    .filter((p) => p?.name)
    .map((p) =>
      `INSERT OR REPLACE INTO article_places (article_id, name, neighborhood) VALUES (` +
      `${sqlEscape(record.id)}, ${sqlEscape(p.name)}, ${sqlEscape(p.neighborhood || null)});`
    );

  return [articleSQL, ...placesLines].join('\n');
}

/**
 * Seeds the D1 database with all article records.
 *
 * Strategy: generate SQL INSERT OR REPLACE statements in batches of 50 records,
 * write each batch to a temp SQL file, then execute via `wrangler d1 execute`.
 * Temp files are deleted after each successful or failed batch.
 *
 * Uses --remote by default (production D1). Pass --d1-local / D1_LOCAL=1 for
 * local SQLite development.
 *
 * @param {Object[]} records - Fully-assembled index records with .metadata.
 */
async function seedD1(records) {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const execFileAsync = promisify(execFile);

  const wranglerBin = path.join(rootDir, 'node_modules', '.bin', 'wrangler');
  const remoteFlag = D1_LOCAL ? '--local' : '--remote';
  const BATCH_SIZE = 50;
  let seeded = 0;
  let failed = 0;

  console.log(`\nSeeding D1 (${D1_DATABASE}) with ${records.length} articles [${remoteFlag}]...`);

  for (let i = 0; i < records.length; i += BATCH_SIZE) {
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(records.length / BATCH_SIZE);
    const chunk = records.slice(i, i + BATCH_SIZE);
    const sql = chunk.map(recordToSQL).join('\n') + '\n';
    const tmpFile = path.join(outputDir, `_d1-seed-${batchNum}.sql`);

    await fs.writeFile(tmpFile, sql, 'utf8');

    try {
      await execFileAsync(wranglerBin, [
        'd1', 'execute', D1_DATABASE,
        '--file', tmpFile,
        remoteFlag,
        '--yes',   // skip interactive confirmation prompts
      ]);
      seeded += chunk.length;
      console.log(`  D1 batch ${batchNum}/${totalBatches}: ${chunk.length} articles OK (${seeded} total)`);
    } catch (err) {
      failed += chunk.length;
      // Extract the meaningful part of wrangler's stderr for the log
      const detail = (err.stderr || err.message || '').split('\n').find((l) => l.trim()) || '';
      console.error(`  D1 batch ${batchNum}/${totalBatches} FAILED: ${detail}`);
    } finally {
      await fs.unlink(tmpFile).catch(() => {});
    }
  }

  console.log(`  D1 seeding complete: ${seeded} seeded, ${failed} failed`);
}

// ============================================================
// Vectorize Upsert
// ============================================================

/**
 * Upserts embeddings + metadata to the Cloudflare Vectorize index.
 *
 * Uses the Vectorize v2 REST API which accepts NDJSON (application/x-ndjson).
 * Each line is a JSON object: { id, values, metadata }.
 *
 * Metadata stored per vector (for filtering at query time):
 *   site, type, name, city, categories, cuisine_type, occasion
 * Arrays are stored as JSON strings because Vectorize metadata values must be
 * scalars (string | number | boolean) — not nested arrays/objects.
 *
 * Batches of up to 500 vectors per request (Vectorize v2 limit is 1000;
 * 500 is a safe default given large 768-dim float arrays).
 *
 * @param {Object[]} records - Fully-assembled index records with .metadata.
 * @param {(number[]|null)[]} embeddings - Parallel array of 768-dim embeddings.
 */
async function upsertVectorize(records, embeddings) {
  const BATCH_SIZE = 500;

  // Pair records with their embeddings; skip any with null embeddings
  const pairs = records
    .map((r, i) => ({ record: r, embedding: embeddings[i] }))
    .filter((p) => Array.isArray(p.embedding));

  if (pairs.length === 0) {
    console.log('\nVectorize: no embeddings to upsert (all null — skipping)');
    return;
  }

  console.log(`\nUpserting ${pairs.length} vectors to Vectorize (${VECTORIZE_INDEX})...`);
  let upserted = 0;

  for (let i = 0; i < pairs.length; i += BATCH_SIZE) {
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(pairs.length / BATCH_SIZE);
    const batch = pairs.slice(i, i + BATCH_SIZE);

    const ndjson = batch.map(({ record, embedding }) => {
      const meta = record.metadata || {};
      const cats      = meta.categories_normalized  || meta.categories   || [];
      const cuisines  = meta.cuisine_type_normalized || meta.cuisine_type || [];
      const occasions = meta.occasion_normalized     || meta.occasion     || [];
      return JSON.stringify({
        id: record.id,
        values: embedding,
        metadata: {
          site:         record.site,
          type:         record.type,
          name:         record.name,
          city:         meta.city || '',
          categories:   cats,
          cuisine_type: cuisines,
          occasion:     occasions,
        },
      });
    }).join('\n');

    let retries = 2;
    while (retries >= 0) {
      const res = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/vectorize/v2/indexes/${VECTORIZE_INDEX}/upsert`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${CF_API_TOKEN}`,
            'Content-Type': 'application/x-ndjson',
          },
          body: ndjson,
        }
      );

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        if (retries > 0) {
          console.warn(`  Vectorize batch ${batchNum}/${totalBatches} HTTP ${res.status} — retrying...`);
          await new Promise((r) => setTimeout(r, 3000));
          retries--;
          continue;
        }
        console.error(`  Vectorize batch ${batchNum}/${totalBatches} FAILED HTTP ${res.status}: ${body.slice(0, 200)}`);
        break;
      }

      const data = await res.json();
      if (!data.success) {
        console.error(`  Vectorize batch ${batchNum}/${totalBatches} API error: ${JSON.stringify(data.errors || []).slice(0, 200)}`);
        break;
      }

      upserted += batch.length;
      console.log(`  Vectorize batch ${batchNum}/${totalBatches}: ${batch.length} vectors OK (${upserted} total)`);
      break;
    }

    if (i + BATCH_SIZE < pairs.length) await new Promise((r) => setTimeout(r, 500));
  }

  console.log(`  Vectorize upsert complete: ${upserted}/${pairs.length} vectors`);
}

// ============================================================
// Main — Orchestrates the full index generation pipeline
// ============================================================

/**
 * Main entry point for the index generation pipeline.
 *
 * Steps:
 * 1.  Validate credentials (CF_ACCOUNT_ID + CF_API_TOKEN required)
 * 2.  Ensure output directory exists
 * 3.  Fetch sitemap URLs and filter by exclude patterns
 * 4.  Fetch markdown for each page (with caching + rate limiting)
 * 5.  Build index records (clean text, extract titles, assign types)
 * 6.  Enrich records with structured metadata via Workers AI (cached)
 * 7.  Build normalization map (cluster synonyms via LLM)
 * 8.  Attach metadata to records and populate keywords
 * 9.  Generate vector embeddings (with caching + batching)
 * 10. [unless --skip-json]      Write JSON + ESM index files
 * 11. [unless --skip-d1]        Seed D1 database via wrangler
 * 12. [unless --skip-vectorize] Upsert vectors to Vectorize
 *
 * All three output targets are active by default (backward-compatible).
 * Disable individual targets with --skip-json / --skip-d1 / --skip-vectorize
 * or the corresponding SKIP_JSON / SKIP_D1 / SKIP_VECTORIZE env vars.
 *
 * The entire process is idempotent: running it multiple times with warm
 * caches produces the same output, and only processes changed content.
 */
async function main() {
  if (!CF_ACCOUNT_ID || !CF_API_TOKEN) {
    console.error('Set CF_ACCOUNT_ID and CF_API_TOKEN environment variables.');
    process.exit(1);
  }

  // Log active output targets so the operator knows what will be written
  const targets = [
    !SKIP_JSON      && 'json+esm',
    !SKIP_D1        && `d1(${D1_LOCAL ? 'local' : 'remote'})`,
    !SKIP_VECTORIZE && 'vectorize',
  ].filter(Boolean);
  console.log(`Output targets: ${targets.join(', ') || '(none — all skipped)'}`);

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
  console.log(`\nGenerating embeddings for ${records.length} records...`);
  const embeddings = await generateEmbeddings(records);
  for (let i = 0; i < records.length; i++) {
    records[i].embedding = embeddings[i];
  }

  // Step 8: Write JSON + ESM index files (backward-compatible output)
  const json = JSON.stringify(records, null, 2) + '\n';
  if (!SKIP_JSON) {
    await fs.writeFile(outputJsonPath, json, 'utf8');
    await fs.writeFile(outputModulePath, `export default ${json};`, 'utf8');
    const sizeKB = Math.round(Buffer.byteLength(json) / 1024);
    console.log(`\nWrote JSON + ESM index: ${records.length} records (${sizeKB}KB)`);
  }

  // Step 9: Seed D1 database
  if (!SKIP_D1) {
    await seedD1(records);
  }

  // Step 10: Upsert embeddings to Vectorize
  if (!SKIP_VECTORIZE) {
    await upsertVectorize(records, embeddings);
  }

  // Summary
  const enriched = metadataList.filter(m => m.city !== null).length;
  console.log(`\nChatJPT index complete: ${records.length} records`);
  console.log(`  Enriched: ${enriched}/${records.length} articles with metadata`);
  console.log(`  Normalization map: ${Object.keys(normMap).length} mappings`);
  console.log(`  Targets written: ${targets.join(', ') || '(none)'}`);
}

// Run the pipeline and exit on error
main().catch((err) => {
  console.error(err);
  process.exit(1);
});
