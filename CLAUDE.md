# ChatJPT — Technical Documentation

AI-powered Q&A system for [Cityguys.nl](https://cityguys.nl), running on Cloudflare Workers. Combines hybrid search (keyword + semantic) with LLM-powered answer generation to provide conversational answers grounded in site content.

**Live URL**: https://vreeman.ai/chatjpt

## Architecture Overview

```
User Question
    │
    ▼
┌──────────────────────────────────────────────────┐
│  Cloudflare Worker (src/worker.js)               │
│  Routes: /chatjpt (UI) · /chatjpt/ask (API)     │
│                                                  │
│  1. normalizeRequest()  ─ parse GET/POST params  │
│  2. augmentQuery()      ─ add follow-up context  │
│  3. embedQuery()        ─ query → 768-dim vector │
│  4. search()            ─ hybrid keyword+semantic│
│  5. generateAnswer()    ─ LLM with context       │
│  6. Response            ─ SSE stream or JSON     │
└──────────────────────────────────────────────────┘
    │
    ▼
Chat UI (src/ui.js) renders tokens in real-time
```

## Tech Stack

| Component | Technology |
|-----------|-----------|
| Runtime | Cloudflare Workers (serverless edge) |
| CLI | Wrangler v4 |
| Embeddings | Cloudflare Workers AI — `@cf/baai/bge-base-en-v1.5` (768 dims) |
| LLM | Cloudflare Workers AI — `@cf/meta/llama-3.3-70b-instruct-fp8-fast` |
| Frontend | Vanilla HTML/CSS/JS (self-contained, no build step) |
| Crawling | Cloudflare Browser Rendering API (`/markdown` endpoint) |
| Dependencies | Zero runtime deps. Only dev dependency: `wrangler` |

## Project Structure

```
chatjpt/
├── chatjpt.config.mjs        # Master config (site identity, models, thresholds)
├── generate-index.mjs         # Offline index builder (sitemap → embeddings)
├── wrangler.toml              # Cloudflare Worker deployment config
├── package.json               # Scripts: generate, dev, deploy
├── .dev.vars                  # Local credentials (gitignored)
├── src/
│   ├── worker.js              # Worker entry point (routing, request handling)
│   ├── config.js              # Runtime config constants with defaults
│   ├── retrieval.js           # Hybrid search (keyword + cosine similarity)
│   ├── generation.js          # LLM answer generation + fallback
│   ├── ui.js                  # Self-contained HTML chat interface
│   ├── system-prompt.md       # LLM personality/behavior template
│   └── generated/             # Gitignored — built by generate-index.mjs
│       ├── chatjpt-index.json # Raw JSON index (~33MB, ~1500 records)
│       ├── chatjpt-index.mjs  # ESM module wrapping the index
│       ├── embedding-cache.json   # Content hash → embedding cache
│       └── markdown-cache.json    # URL → markdown text cache
```

## Commands

```bash
# Install dependencies
npm install

# Generate the search index (requires Cloudflare credentials)
CF_ACCOUNT_ID=xxx CF_API_TOKEN=xxx npm run generate
# Or with .dev.vars file:
npm run generate

# Local development server
npm run dev

# Deploy to Cloudflare Workers
npm run deploy
```

## Configuration

All settings live in `chatjpt.config.mjs`. Key options:

| Setting | Default | Purpose |
|---------|---------|---------|
| `site` | `cityguys.nl` | Domain identifier |
| `siteUrl` | `https://cityguys.nl` | Base URL for absolute links |
| `siteName` | `Cityguys` | Brand name in prompts/fallbacks |
| `siteDescription` | Dutch lifestyle blog... | Context for the LLM |
| `language` | `nl` | Stopword language + UI language |
| `embeddingModel` | `@cf/baai/bge-base-en-v1.5` | 768-dim embedding model |
| `chatModel` | `@cf/meta/llama-3.3-70b-instruct-fp8-fast` | Answer generation LLM |
| `maxContextChars` | `10000` | Max chars of context for LLM |
| `maxTokens` | `512` | Max response tokens |
| `temperature` | `0.3` | LLM creativity (0=deterministic) |
| `maxQueryLength` | `500` | Max user query chars |
| `aiTimeoutMs` | `10000` | AI call timeout |
| `queryAliases` | `[]` | Regex pairs for query expansion |
| `crawl.excludePatterns` | `[...]` | URL patterns to skip during indexing |

## API Reference

### `GET/POST /chatjpt/ask`

Query parameters (GET) or JSON body (POST):

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `q` / `query` | string | Yes | User's question (max 500 chars) |
| `mode` | string | No | `stream` (SSE), `summarize`, `generate`, `list` |
| `prev` | string | No | JSON array of previous `{query, answer}` exchanges |
| `debug` | boolean | No | Include timing + retrieval details |
| `decontextualized_query` | string | No | Pre-processed query override |
| `query_id` | string | No | Custom query ID (auto UUID if omitted) |

**Response (stream mode)**: Server-Sent Events with:
- `data: {"token": "..."}` — Individual tokens
- `data: {"sources": [...], "done": true}` — Final event with sources
- `data: {"error": "...", "done": true}` — Error event

**Response (summarize/generate mode)**: JSON with `answer`, `sources`, `results`

**Response (list mode)**: JSON with `results` only (no AI generation)

### `GET /chatjpt`

Returns the self-contained HTML chat interface.

## Search Algorithm

Hybrid scoring combining keyword and semantic search:

### Keyword Scoring (BM25-inspired)
- Exact phrase match in any field: **+20**
- Per token (with diminishing returns after 3 occurrences):
  - In document name (title): **+10**
  - In keywords array: **+7**
  - In description: **+5**
  - In URL path: **+4**
  - Base occurrence score: `min(count, 3) + log2(max(count-3, 1))`

### Semantic Scoring (Cosine Similarity)
- Query embedded via BGE model (768 dimensions)
- Cosine similarity computed against each document's pre-computed embedding
- Threshold: 0.3 (below = ignored)
- Scaled: `max(0, similarity - 0.3) × 100` → range 0–70

### Final Score
```
score = (keywordScore + semanticScore) × searchWeight
```
- `searchWeight`: WebPage = 1.2, BlogPosting = 1.0
- Minimum threshold: score > 2
- Returns top 8 results

## Conversation Context

- UI sends last 3 exchanges as `prev` JSON parameter
- Vague follow-ups detected by: ≤5 words OR starts with patterns like "what about", "tell me more", "en de"
- Augmented: `"{query} (context: {previousQuery})"`
- LLM receives last 3 exchanges in message history (assistant answers truncated to 500 chars)

## Index Generation Pipeline

1. **Sitemap discovery** → Parse `sitemap.xml` (handles sitemap index format)
2. **URL filtering** → Apply `crawl.excludePatterns` regex filters
3. **Markdown fetching** → Cloudflare Browser Rendering API with:
   - Markdown cache (skip re-fetching unchanged pages)
   - 3 retries with exponential backoff (5s, 10s, 15s)
   - 1.5s delay between requests (rate limiting)
   - Cache saved every 50 pages (crash protection)
4. **Record building** → Clean markdown, extract titles, create schema.org objects
5. **Thin page filtering** → Skip pages with < 50 chars of clean text
6. **Embedding generation** → BGE model via Cloudflare Workers AI:
   - Content hash-based cache (only re-embed changed content)
   - Batch size: 20 texts per API call
   - 200ms delay between batches
7. **Output** → Write JSON + ESM index files

## Fallback Behavior

When AI is unavailable or fails:

1. **Empty/short LLM response** (< 5 chars) → Keyword-based fallback in Dutch
2. **AI timeout** → `withTimeout()` rejects after `aiTimeoutMs`, triggers fallback
3. **No search results** → Friendly Dutch message suggesting a more specific query
4. **Streaming failure** → Returns JSON response with `fallback: true` flag

Fallback format: Points user to the best keyword match with a markdown link and the document description.

## System Prompt

Located at `src/system-prompt.md`. Uses `{{SITE_NAME}}` and `{{SITE_DESCRIPTION}}` placeholders (replaced at module load time).

Key personality traits:
- Casual, enthusiastic tone (like the Cityguys editorial team)
- Mix of Dutch and English ("must-visit", "next level")
- Opinionated recommendations with vivid adjectives
- Always cites sources with markdown links
- Never invents information
- Matches query language (Dutch → Dutch, English → English)

## Development Workflow

### Adding a new feature
1. Edit source files in `src/`
2. Test locally with `npm run dev`
3. Deploy with `npm run deploy`

### Re-indexing the site
1. Set `CF_ACCOUNT_ID` and `CF_API_TOKEN` in `.dev.vars`
2. Run `npm run generate`
3. With warm caches, only changed pages are re-processed
4. Deploy the updated index with `npm run deploy`

### Adapting for a different site
1. Update `chatjpt.config.mjs` (site identity, crawl settings, models)
2. Rewrite `src/system-prompt.md` for the new brand voice
3. Run `npm run generate` to build the index
4. Update `wrangler.toml` routes for the new domain
5. Deploy with `npm run deploy`

## Credentials & Security

- **API credentials**: Stored in `.dev.vars` (gitignored, never committed)
- **CORS**: Open (`*`) — API is public, no authentication
- **Input validation**: Query truncated to 500 chars, `prev` to 10KB
- **No user data stored**: Conversation history lives only in the browser
- **Rate limiting**: Implicit via Cloudflare Workers usage limits

## Performance Characteristics

| Operation | Typical Duration |
|-----------|-----------------|
| Query embedding | < 200ms |
| Index search (in-memory) | < 10ms |
| LLM generation (streaming) | 2–10s |
| Total response (with streaming) | 3–15s |

The entire index (~33MB, ~1500 records with 768-dim embeddings) is loaded into Worker memory at startup, enabling sub-10ms search with no external database.

## Key Design Decisions

- **Bundled index**: The full search index is shipped with the Worker rather than stored in a database. This eliminates cold-start latency for search but means re-deployment is needed after re-indexing.
- **Hybrid search**: Keyword scoring catches exact matches (restaurant names, specific terms); semantic search catches meaning ("beste pizza" finds pizza articles even without exact words).
- **Self-contained UI**: The entire chat interface is a single template literal in `ui.js`. No build step, no CDN, no static assets — just the Worker.
- **Graceful degradation**: Every AI call has a timeout and fallback path. If Workers AI is down, users still get keyword-based results.
- **Dual caching**: Both markdown and embeddings are cached by content hash, making re-indexing fast and cheap (typically seconds with warm cache).
