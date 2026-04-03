# VRE-410 + VRE-411 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Set up D1 + Vectorize infrastructure and design the article enrichment prompt.

**Architecture:** Sequential — VRE-410 infrastructure first (D1 database, Vectorize index, wrangler bindings), then VRE-411 enrichment prompt design (prompt file, validation script, test on sample articles). No Worker code changes — this is infra and prompt only.

**Tech Stack:** Cloudflare D1, Cloudflare Vectorize, Wrangler CLI, Workers AI (Llama 3.3 70B)

---

## Task 1: Create D1 database

**Files:**
- Modify: `wrangler.toml`

**Step 1: Create the D1 database**

Run:
```bash
npx wrangler d1 create chatjpt-db
```

Expected: Output containing a `database_id` UUID. Copy this ID.

**Step 2: Add D1 binding to wrangler.toml**

Add after the existing `[ai]` block:

```toml
# D1 database binding — article content and metadata
[[d1_databases]]
binding = "DB"
database_name = "chatjpt-db"
database_id = "<paste-database-id-here>"
```

**Step 3: Commit**

```bash
git add wrangler.toml
git commit -m "infra: add D1 database binding for chatjpt-db"
```

---

## Task 2: Create and apply D1 schema migration

**Files:**
- Create: `migrations/0001_init-schema.sql`

**Step 1: Create the migration file**

Run:
```bash
npx wrangler d1 migrations create chatjpt-db init-schema
```

Expected: Creates `migrations/0001_init-schema.sql` (empty).

**Step 2: Write the schema SQL**

Write to `migrations/0001_init-schema.sql`:

```sql
-- articles: main content table (replaces the bundled index records)
CREATE TABLE articles (
  id            TEXT PRIMARY KEY,
  url           TEXT NOT NULL,
  site          TEXT NOT NULL DEFAULT 'cityguys.nl',
  name          TEXT NOT NULL,
  type          TEXT NOT NULL DEFAULT 'BlogPosting',
  description   TEXT,
  date_published TEXT,
  keywords      TEXT,
  search_weight REAL NOT NULL DEFAULT 1.0,
  text          TEXT NOT NULL,
  schema_object TEXT,
  city          TEXT,
  neighborhoods TEXT,
  categories    TEXT,
  cuisine_type  TEXT,
  occasion      TEXT,
  dishes        TEXT,
  content_hash  TEXT
);

-- article_places: normalized table for the places array
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

**Step 3: Apply migration locally**

Run:
```bash
npx wrangler d1 migrations apply chatjpt-db --local
```

Expected: Migration applied successfully.

**Step 4: Apply migration to production**

Run:
```bash
npx wrangler d1 migrations apply chatjpt-db --remote
```

Expected: Migration applied successfully to remote D1.

**Step 5: Verify tables exist**

Run:
```bash
npx wrangler d1 execute chatjpt-db --local --command "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
```

Expected: Output showing `article_places` and `articles` tables.

**Step 6: Commit**

```bash
git add migrations/
git commit -m "infra: add D1 schema migration with articles and article_places tables"
```

---

## Task 3: Create Vectorize index

**Files:**
- Modify: `wrangler.toml`

**Step 1: Create the Vectorize index**

Run:
```bash
npx wrangler vectorize create chatjpt-vectors --dimensions=768 --metric=cosine
```

Expected: Vectorize index created successfully.

**Step 2: Create all 7 metadata indexes**

Run each command sequentially. All must complete before any vectors are inserted:

```bash
npx wrangler vectorize create-metadata-index chatjpt-vectors --property-name=city --type=string
npx wrangler vectorize create-metadata-index chatjpt-vectors --property-name=type --type=string
npx wrangler vectorize create-metadata-index chatjpt-vectors --property-name=category --type=string
npx wrangler vectorize create-metadata-index chatjpt-vectors --property-name=cuisine --type=string
npx wrangler vectorize create-metadata-index chatjpt-vectors --property-name=occasion --type=string
npx wrangler vectorize create-metadata-index chatjpt-vectors --property-name=neighborhood --type=string
npx wrangler vectorize create-metadata-index chatjpt-vectors --property-name=search_weight --type=number
```

Expected: Each command confirms the metadata index was created.

**Step 3: Verify the index**

Run:
```bash
npx wrangler vectorize get chatjpt-vectors
```

Expected: Shows index with 768 dimensions, cosine metric, and metadata indexes listed.

**Step 4: Add Vectorize binding to wrangler.toml**

Add after the `[[d1_databases]]` block:

```toml
# Vectorize index binding — vector search with metadata filtering
[[vectorize]]
binding = "VECTORIZE"
index_name = "chatjpt-vectors"
```

**Step 5: Commit**

```bash
git add wrangler.toml
git commit -m "infra: add Vectorize index binding with 7 metadata indexes"
```

---

## Task 4: Verify local dev works with new bindings

**Step 1: Run the dev server**

Run:
```bash
npm run dev
```

Expected: Server starts without binding errors. D1 and Vectorize are available locally via wrangler. The Worker still uses the bundled index — this is expected. We're just verifying the bindings don't break startup.

Note: If the dev server logs warnings about unused bindings, that's fine — the Worker code doesn't reference `env.DB` or `env.VECTORIZE` yet.

**Step 2: Stop the dev server**

Press Ctrl+C to stop.

---

## Task 5: Write the enrichment prompt

**Files:**
- Create: `src/enrichment-prompt.md`

**Step 1: Write the enrichment system prompt**

Create `src/enrichment-prompt.md` with the following content:

```markdown
Je bent een metadata-extractie assistent. Je ontvangt een artikel van Cityguys.nl en extraheert gestructureerde metadata als JSON.

