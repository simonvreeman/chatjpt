import { AI_TIMEOUT_MS, EMBEDDING_MODEL, withTimeout } from './config.js';
import siteConfig from '../chatjpt.config.mjs';

// Dutch + English stopwords
const STOPWORDS = new Set([
  // English
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'how', 'i', 'in', 'is', 'it',
  'of', 'on', 'or', 'that', 'the', 'this', 'to', 'was', 'what', 'when', 'where', 'which', 'who',
  'why', 'with', 'you', 'your',
  // Dutch
  'de', 'het', 'een', 'en', 'van', 'in', 'is', 'dat', 'die', 'op', 'te', 'zijn', 'voor', 'met',
  'niet', 'ook', 'maar', 'aan', 'er', 'nog', 'al', 'was', 'dan', 'wel', 'om', 'naar', 'bij',
  'uit', 'kan', 'meer', 'ze', 'je', 'we', 'zo', 'wij', 'ik', 'hun', 'hij', 'zij', 'dit',
]);

const QUERY_ALIASES = (siteConfig.queryAliases || []).map(
  ([pattern, replacement]) => [new RegExp(pattern, 'gi'), replacement]
);

export function expandAliases(query) {
  let expanded = query;
  for (const [pattern, replacement] of QUERY_ALIASES) {
    expanded = expanded.replace(pattern, replacement);
  }
  return expanded;
}

function tokenize(value = '') {
  return String(value)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]+/gu, ' ')
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token && token.length > 1 && !STOPWORDS.has(token));
}

function buildNeedle(document) {
  return [
    document.name,
    document.description,
    document.type,
    ...(document.keywords || []),
    document.text,
  ].join(' \n ').toLowerCase();
}

function scoreDocument(document, tokens, fullQuery) {
  const needle = buildNeedle(document);
  const nameLower = document.name.toLowerCase();
  const descLower = document.description.toLowerCase();
  const urlLower = document.url.toLowerCase();
  const keywordsLower = (document.keywords || []).map((k) => String(k).toLowerCase());
  let score = 0;

  if (fullQuery && needle.includes(fullQuery.toLowerCase())) {
    score += 20;
  }

  for (const token of tokens) {
    const occurrences = needle.split(token).length - 1;
    if (!occurrences) continue;

    score += Math.min(occurrences, 3) + Math.log2(Math.max(occurrences - 3, 1));

    if (nameLower.includes(token)) score += 10;
    if (descLower.includes(token)) score += 5;
    if (keywordsLower.some((kw) => kw.includes(token))) score += 7;
    if (urlLower.includes(token)) score += 4;
  }

  return score;
}

function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const mag = Math.sqrt(magA) * Math.sqrt(magB);
  return mag === 0 ? 0 : dot / mag;
}

export async function embedQuery(ai, query) {
  if (!ai) return null;
  try {
    const res = await withTimeout(ai.run(EMBEDDING_MODEL, { text: [query] }), AI_TIMEOUT_MS);
    return res?.data?.[0] || null;
  } catch {
    return null;
  }
}

export function search(query, queryEmbedding, index) {
  const expanded = expandAliases(query);
  const tokens = tokenize(expanded);

  return index
    .map((document) => {
      const keywordScore = scoreDocument(document, tokens, expanded);

      let semanticScore = 0;
      if (queryEmbedding && document.embedding) {
        const similarity = cosineSimilarity(queryEmbedding, document.embedding);
        semanticScore = Math.max(0, similarity - 0.3) * 100;
      }

      const weight = document.searchWeight ?? 1.0;
      const score = (keywordScore + semanticScore) * weight;
      return { document, score, keywordScore, semanticScore };
    })
    .filter((item) => item.score > 2)
    .sort((a, b) => b.score - a.score)
    .slice(0, 8);
}

export function augmentQuery(query, prevExchanges) {
  if (!prevExchanges || prevExchanges.length === 0) return query;

  const isVagueFollowUp = query.split(/\s+/).length <= 5
    || /^(what about|tell me more|and |how about|why|can you|more on|wat is|vertel|hoe zit|en de)/i.test(query);

  if (!isVagueFollowUp) return query;

  const lastQuery = prevExchanges[prevExchanges.length - 1]?.query;
  if (lastQuery) return `${query} (context: ${lastQuery})`;

  return query;
}
