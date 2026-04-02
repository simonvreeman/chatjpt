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
 * 4. Generate embeddings → Cloudflare Workers AI (BGE model, 768 dimensions)
 * 5. Write output → JSON + ESM index files
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

// ── Cloudflare API credentials ───────────────
const CF_ACCOUNT_ID = process.env.CF_ACCOUNT_ID;
const CF_API_TOKEN = process.env.CF_API_TOKEN;

// ── Model and content settings ───────────────
/** Cloudflare Workers AI embedding model identifier */
const EMBEDDING_MODEL = config.embeddingModel;
/** Maximum characters of document text sent to the embedding model */
const MAX_EMBED_CHARS = config.maxEmbedChars;

/**
 * Pre-compiled regex patterns for URL exclusion.
 * Compiled once at startup from config.crawl.excludePatterns for performance.
 */
const EXCLUDE_PATTERNS = (config.crawl.excludePatterns || []).map(
  (p) => new RegExp(p, 'i')
);

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
// Main — Orchestrates the full index generation pipeline
// ============================================================

/**
 * Main entry point for the index generation pipeline.
 *
 * Steps:
 * 1. Validate credentials (CF_ACCOUNT_ID + CF_API_TOKEN required)
 * 2. Ensure output directory exists
 * 3. Fetch sitemap URLs and filter by exclude patterns
 * 4. Fetch markdown for each page (with caching + rate limiting)
 * 5. Build index records (clean text, extract titles, assign types)
 * 6. Filter out "thin" pages (< 50 chars of clean text)
 * 7. Generate embeddings (with caching + batching)
 * 8. Write output files (JSON + ESM)
 *
 * The entire process is idempotent: running it multiple times with warm
 * caches produces the same output, and only processes changed content.
 */
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

  // Step 4: Generate vector embeddings (cached — only new/changed content)
  console.log(`\nGenerating embeddings for ${records.length} records...`);
  const embeddings = await generateEmbeddings(records);
  // Attach embeddings to their corresponding records
  for (let i = 0; i < records.length; i++) {
    records[i].embedding = embeddings[i];
  }

  // Step 5: Write the index files
  const json = JSON.stringify(records, null, 2) + '\n';
  await fs.writeFile(outputJsonPath, json, 'utf8');         // Raw JSON (for debugging)
  await fs.writeFile(outputModulePath, `export default ${json};`, 'utf8');  // ESM module

  // Summary
  const sizeKB = Math.round(Buffer.byteLength(json) / 1024);
  console.log(`\nGenerated ChatJPT index: ${records.length} records (${sizeKB}KB)`);
}

// Run the pipeline and exit on error
main().catch((err) => {
  console.error(err);
  process.exit(1);
});
