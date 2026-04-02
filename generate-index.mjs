#!/usr/bin/env node

/**
 * ChatJPT Index Generator
 *
 * Fetches all URLs from the sitemap of cityguys.nl, converts each page
 * to markdown via the Cloudflare Browser Rendering /markdown API,
 * builds a searchable index with embeddings, and outputs JSON + ESM files.
 *
 * Usage:
 *   CF_ACCOUNT_ID=xxx CF_API_TOKEN=xxx node generate-index.mjs
 */

import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

// Load .dev.vars if present (so `npm run generate` just works)
const rootDir = process.cwd();
try {
  const vars = await fs.readFile(path.join(rootDir, '.dev.vars'), 'utf8');
  for (const line of vars.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq > 0) {
      const key = trimmed.slice(0, eq).trim();
      const val = trimmed.slice(eq + 1).trim();
      if (!process.env[key]) process.env[key] = val;
    }
  }
} catch { /* no .dev.vars, rely on env */ }

// Load config
let config;
try {
  config = (await import(path.join(rootDir, 'chatjpt.config.mjs'))).default;
} catch {
  console.error('Missing chatjpt.config.mjs in project root.');
  process.exit(1);
}

const outputDir = path.join(rootDir, config.outputDir);
const outputJsonPath = path.join(outputDir, `${config.indexFile}.json`);
const outputModulePath = path.join(outputDir, `${config.indexFile}.mjs`);
const embeddingCachePath = path.join(outputDir, 'embedding-cache.json');
const markdownCachePath = path.join(outputDir, 'markdown-cache.json');

const CF_ACCOUNT_ID = process.env.CF_ACCOUNT_ID;
const CF_API_TOKEN = process.env.CF_API_TOKEN;
const EMBEDDING_MODEL = config.embeddingModel;
const MAX_EMBED_CHARS = config.maxEmbedChars;

const EXCLUDE_PATTERNS = (config.crawl.excludePatterns || []).map(
  (p) => new RegExp(p, 'i')
);

// ============================================================
// Sitemap fetching
// ============================================================

function extractFromXml(xml, tag) {
  const results = [];
  const regex = new RegExp(`<${tag}>([^<]+)</${tag}>`, 'g');
  let match;
  while ((match = regex.exec(xml)) !== null) {
    results.push(match[1].trim());
  }
  // Handle single-line XML (no newlines between tags)
  if (results.length === 0) {
    const split = xml.split(`<${tag}>`);
    for (let i = 1; i < split.length; i++) {
      const end = split[i].indexOf(`</${tag}>`);
      if (end > -1) results.push(split[i].slice(0, end).trim());
    }
  }
  return results;
}

async function fetchSitemapUrls() {
  const sitemapUrl = config.crawl.sitemapUrl || `${config.siteUrl}/sitemap.xml`;
  console.log(`Fetching sitemap: ${sitemapUrl}`);

  const res = await fetch(sitemapUrl);
  if (!res.ok) throw new Error(`Failed to fetch sitemap: ${res.status}`);
  const xml = await res.text();

  // Check if it's a sitemap index
  const isSitemapIndex = xml.includes('<sitemapindex');
  let allUrls = [];

  if (isSitemapIndex) {
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
    allUrls = extractFromXml(xml, 'loc');
  }

  // Filter out excluded patterns
  const filtered = allUrls.filter((url) => shouldIndex(url));
  console.log(`\nFound ${allUrls.length} URLs, ${filtered.length} after filtering`);
  return filtered;
}

// ============================================================
// Cloudflare /markdown API
// ============================================================

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

  const markdown = typeof data.result === 'string' ? data.result : data.result?.markdown || null;
  return markdown;
}

async function loadMarkdownCache() {
  try {
    return JSON.parse(await fs.readFile(markdownCachePath, 'utf8'));
  } catch {
    return {};
  }
}

async function saveMarkdownCache(cache) {
  await fs.writeFile(markdownCachePath, JSON.stringify(cache), 'utf8');
}

async function fetchMarkdownWithRetry(url, retries = 3) {
  for (let attempt = 0; attempt < retries; attempt++) {
    const markdown = await fetchMarkdown(url);
    if (markdown !== null) return markdown;

    // Wait longer on each retry (rate limit backoff)
    const delay = (attempt + 1) * 5000;
    await new Promise((r) => setTimeout(r, delay));
  }
  return null;
}

async function fetchAllMarkdown(urls) {
  const mdCache = await loadMarkdownCache();
  const results = [];
  let completed = 0;
  let cached = 0;
  let failed = 0;

  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];

    // Use cache if available
    if (mdCache[url]) {
      cached++;
      results.push({ url, markdown: mdCache[url] });
      completed++;
      if (completed % 50 === 0) {
        console.log(`  Markdown: ${completed}/${urls.length} (${cached} cached, ${failed} failed)`);
      }
      continue;
    }

    try {
      const markdown = await fetchMarkdownWithRetry(url);
      if (markdown) {
        mdCache[url] = markdown;
        results.push({ url, markdown });
      } else {
        failed++;
      }
    } catch {
      failed++;
    }
    completed++;

    if (completed % 50 === 0 || completed === urls.length) {
      console.log(`  Markdown: ${completed}/${urls.length} (${cached} cached, ${failed} failed)`);
    }

    // Save cache every 50 pages
    if (completed % 50 === 0) await saveMarkdownCache(mdCache);

    // Delay between requests to stay under rate limit
    if (i < urls.length - 1 && !mdCache[urls[i + 1]]) {
      await new Promise((r) => setTimeout(r, 1500));
    }
  }

  await saveMarkdownCache(mdCache);
  return results;
}

