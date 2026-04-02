import { MAX_CONTEXT_CHARS, AI_TIMEOUT_MS, MODEL, MAX_TOKENS, TEMPERATURE, TYPE_LABELS, withTimeout } from './config.js';
import siteConfig from '../chatjpt.config.mjs';
import systemPromptTemplate from './system-prompt.md';

const SITE_NAME = siteConfig.siteName || siteConfig.site || 'this site';
const SITE_URL = siteConfig.siteUrl || '';
const SITE_DESCRIPTION = siteConfig.siteDescription || 'a website';

const SYSTEM_PROMPT = systemPromptTemplate
  .replace(/\{\{SITE_NAME\}\}/g, SITE_NAME)
  .replace(/\{\{SITE_DESCRIPTION\}\}/g, SITE_DESCRIPTION);

export function buildContext(scoredResults) {
  const sorted = [...scoredResults].sort((a, b) => {
    const aPage = a.document.type === 'WebPage' ? 1 : 0;
    const bPage = b.document.type === 'WebPage' ? 1 : 0;
    return bPage - aPage || b.score - a.score;
  });

  const maxResults = Math.min(sorted.length, 5);
  const perResultBudget = Math.floor(MAX_CONTEXT_CHARS / maxResults);
  let context = '';
  const sources = [];

  for (let i = 0; i < maxResults; i++) {
    const { document } = sorted[i];
    const text = document.text.length > perResultBudget
      ? document.text.slice(0, perResultBudget) + '...'
      : document.text;
    const typeLabel = TYPE_LABELS[document.type] || 'content';
    const date = document.datePublished ? document.datePublished.split('T')[0] : null;
    const meta = [`Type: ${typeLabel}`, date ? `Published: ${date}` : null].filter(Boolean).join(' | ');
    context += `## ${document.name}\nURL: ${SITE_URL}${document.url}\n${meta}\n${text}\n\n`;
    sources.push({
      url: `${SITE_URL}${document.url}`,
      title: document.name,
      type: typeLabel,
      datePublished: date,
    });
  }

  return { context, sources };
}

export function fallbackSummarize(query, results) {
  if (!results.length) {
    return {
      answer: `Hmm, daar heb ik helaas niks over kunnen vinden op ${SITE_NAME}. Probeer het eens met een specifiekere vraag!`,
      sources: [],
    };
  }

  const top = results[0];
  const extras = results.slice(1, 3).map((r) => r.name);
  const extraText = extras.length ? ` Gerelateerde resultaten: ${extras.join(' en ')}.` : '';
  return {
    answer: `Check eens [${top.name}](${SITE_URL}${top.url}) — dat is je beste match voor "${query}". ${top.description}${extraText}`,
    sources: results.slice(0, 3).map((r) => ({ url: `${SITE_URL}${r.url}`, title: r.name })),
  };
}

function buildMessages(query, context, prevExchanges) {
  const messages = [{ role: 'system', content: SYSTEM_PROMPT }];

  if (prevExchanges && prevExchanges.length > 0) {
    const recent = prevExchanges.slice(-3);
    for (const exchange of recent) {
      messages.push({ role: 'user', content: exchange.query });
      const prevAnswer = exchange.answer.length > 500
        ? exchange.answer.slice(0, 500) + '...'
        : exchange.answer;
      messages.push({ role: 'assistant', content: prevAnswer });
    }
  }

  messages.push({ role: 'user', content: `Context from ${SITE_NAME}:\n\n${context}\n\nQuestion: ${query}` });
  return messages;
}

export function extractSources(answer, allSources) {
  const usedUrlSet = new Set();
  const usedTitleSet = new Set();

  const linkPattern = /\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g;
  let match;
  while ((match = linkPattern.exec(answer)) !== null) {
    usedUrlSet.add(match[2].replace(/\/$/, ''));
    usedTitleSet.add(match[1].toLowerCase());
  }

  let usedSources = allSources.filter((s) => {
    const urlNorm = s.url.replace(/\/$/, '');
    if (usedUrlSet.has(urlNorm)) return true;
    if (usedTitleSet.has(s.title.toLowerCase())) return true;
    return false;
  });

  if (usedSources.length === 0) usedSources = allSources.slice(0, 3);
  return usedSources;
}

export async function generateStreamingAnswer(ai, query, scoredResults, prevExchanges, sessionId) {
  const { context, sources } = buildContext(scoredResults);

  if (!context.trim()) {
    const fallback = fallbackSummarize(query, scoredResults.map((r) => r.document));
    return { stream: null, fallback };
  }

  const messages = buildMessages(query, context, prevExchanges);

  const response = await withTimeout(
    ai.run(MODEL, {
      messages,
      max_tokens: MAX_TOKENS,
      temperature: TEMPERATURE,
      stream: true,
    }, {
      headers: { 'x-session-affinity': sessionId },
    }),
    AI_TIMEOUT_MS,
  );

  return { stream: response, sources };
}

export async function generateAnswer(ai, query, scoredResults, prevExchanges, sessionId) {
  const { context, sources } = buildContext(scoredResults);

  if (!context.trim()) {
    return fallbackSummarize(query, scoredResults.map((r) => r.document));
  }

  try {
    const messages = buildMessages(query, context, prevExchanges);

    const response = await withTimeout(
      ai.run(MODEL, {
        messages,
        max_tokens: MAX_TOKENS,
        temperature: TEMPERATURE,
      }, {
        headers: { 'x-session-affinity': sessionId },
      }),
      AI_TIMEOUT_MS,
    );

    const answer = response.response
      || response.result?.response
      || response.choices?.[0]?.message?.content;
    if (!answer || typeof answer !== 'string' || answer.trim().length < 5) {
      throw new Error('Empty or malformed model response');
    }

    return { answer, sources: extractSources(answer, sources) };
  } catch (err) {
    console.error('AI generation failed, falling back:', err.message);
    return fallbackSummarize(query, scoredResults.map((r) => r.document));
  }
}
