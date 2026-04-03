#!/usr/bin/env node

/**
 * Enrichment Prompt Validation Script
 *
 * Tests the enrichment prompt against sample articles from the markdown cache.
 * Calls Workers AI (Llama 3.3 70B) to extract metadata and prints the results
 * for manual review.
 *
 * Usage:
 *   CF_ACCOUNT_ID=xxx CF_API_TOKEN=xxx node scripts/validate-enrichment.mjs
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

// ── Load .dev.vars ──────────────────────────
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
} catch { /* No .dev.vars */ }

const CF_ACCOUNT_ID = process.env.CF_ACCOUNT_ID;
const CF_API_TOKEN = process.env.CF_API_TOKEN;

if (!CF_ACCOUNT_ID || !CF_API_TOKEN) {
  console.error('Set CF_ACCOUNT_ID and CF_API_TOKEN in .dev.vars or environment.');
  process.exit(1);
}

// ── Load config + prompt ────────────────────
const config = (await import(path.join(rootDir, 'chatjpt.config.mjs'))).default;
const enrichmentPrompt = await fs.readFile(path.join(rootDir, 'src', 'enrichment-prompt.md'), 'utf8');

// ── Load markdown cache ─────────────────────
const markdownCachePath = path.join(rootDir, config.outputDir, 'markdown-cache.json');
const markdownCache = JSON.parse(await fs.readFile(markdownCachePath, 'utf8'));
const allUrls = Object.keys(markdownCache);

// ── Select diverse sample articles ──────────
// Pick articles across different types for validation
const sampleUrls = [
  // Single-venue reviews (locations)
  allUrls.find(u => u.includes('/locations/') && markdownCache[u].length > 500),
  allUrls.filter(u => u.includes('/locations/'))[10],
  allUrls.filter(u => u.includes('/locations/'))[100],
  // Amsterdam city guides / listicles
  allUrls.find(u => u.includes('/amsterdam/beste-')),
  allUrls.find(u => u.includes('/amsterdam/') && u.includes('cocktail')),
  allUrls.find(u => u.includes('/amsterdam/') && u.includes('brunch')),
  // Other city guides
  allUrls.find(u => u.includes('/rotterdam/') && u !== 'https://cityguys.nl/rotterdam'),
  allUrls.find(u => u.includes('/den-haag/')),
  // International city trip
  allUrls.find(u => u.includes('/berlijn/') || u.includes('/kopenhagen/')),
  allUrls.find(u => u.includes('/tokyo/') || u.includes('/new-york/')),
  // Events
  allUrls.find(u => u.includes('/events/')),
  // Non-food / misc
  allUrls.find(u => u.includes('interview') || u.includes('fitness') || u.includes('hardloop')),
  // Homepage
  'https://cityguys.nl',
].filter(Boolean);

// Deduplicate
const uniqueSamples = [...new Set(sampleUrls)];

console.log(`\n=== Enrichment Prompt Validation ===`);
console.log(`Testing ${uniqueSamples.length} sample articles\n`);

// ── Call Workers AI ─────────────────────────
async function enrichArticle(markdown) {
  // Truncate very long articles to first 4000 chars for validation
  const truncated = markdown.slice(0, 4000);

  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/ai/run/${config.chatModel}`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${CF_API_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messages: [
          { role: 'system', content: enrichmentPrompt },
          { role: 'user', content: truncated },
        ],
        max_tokens: 1024,
        temperature: 0.1,
      }),
    }
  );

  const data = await res.json();
  if (!data.success || !data.result?.response) {
    return { error: JSON.stringify(data.errors || data).slice(0, 300) };
  }

  const response = data.result.response;

  // Workers AI may return response as a parsed object or as a string
  if (typeof response === 'object') {
    return response;
  }

  // Try to parse the JSON string response
  const raw = response.trim();
  try {
    return JSON.parse(raw);
  } catch {
    // Try to extract JSON from markdown fencing
    const match = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (match) {
      try { return JSON.parse(match[1].trim()); } catch { /* fall through */ }
    }
    return { error: 'Invalid JSON', raw: raw.slice(0, 500) };
  }
}

// ── Run validation ──────────────────────────
for (const url of uniqueSamples) {
  const markdown = markdownCache[url];
  if (!markdown) {
    console.log(`SKIP: ${url} (not in cache)\n`);
    continue;
  }

  const urlPath = new URL(url).pathname;
  console.log(`─── ${urlPath} ───`);
  console.log(`  Content length: ${markdown.length} chars`);
  console.log(`  First 100 chars: ${markdown.slice(0, 100).replace(/\n/g, ' ')}...`);

  const result = await enrichArticle(markdown);
  console.log(`  Result:`);
  console.log(JSON.stringify(result, null, 2).split('\n').map(l => '    ' + l).join('\n'));
  console.log();

  // Rate limiting: 1.5s between calls
  await new Promise(r => setTimeout(r, 1500));
}

console.log(`\n=== Validation complete ===`);
console.log(`Review the results above. Check for:`);
console.log(`  - Correct city extraction`);
console.log(`  - Reasonable categories (Dutch terms preferred)`);
console.log(`  - Places with correct neighborhoods`);
console.log(`  - No hallucinated data`);
console.log(`  - Valid JSON structure in all responses`);
