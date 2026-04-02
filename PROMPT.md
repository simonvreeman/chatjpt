# ChatJPT -- Claude Code Build Prompt

Use this prompt in Claude Code to build the ChatJPT project. Run it from the project root directory.

---

## Prompt

Build "ChatJPT", an AI-powered Q&A endpoint and chat UI for Cityguys.nl, running on Cloudflare Workers. This is based on https://github.com/jdevalk/ask-endpoint by Joost de Valk, adapted for a Craft CMS site instead of a static markdown site.

### What it does

A Cloudflare Worker that:
1. Serves a chat UI at `/chatjpt`
2. Exposes an API at `/chatjpt/ask` that takes a question, searches an index of all cityguys.nl content using hybrid keyword + semantic search, and returns an LLM-generated answer grounded in the site's content, with source links.
3. Supports streaming (SSE), multi-turn conversations, and debug mode.

It will be deployed at `https://vreeman.com/chatjpt`.

### Architecture

The original ask-endpoint reads local markdown files with gray-matter. Cityguys runs on Craft CMS, so the index generator must instead use the **Cloudflare Browser Rendering /crawl API** (`POST https://api.cloudflare.com/client/v4/accounts/{account_id}/browser-rendering/crawl`) to crawl the site and get markdown content for each page. The crawl is async: you POST to start a job, get a job ID, then poll GET until status is not "running".

#### Project structure

```
chatjpt/
  chatjpt.config.mjs      -- site config
  generate-index.mjs       -- crawls cityguys.nl via Cloudflare Crawl API, generates embeddings, outputs index
  package.json             -- type: module, scripts: generate, dev, deploy. Dependencies: wrangler (dev). No gray-matter needed.
  wrangler.toml            -- name=chatjpt, main=src/worker.js, [ai] binding="AI"
  .gitignore               -- node_modules/, src/generated/, .wrangler/, .dev.vars
  src/
    worker.js              -- main Worker entry (export default { fetch() }), routes /chatjpt (UI) and /chatjpt/ask (API)
    config.js              -- constants from config (models, timeouts, limits)
    retrieval.js           -- hybrid keyword + semantic search, query augmentation, Dutch + English stopwords
    generation.js          -- LLM system prompt, context building, streaming + non-streaming generation, source extraction
    ui.js                  -- exports chatPage() returning self-contained HTML string for the chat UI
    generated/             -- created by generate-index.mjs (gitignored)
      chatjpt-index.json
      chatjpt-index.mjs    -- `export default [...]`
      embedding-cache.json
```

### Key details

**Config (`chatjpt.config.mjs`):**
- site: 'cityguys.nl', siteUrl: 'https://cityguys.nl', siteName: 'Cityguys'
- siteDescription: "Cityguys.nl, a Dutch men's lifestyle blog covering city guides, fashion, food, travel, and culture."
- language: 'nl'
- crawl.startUrl: 'https://cityguys.nl/'
- crawl.excludePatterns: ['/cdn-cgi/', '/wp-admin/', '/cpresources/', '\\?', '/actions/']
- embeddingModel: '@cf/baai/bge-base-en-v1.5'
- chatModel: '@cf/meta/llama-3.3-70b-instruct-fp8-fast'
- maxContextChars: 10000, maxEmbedChars: 2000, maxTokens: 512, temperature: 0.3
- typeLabels: { WebPage: 'pagina', BlogPosting: 'artikel', VideoObject: 'video' }

**Index generator (`generate-index.mjs`):**
- Uses `CF_ACCOUNT_ID` and `CF_API_TOKEN` env vars
- POSTs to Cloudflare Crawl API to start crawl, polls every 5s until done (max 10 min)
- Filters out pages matching excludePatterns
- For each completed page with markdown content: extracts title (from crawl metadata or first heading), cleans markdown to plain text, guesses content type from URL (homepage = WebPage, rest = BlogPosting)
- Generates embeddings via Cloudflare Workers AI API, batched 20 at a time, cached by content hash
- Outputs JSON + ESM index files

**Worker (`src/worker.js`):**
- Cloudflare Workers format: `export default { async fetch(request, env) { ... } }`
- Routes: OPTIONS (CORS preflight), /chatjpt (chat UI), /chatjpt/ask (API)
- The API accepts GET and POST, normalizes params: q/query, mode (default: stream), prev, decontextualized_query, query_id, debug
- Search flow: parse prev exchanges, augment vague follow-ups, embed query, hybrid search, then generate/stream answer
- Streaming uses TransformStream + SSE format

**Retrieval (`src/retrieval.js`):**
- Include both Dutch and English stopwords
- Keyword scoring: exact phrase match (+20), token occurrences (log-scaled), field bonuses (name +10, description +5, keywords +7, URL +4)
- Semantic scoring: cosine similarity, scaled (similarity - 0.3) * 100
- Blended score with per-document searchWeight, filtered > 2, top 8 results
- Query augmentation for vague follow-ups (including Dutch patterns like "wat is", "vertel", "hoe zit", "en de")

**Generation (`src/generation.js`):**
- System prompt identifies itself as "ChatJPT", describes the site, instructs to answer only from context, respond in the user's language (Dutch or English), use markdown with source links
- Fallback messages in Dutch ("Ik kon geen goed resultaat vinden...")
- Builds context from top 5 results, pages sorted first, budget per result = maxContextChars / count
- Multi-turn: includes last 3 exchanges in message history
- Source extraction: matches markdown links in answer against provided sources

**Chat UI (`src/ui.js`):**
- Clean, minimal design. Dark header (#1a1a1a) with "Chat" in white + "JPT" in red (#e63946)
- Subtitle: "Vraag het aan Cityguys"
- Chat bubbles: user messages dark, assistant messages white with border
- Rounded input with "Stel een vraag..." placeholder, "Verstuur" button
- Typing indicator with animated dots
- Client-side SSE streaming, inline markdown rendering (bold, links, lists)
- Sources shown below answers as "Bronnen:" links
- Conversation history maintained client-side, last 3 exchanges sent as `prev`
- Footer: "Powered by Cityguys & Cloudflare Workers AI"
- IMPORTANT: The UI HTML is returned as a string from the `chatPage()` function. Since it's inside a JS template literal, be careful with escaping. Use string concatenation (`+`) instead of template literals inside the inline `<script>`. Escape backslashes in regex patterns (e.g., `\\*\\*` to produce `\*\*` in the output).

### Reference implementation

Clone https://github.com/jdevalk/ask-endpoint and use it as reference for the search/generation logic. The main changes are:
1. `generate-index.mjs`: Cloudflare Crawl API instead of reading markdown files with gray-matter
2. `worker.js`: Cloudflare Workers exports instead of Pages Functions exports (`onRequestGet`/`onRequestPost`)
3. Dutch language support (stopwords, fallback messages, system prompt)
4. Chat UI at `/chatjpt`
5. Config file renamed to `chatjpt.config.mjs`

Also write a README.md with setup instructions covering: npm install, index generation, local dev, deploy, and Worker route setup for vreeman.com/chatjpt.