Regels:
- Extraheer ALLEEN wat expliciet in het artikel staat. Verzin niets, gok niets, vul niets aan.
- Antwoord met ALLEEN valid JSON. Geen markdown fencing, geen uitleg, geen tekst eromheen.
- Gebruik Nederlandse termen waar mogelijk (bijv. "diner" niet "dinner", "Italiaans" niet "Italian").
- Als een veld niet van toepassing is of niet uit het artikel af te leiden is, gebruik dan een lege array [] of null.

JSON schema:

{
  "city": "Primaire stad van het artikel (string of null)",
  "neighborhoods": ["Wijken die worden genoemd (array van strings)"],
  "places": [{"name": "Naam van de plek", "city": "Stad", "neighborhood": "Wijk of null"}],
  "dishes": ["Specifieke gerechten of dranken die worden genoemd (array van strings)"],
  "categories": ["Type activiteit/gelegenheid, bijv. diner, lunch, koffie, cocktails, bier, wijn, ontbijt, borrel, late night, festival, fashion, cultuur (array van strings)"],
  "cuisine_type": ["Type keuken, bijv. Italiaans, Japans, Frans, Mexicaans (array van strings)"],
  "occasion": ["Soort gelegenheid, bijv. date night, met vrienden, solo, zakelijk, verjaardag (array van strings)"]
}

Specifieke instructies per veld:
- city: Als het artikel meerdere steden bespreekt, kies de stad die het meest centraal staat. Als het artikel niet over een specifieke stad gaat, gebruik null.
- neighborhoods: Alleen wijken/buurten die expliciet worden genoemd. Geen stadsdelen raden.
- places: Elke plek die in het artikel wordt genoemd met naam. Vul city en neighborhood in als die duidelijk zijn uit de context.
- dishes: Specifieke gerechten, dranken, of menu-items die worden beschreven. Geen generieke termen als "eten" of "drinken".
- categories: Wat voor type content is dit? Meerdere categorieën zijn mogelijk. Voor niet-food artikelen gebruik termen als "fashion", "cultuur", "reizen", "fitness".
- cuisine_type: Alleen als er een specifiek type keuken wordt genoemd of duidelijk is uit de context. Laat leeg als het niet van toepassing is.
- occasion: Alleen als het artikel expliciet een gelegenheid noemt of sterk impliceert. "Romantisch diner" = "date night". "Met z'n allen aan de borrel" = "met vrienden".
```

**Step 2: Commit**

```bash
git add src/enrichment-prompt.md
git commit -m "feat: add enrichment prompt for structured metadata extraction"
```

---

## Task 6: Create enrichment validation script

**Files:**
- Create: `scripts/validate-enrichment.mjs`

**Step 1: Write the validation script**

Create `scripts/validate-enrichment.mjs`:

```js
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

  // Try to parse the JSON response
  const raw = data.result.response.trim();
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
```

**Step 2: Commit**

```bash
git add scripts/validate-enrichment.mjs
git commit -m "feat: add enrichment validation script for testing prompt on sample articles"
```

---

## Task 7: Run enrichment validation and iterate

**Step 1: Run the validation script**

Run:
```bash
node scripts/validate-enrichment.mjs
```

Expected: Output showing enrichment results for 10-13 diverse articles. Each should return valid JSON matching the schema.

**Step 2: Review results**

Check each result for:
- **City extraction**: Is the correct city identified?
- **Neighborhoods**: Are only explicitly mentioned neighborhoods listed?
- **Places**: Do venue names match what's in the article? Are neighborhoods correct?
- **Dishes**: Are specific food items extracted (not generic terms)?
- **Categories**: Are Dutch terms used? Do they match the article content?
- **Cuisine type**: Only present when a specific cuisine is mentioned?
- **Occasion**: Only present when explicitly mentioned or strongly implied?
- **No hallucination**: Nothing in the output that isn't in the article?
- **Valid JSON**: All responses parse correctly?

**Step 3: Iterate on the prompt if needed**

If results are inconsistent:
1. Edit `src/enrichment-prompt.md` to address the issues
2. Re-run `node scripts/validate-enrichment.mjs`
3. Repeat until quality is consistent

**Step 4: Commit final prompt version**

```bash
git add src/enrichment-prompt.md
git commit -m "feat: finalize enrichment prompt after validation"
```

---

## Task 8: Update Linear issues

**Step 1: Move VRE-410 to Done**

Mark VRE-410 as complete — D1 database + Vectorize index are set up with all bindings and metadata indexes.

**Step 2: Move VRE-411 to Done**

Mark VRE-411 as complete — enrichment prompt is designed, validated on sample articles, and committed.

---

## Verification Checklist

Before marking complete, verify:

- [ ] `wrangler.toml` has `[[d1_databases]]` binding with real database_id
- [ ] `wrangler.toml` has `[[vectorize]]` binding
- [ ] `migrations/0001_init-schema.sql` exists with correct schema
- [ ] D1 migration applied to both local and remote
- [ ] Vectorize index exists with 7 metadata indexes
- [ ] `npm run dev` starts without binding errors
- [ ] `src/enrichment-prompt.md` exists with tested prompt
- [ ] `scripts/validate-enrichment.mjs` exists and runs successfully
- [ ] Validation results reviewed — extraction quality is consistent
- [ ] All changes committed
