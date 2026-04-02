/**
 * ChatJPT — Master Configuration File
 *
 * This is the single source of truth for all project settings. Both the
 * Cloudflare Worker (runtime) and the index generator (build time) import
 * this file to ensure consistent behavior.
 *
 * To adapt ChatJPT for a different website:
 * 1. Update the site identity fields (site, siteUrl, siteName, siteDescription)
 * 2. Set the crawl.startUrl and crawl.excludePatterns for your site
 * 3. Optionally adjust AI models, generation parameters, and type labels
 * 4. Update the system prompt in src/system-prompt.md for your brand voice
 * 5. Run `npm run generate` to build the index, then `npm run deploy`
 *
 * Configuration is consumed by:
 * - src/config.js → Re-exports as named constants with defaults
 * - src/retrieval.js → Uses queryAliases and stopwords
 * - src/generation.js → Uses site identity for system prompt and fallback messages
 * - generate-index.mjs → Uses crawl settings, models, and output paths
 */
export default {
  // ──────────────────────────────────────────────
  // Site Identity
  // These values appear in the LLM system prompt, fallback messages,
  // and are used to construct full URLs from relative paths.
  // ──────────────────────────────────────────────

  /** Domain name (used as default site identifier in API responses) */
  site: 'cityguys.nl',

  /** Base URL prepended to relative document paths for full links */
  siteUrl: 'https://cityguys.nl',

  /** Brand name used in the system prompt and fallback messages */
  siteName: 'Cityguys',

  /**
   * One-line description of the site, injected into the LLM system prompt.
   * Helps the model understand the site's topic and audience.
   */
  siteDescription: 'Cityguys.nl, a Dutch men\'s lifestyle blog covering city guides, fashion, food, travel, and culture.',

  /**
   * Primary language of the site content.
   * Used for stopword selection in retrieval.js and UI language defaults.
   * Supported values: 'nl' (Dutch), 'en' (English).
   */
  language: 'nl',

  // ──────────────────────────────────────────────
  // Crawl Settings
  // Control how generate-index.mjs discovers and filters pages.
  // ──────────────────────────────────────────────
  crawl: {
    /**
     * The root URL from which to start crawling.
     * The generator will fetch {siteUrl}/sitemap.xml by default,
     * or use a custom sitemapUrl if specified.
     */
    startUrl: 'https://cityguys.nl/',

    /**
     * Regex patterns for URLs to exclude from indexing.
     * Any URL matching any pattern is skipped during index generation.
     * Patterns are case-insensitive.
     *
     * Common exclusions:
     * - /cdn-cgi/   → Cloudflare internal routes
     * - /wp-admin/  → WordPress admin pages
     * - /cpresources/ → CMS resource files
     * - \\?         → URLs with query strings (pagination, filters, etc.)
     * - /actions/   → CMS action endpoints
     */
    excludePatterns: [
      '/cdn-cgi/',
      '/wp-admin/',
      '/cpresources/',
      '\\?',          // query string pages
      '/actions/',
    ],
  },

  // ──────────────────────────────────────────────
  // AI Models (Cloudflare Workers AI)
  // ──────────────────────────────────────────────

  /**
   * Embedding model for converting text to 768-dimensional vectors.
   * Used during both index generation (document embeddings) and runtime
   * (query embedding). BGE Base EN v1.5 is compact and fast, with good
   * cross-lingual performance despite being English-focused.
   */
  embeddingModel: '@cf/baai/bge-base-en-v1.5',

  /**
   * Chat/completion model for generating conversational answers.
   * Llama 3.3 70B (FP8 quantized) balances quality with speed.
   * The "-fast" variant is optimized for lower latency on Cloudflare's edge.
   */
  chatModel: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',

  // ──────────────────────────────────────────────
  // Generation Parameters
  // These control the AI answer generation behavior.
  // ──────────────────────────────────────────────

  /**
   * Maximum total characters of retrieved context to include in the LLM prompt.
   * This budget is divided equally across the top results.
   * Higher values give the model more information but cost more tokens.
   */
  maxContextChars: 10000,

  /**
   * Maximum characters of document text used for embedding generation.
   * During index building, each document's text is truncated to this length
   * before being sent to the embedding model. Keeps embedding costs predictable
   * and focuses on the most relevant content (beginnings of articles).
   */
  maxEmbedChars: 2000,

  /**
   * Maximum number of tokens the LLM may generate per response.
   * 512 tokens ≈ 350–400 words — enough for concise, link-rich answers.
   * Increase for longer responses; decrease for faster/cheaper answers.
   */
  maxTokens: 512,

  /**
   * LLM temperature: controls randomness in token selection.
   * 0.0 = fully deterministic (always picks the most likely token)
   * 1.0 = highly creative (more variation, higher hallucination risk)
   * 0.3 = slightly creative — produces natural language while staying factual.
   */
  temperature: 0.3,

  // ──────────────────────────────────────────────
  // Query & Timeout Settings
  // ──────────────────────────────────────────────

  /**
   * Maximum allowed length for user queries (in characters).
   * Longer queries are silently truncated. Prevents abuse and controls costs.
   */
  maxQueryLength: 500,

  /**
   * Timeout in milliseconds for individual AI API calls.
   * Applies to both embedding generation and LLM completion.
   * If exceeded, the system falls back to keyword-based summarization.
   */
  aiTimeoutMs: 10000,

  // ──────────────────────────────────────────────
  // Query Aliases
  // ──────────────────────────────────────────────

  /**
   * Query alias patterns for expanding abbreviations/jargon before search.
   * Each entry is a [regexPattern, replacement] pair.
   * Applied in order by retrieval.js's expandAliases() function.
   *
   * Examples:
   *   ["\\bAMS\\b", "Amsterdam"]       → "best food AMS" becomes "best food Amsterdam"
   *   ["\\bR'dam\\b", "Rotterdam"]     → "R'dam tips" becomes "Rotterdam tips"
   *   ["\\bbbq\\b", "barbecue"]        → "bbq spots" becomes "barbecue spots"
   *
   * Currently empty — add entries as needed for your site's jargon.
   */
  queryAliases: [],

  // ──────────────────────────────────────────────
  // Type Labels
  // ──────────────────────────────────────────────

  /**
   * Maps schema.org @type values to human-readable labels (in Dutch).
   * Used in the context block sent to the LLM and potentially in the UI.
   * The key must match the `type` field in index records.
   */
  typeLabels: {
    'WebPage': 'pagina',        // Static pages (homepage, about, etc.)
    'BlogPosting': 'artikel',   // Blog posts / articles
    'VideoObject': 'video',     // Video content
  },

  // ──────────────────────────────────────────────
  // Output Paths
  // ──────────────────────────────────────────────

  /**
   * Directory where generate-index.mjs writes its output files.
   * Relative to the project root. This directory is gitignored because
   * the generated files are large (~33MB) and machine-generated.
   */
  outputDir: 'src/generated',

  /**
   * Base filename (without extension) for the generated index.
   * The generator creates both .json and .mjs versions:
   * - {indexFile}.json: Raw JSON array (for inspection/debugging)
   * - {indexFile}.mjs: ESM module (imported by the Worker at runtime)
   */
  indexFile: 'chatjpt-index',
};
