# ChatJPT

AI-powered Q&A for [Cityguys.nl](https://cityguys.nl), running on Cloudflare Workers.

Built on [ask-endpoint](https://github.com/jdevalk/ask-endpoint) by Joost de Valk. Uses the Cloudflare Browser Rendering [/crawl API](https://developers.cloudflare.com/browser-rendering/rest-api/crawl-endpoint/) to index the site instead of reading local markdown files.

## How it works

1. **Crawl**: `generate-index.mjs` uses the Cloudflare `/crawl` API to crawl all pages on cityguys.nl, getting back markdown content for each page.
2. **Embed**: Each page is embedded using Cloudflare Workers AI (`bge-base-en-v1.5`) for semantic search. Embeddings are cached by content hash.
3. **Index**: The crawled content + embeddings are bundled into an ESM module (`src/generated/chatjpt-index.mjs`) that ships with the Worker.
4. **Search**: At query time, hybrid search (keyword scoring + cosine similarity on embeddings) finds the most relevant pages.
5. **Answer**: The top results are passed as context to an LLM (`llama-3.3-70b-instruct`) which generates a grounded answer with source links.
6. **Stream**: Answers stream to the browser via Server-Sent Events for a responsive chat experience.

## Setup

### Prerequisites

- A Cloudflare account
- Node.js 18+
- `wrangler` CLI (`npm install`)

### 1. Install dependencies

```bash
npm install
```

### 2. Generate the index

You need your Cloudflare Account ID and an API token with Workers AI permissions.

```bash
CF_ACCOUNT_ID=your_account_id CF_API_TOKEN=your_api_token npm run generate
```

This will:
- Start a crawl job on cityguys.nl via the Cloudflare Crawl API
- Wait for the crawl to complete (usually a few minutes)
- Generate embeddings for each page
- Output `src/generated/chatjpt-index.json` and `src/generated/chatjpt-index.mjs`

### 3. Configure Workers AI binding

The Worker needs an AI binding. This is already configured in `wrangler.toml`:

```toml
[ai]
binding = "AI"
```

### 4. Local development

```bash
npm run dev
```

Then visit `http://localhost:8787/chatjpt`

### 5. Deploy

```bash
npm run deploy
```

### 6. Set up routing

To serve ChatJPT at `https://vreeman.com/chatjpt`, add a Worker route in the Cloudflare dashboard:

- Go to your `vreeman.com` zone
- Workers Routes > Add Route
- Route: `vreeman.com/chatjpt*`
- Worker: `chatjpt`

## API

### `GET /chatjpt/ask?q=your+question`

Query parameters:

| Parameter | Description | Default |
|-----------|-------------|---------|
| `q` / `query` | The question to ask | (required) |
| `mode` | Response mode: `list`, `summarize`, `generate`, `stream` | `stream` |
| `prev` | JSON array of previous exchanges for conversation context | |
| `debug` | Set to `true` for timing/retrieval diagnostics | `false` |

Also accepts POST with JSON body using the same field names.

### Chat UI

Visit `/chatjpt` for the built-in chat interface.

## Configuration

Edit `chatjpt.config.mjs` to customize:

- Site name, URL, and description (used in the LLM system prompt)
- AI models for embeddings and chat
- Generation parameters (temperature, max tokens, context size)
- URL exclude patterns for the crawler
- Query aliases for expanding abbreviations

## Re-indexing

Run `npm run generate` whenever you want to update the index with new content from cityguys.nl. The embedding cache means only changed content needs new embeddings.

## License

MIT