// ============================================================
// Content processing
// ============================================================

function shouldIndex(url) {
  return !EXCLUDE_PATTERNS.some((re) => re.test(url));
}

function extractTitle(page) {
  if (page.title) return page.title;

  const match = page.markdown.match(/^#\s+(.+)$/m);
  if (match) return match[1].trim();

  const slug = new URL(page.url).pathname.replace(/\//g, ' ').trim();
  return slug || page.url;
}

function cleanMarkdown(md = '') {
  return md
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/[>*_~|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildRecord(page) {
  const url = new URL(page.url);
  const relativeUrl = url.pathname;
  const title = extractTitle(page);
  const bodyText = cleanMarkdown(page.markdown);
  const excerpt = bodyText.slice(0, 280);

  const isHomepage = relativeUrl === '/';
  const type = isHomepage ? 'WebPage' : 'BlogPosting';

  return {
    id: relativeUrl,
    url: relativeUrl,
    site: config.site,
    name: title,
    type,
    description: excerpt,
    datePublished: null,
    keywords: [],
    searchWeight: type === 'WebPage' ? 1.2 : 1.0,
    text: bodyText,
    schema_object: {
      '@context': 'https://schema.org',
      '@type': type,
      headline: title,
      url: relativeUrl,
      description: excerpt,
    },
  };
}

// ============================================================
// Embedding generation with cache
// ============================================================

function contentHash(text) {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

function embeddingInput(record) {
  return [record.name, record.description, record.keywords.join(', '), record.text.slice(0, MAX_EMBED_CHARS)].join('\n');
}

async function loadCache() {
  try {
    return JSON.parse(await fs.readFile(embeddingCachePath, 'utf8'));
  } catch {
    return {};
  }
}

async function saveCache(cache) {
  await fs.writeFile(embeddingCachePath, JSON.stringify(cache), 'utf8');
}

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

async function generateEmbeddings(records) {
  if (!CF_ACCOUNT_ID || !CF_API_TOKEN) {
    console.log('  Skipping embeddings (CF_ACCOUNT_ID and CF_API_TOKEN not set)');
    return records.map(() => null);
  }

  const cache = await loadCache();
  const toEmbed = [];
  const embeddings = new Array(records.length);

  for (let i = 0; i < records.length; i++) {
    const text = embeddingInput(records[i]);
    const hash = contentHash(text);
    if (cache[records[i].id]?.hash === hash) {
      embeddings[i] = cache[records[i].id].embedding;
    } else {
      toEmbed.push({ index: i, text, hash, id: records[i].id });
    }
  }

  const cached = records.length - toEmbed.length;
  if (cached > 0) console.log(`  Embedding cache: ${cached} cached, ${toEmbed.length} to generate`);

  const BATCH_SIZE = 20;
  for (let i = 0; i < toEmbed.length; i += BATCH_SIZE) {
    const batch = toEmbed.slice(i, i + BATCH_SIZE);
    console.log(`  Embedding batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(toEmbed.length / BATCH_SIZE)} (${batch.length} items)...`);
    const vectors = await fetchEmbeddings(batch.map((b) => b.text));
    for (let j = 0; j < batch.length; j++) {
      embeddings[batch[j].index] = vectors[j];
      cache[batch[j].id] = { hash: batch[j].hash, embedding: vectors[j] };
    }
    if (i + BATCH_SIZE < toEmbed.length) await new Promise((r) => setTimeout(r, 200));
  }

  await saveCache(cache);
  return embeddings;
}

// ============================================================
// Main
// ============================================================

async function main() {
  if (!CF_ACCOUNT_ID || !CF_API_TOKEN) {
    console.error('Set CF_ACCOUNT_ID and CF_API_TOKEN environment variables.');
    process.exit(1);
  }

  // Ensure output dir exists (needed for caches + index files)
  await fs.mkdir(outputDir, { recursive: true });

  // Step 1: Fetch all URLs from sitemap
  const urls = await fetchSitemapUrls();

  // Step 2: Fetch markdown for each page
  console.log(`\nFetching markdown for ${urls.length} pages...`);
  const pages = await fetchAllMarkdown(urls);
  console.log(`\nGot markdown for ${pages.length} pages`);

  // Step 3: Build records
  const records = pages
    .filter((p) => p.markdown && cleanMarkdown(p.markdown).length > 50)
    .map(buildRecord);
  records.sort((a, b) => (b.datePublished || '').localeCompare(a.datePublished || ''));
  console.log(`Built ${records.length} index records (filtered out ${pages.length - records.length} thin pages)`);

  // Step 4: Generate embeddings
  console.log(`\nGenerating embeddings for ${records.length} records...`);
  const embeddings = await generateEmbeddings(records);
  for (let i = 0; i < records.length; i++) {
    records[i].embedding = embeddings[i];
  }

  // Step 5: Write index files
  const json = JSON.stringify(records, null, 2) + '\n';
  await fs.writeFile(outputJsonPath, json, 'utf8');
  await fs.writeFile(outputModulePath, `export default ${json};`, 'utf8');

  const sizeKB = Math.round(Buffer.byteLength(json) / 1024);
  console.log(`\nGenerated ChatJPT index: ${records.length} records (${sizeKB}KB)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
