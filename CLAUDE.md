# ChatJPT

AI-powered Q&A for [Cityguys.nl](https://cityguys.nl), running on Cloudflare Workers. Hybrid search (keyword + semantic) with LLM answer generation.

**Live**: https://vreeman.ai/chatjpt

## Commands

```bash
npm install                # Install dependencies (wrangler only)
npm run generate           # Build search index (needs CF credentials)
npm run dev                # Local dev server (requires generated index)
npm run deploy             # Deploy to Cloudflare Workers
```

## Architecture

```
User Question → Worker (src/worker.js)
  1. normalizeRequest → parse GET/POST
  2. augmentQuery     → add follow-up context
  3. embedQuery       → 768-dim vector via Workers AI
  4. search           → hybrid keyword + semantic scoring
  5. generateAnswer   → LLM streamed response
  → Chat UI (src/ui.js) renders SSE tokens
```

**Key files:**
- `chatjpt.config.mjs` — Single source of truth for all settings (models, thresholds, crawl config)
- `src/worker.js` — Entry point, routing, request handling
- `src/retrieval.js` — Hybrid search (BM25-inspired keyword + cosine similarity)
- `src/generation.js` — LLM answer generation with fallback
- `src/ui.js` — Self-contained HTML/CSS/JS chat interface (single template literal)
- `src/system-prompt.md` — LLM personality template (uses `{{SITE_NAME}}` / `{{SITE_DESCRIPTION}}` placeholders)
- `generate-index.mjs` — Offline index builder (sitemap → markdown → embeddings)
- `src/generated/` — Gitignored build output (~33MB index with ~1500 records)

## Code Style

- Vanilla JavaScript, ESM modules (`"type": "module"` in package.json)
- Zero runtime dependencies — only dev dep is `wrangler`
- No build step, no TypeScript, no framework
- UI is a single self-contained template literal in `ui.js` (no static assets)
- JSDoc comments on exported functions

## Gotchas

- **No tests exist.** No test framework is configured. Don't try to run tests.
- **Generated index must exist before `npm run dev`** — the Worker imports `src/generated/chatjpt-index.mjs` at startup. Run `npm run generate` first.
- **Credentials for index generation**: `CF_ACCOUNT_ID` and `CF_API_TOKEN` must be in `.dev.vars` (gitignored) or passed as env vars.
- **~33MB bundled index**: The entire search index ships with the Worker. Re-deploy after re-indexing.
- **Caching in generate-index.mjs**: Markdown and embeddings are cached by content hash. Warm re-indexing is fast (seconds). Cache files are in `src/generated/`.
- **AI fallback**: Every AI call has a timeout (`aiTimeoutMs`). If Workers AI fails, users get keyword-based results — don't break this fallback path.
- **CORS is open** (`*`) — the API is public with no auth.

## Workflows

**Adding a feature**: Edit `src/` → `npm run dev` → `npm run deploy`

**Re-indexing the site**: Ensure `.dev.vars` has credentials → `npm run generate` → `npm run deploy`

**Adapting for a different site**: Update `chatjpt.config.mjs` + rewrite `src/system-prompt.md` → `npm run generate` → update `wrangler.toml` routes → `npm run deploy`
