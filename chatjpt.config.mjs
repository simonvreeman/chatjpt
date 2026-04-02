/**
 * ChatJPT configuration for Cityguys.nl
 */
export default {
  // Site identity
  site: 'cityguys.nl',
  siteUrl: 'https://cityguys.nl',
  siteName: 'Cityguys',

  // Describe the site for the LLM system prompt
  siteDescription: 'Cityguys.nl, a Dutch men\'s lifestyle blog covering city guides, fashion, food, travel, and culture.',

  // Language (used for stopwords and UI)
  language: 'nl',

  // Cloudflare Crawl API settings
  crawl: {
    startUrl: 'https://cityguys.nl/',
    // URL patterns to exclude from indexing
    excludePatterns: [
      '/cdn-cgi/',
      '/wp-admin/',
      '/cpresources/',
      '\\?',          // query string pages
      '/actions/',
    ],
  },

  // Cloudflare Workers AI models
  embeddingModel: '@cf/baai/bge-base-en-v1.5',
  chatModel: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',

  // Generation settings
  maxContextChars: 10000,
  maxEmbedChars: 2000,
  maxTokens: 512,
  temperature: 0.3,

  // Query and timeout settings
  maxQueryLength: 500,
  aiTimeoutMs: 10000,

  // Query aliases: expand abbreviations/jargon in search queries.
  // Each entry is [regexPattern, replacement].
  queryAliases: [],

  // Type labels for display
  typeLabels: {
    'WebPage': 'pagina',
    'BlogPosting': 'artikel',
    'VideoObject': 'video',
  },

  // Output paths
  outputDir: 'src/generated',
  indexFile: 'chatjpt-index',
};
