/**
 * ChatJPT -- Chat UI
 *
 * Self-contained HTML page served at /chatjpt
 */

export function chatPage() {
  return `<!DOCTYPE html>
<html lang="nl">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>ChatJPT - Vraag het aan Cityguys</title>
  <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🍔</text></svg>">
  <style>
    :root {
      --bg: #f7f5f2;
      --surface: #ffffff;
      --surface2: #f0edea;
      --border: #e2ddd6;
      --text: #1c1917;
      --text-muted: #78716c;
      --accent: #EA0059;
      --accent-hover: #D50051;
      --accent-light: #fed7aa;
    }

    * { margin: 0; padding: 0; box-sizing: border-box; }

    body {
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: var(--bg);
      color: var(--text);
      min-height: 100vh;
      display: flex;
      flex-direction: column;
    }

    *:focus-visible {
      outline: 2px solid var(--accent);
      outline-offset: 2px;
    }

    header {
      background: var(--surface);
      border-bottom: 1px solid var(--border);
      padding: 1rem 1.5rem;
      text-align: center;
    }

    header h1 {
      font-size: 1.5rem;
      font-weight: 700;
      letter-spacing: -0.02em;
      color: var(--text);
    }

    header h1 span { color: var(--accent); }

    header p {
      font-size: 0.85rem;
      color: var(--text-muted);
      margin-top: 0.25rem;
    }

    main {
      flex: 1;
      max-width: 720px;
      width: 100%;
      margin: 0 auto;
      padding: 1.5rem 1rem;
      display: flex;
      flex-direction: column;
      gap: 1rem;
    }

    #messages {
      flex: 1;
      overflow-y: auto;
      display: flex;
      flex-direction: column;
      gap: 0.75rem;
    }

    .message {
      padding: 0.75rem 1rem;
      border-radius: 12px;
      max-width: 85%;
      line-height: 1.5;
      font-size: 0.95rem;
    }

    .message.user {
      background: var(--text);
      color: var(--surface);
      align-self: flex-end;
      border-bottom-right-radius: 4px;
    }

    .message.assistant {
      background: var(--surface);
      border: 1px solid var(--border);
      align-self: flex-start;
      border-bottom-left-radius: 4px;
    }

    .message.assistant a {
      color: var(--accent);
      text-decoration: none;
    }

    .message.assistant a:hover { text-decoration: underline; }

    .message.assistant p { margin-bottom: 0.5rem; }
    .message.assistant p:last-child { margin-bottom: 0; }

    .message.assistant ul, .message.assistant ol {
      margin: 0.5rem 0 0.5rem 1.25rem;
    }

    .message.assistant strong { font-weight: 600; }

    .sources {
      margin-top: 0.5rem;
      padding-top: 0.5rem;
      border-top: 1px solid var(--border);
      font-size: 0.8rem;
      color: var(--text-muted);
    }

    .sources a {
      color: var(--accent) !important;
      display: inline-block;
      margin-right: 0.5rem;
    }

    .typing-indicator {
      display: inline-block;
      padding: 0.5rem 1rem;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 12px;
      align-self: flex-start;
      font-size: 0.9rem;
      color: var(--text-muted);
    }

    .typing-indicator span {
      animation: blink 1.4s infinite both;
    }
    .typing-indicator span:nth-child(2) { animation-delay: 0.2s; }
    .typing-indicator span:nth-child(3) { animation-delay: 0.4s; }

    @keyframes blink {
      0%, 80%, 100% { opacity: 0.2; }
      40% { opacity: 1; }
    }

    #input-area {
      display: flex;
      gap: 0.5rem;
      padding: 0.5rem 0;
    }

    #query-input {
      flex: 1;
      padding: 0.75rem 1rem;
      border: 1px solid var(--border);
      border-radius: 24px;
      font-size: 0.95rem;
      outline: none;
      transition: border-color 0.2s;
    }

    #query-input:focus { border-color: var(--accent); }

    #send-btn {
      padding: 0.75rem 1.25rem;
      background: var(--accent);
      color: #fff;
      border: none;
      border-radius: 24px;
      font-size: 0.95rem;
      font-weight: 700;
      cursor: pointer;
      transition: background 0.2s;
    }

    #send-btn:hover { background: var(--accent-hover); }
    #send-btn:disabled { background: var(--border); color: var(--text-muted); cursor: not-allowed; }

    footer {
      text-align: center;
      padding: 0.75rem;
      font-size: 0.75rem;
      color: var(--text-muted);
    }

    footer a { color: var(--accent); text-decoration: none; }
  </style>
</head>
<body>
  <header>
    <h1>Chat<span>JPT</span></h1>
    <p>Vraag het aan Cityguys</p>
  </header>

  <main>
    <div id="messages">
      <div class="message assistant">
        Hey! Ik ben ChatJPT. Stel me een vraag over Cityguys en ik zoek het voor je uit.
      </div>
    </div>

    <div id="input-area">
      <input type="text" id="query-input" placeholder="Stel een vraag..." autocomplete="off">
      <button id="send-btn">Verstuur</button>
    </div>
  </main>

  <footer>
    Powered by <a href="https://cityguys.nl" target="_blank">Cityguys</a> &amp; Cloudflare Workers AI
  </footer>

  <script>
    const messages = document.getElementById('messages');
    const input = document.getElementById('query-input');
    const sendBtn = document.getElementById('send-btn');
    const history = [];

    function escapeHtml(text) {
      const div = document.createElement('div');
      div.textContent = text;
      return div.innerHTML;
    }

    // Minimal markdown to HTML (bold, links, lists, paragraphs)
    function renderMarkdown(md) {
      return md
        .replace(/\\*\\*(.+?)\\*\\*/g, '<strong>$1</strong>')
        .replace(/\\[([^\\]]+)\\]\\(([^)]+)\\)/g, '<a href="$2" target="_blank">$1</a>')
        .replace(/^[-*] (.+)$/gm, '<li>$1</li>')
        .replace(/(<li>.*<\\/li>\\n?)+/g, (m) => '<ul>' + m + '</ul>')
        .replace(/\\n\\n/g, '</p><p>')
        .replace(/\\n/g, '<br>')
        .replace(/^/, '<p>')
        .replace(/$/, '</p>');
    }

    function addMessage(role, content) {
      const div = document.createElement('div');
      div.className = 'message ' + role;
      if (role === 'assistant') {
        div.innerHTML = renderMarkdown(content);
      } else {
        div.textContent = content;
      }
      messages.appendChild(div);
      messages.scrollTop = messages.scrollHeight;
      return div;
    }

    function addSources(el, sources) {
      if (!sources || sources.length === 0) return;
      const div = document.createElement('div');
      div.className = 'sources';
      div.innerHTML = 'Bronnen: ' + sources.map(
        (s) => '<a href="' + escapeHtml(s.url) + '" target="_blank">' + escapeHtml(s.title) + '</a>'
      ).join(' ');
      el.appendChild(div);
    }

    function showTyping() {
      const div = document.createElement('div');
      div.className = 'typing-indicator';
      div.id = 'typing';
      div.innerHTML = '<span>.</span><span>.</span><span>.</span>';
      messages.appendChild(div);
      messages.scrollTop = messages.scrollHeight;
    }

    function removeTyping() {
      const el = document.getElementById('typing');
      if (el) el.remove();
    }

    async function ask(query) {
      addMessage('user', query);
      input.value = '';
      sendBtn.disabled = true;
      showTyping();

      try {
        const params = new URLSearchParams({
          q: query,
          mode: 'stream',
        });
        if (history.length > 0) {
          params.set('prev', JSON.stringify(history.slice(-3)));
        }

        const res = await fetch('/chatjpt/ask?' + params.toString());

        if (!res.ok) {
          removeTyping();
          const err = await res.json().catch(() => ({}));
          addMessage('assistant', err.error || 'Er ging iets mis. Probeer het opnieuw.');
          sendBtn.disabled = false;
          return;
        }

        // Check if streaming (SSE) or JSON
        const contentType = res.headers.get('content-type') || '';
        if (contentType.includes('text/event-stream')) {
          removeTyping();
          const msgEl = addMessage('assistant', '');
          let fullAnswer = '';

          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          let buffer = '';

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
              if (!line.startsWith('data: ')) continue;
              const raw = line.slice(6);
              try {
                const data = JSON.parse(raw);
                if (data.token) {
                  fullAnswer += data.token;
                  msgEl.innerHTML = renderMarkdown(fullAnswer);
                  messages.scrollTop = messages.scrollHeight;
                }
                if (data.fallback) {
                  fullAnswer = data.fallback;
                  msgEl.innerHTML = renderMarkdown(fullAnswer);
                }
                if (data.sources) {
                  addSources(msgEl, data.sources);
                }
                if (data.error) {
                  if (!fullAnswer) {
                    msgEl.innerHTML = renderMarkdown(data.error);
                  }
                }
              } catch { /* skip non-JSON */ }
            }
          }

          history.push({ query, answer: fullAnswer });
        } else {
          // JSON response (non-streaming fallback)
          removeTyping();
          const data = await res.json();
          const answer = data.answer || data.summary || 'Geen antwoord gevonden.';
          const msgEl = addMessage('assistant', answer);
          if (data.sources) addSources(msgEl, data.sources);
          history.push({ query, answer });
        }
      } catch (err) {
        removeTyping();
        addMessage('assistant', 'Er ging iets mis met de verbinding. Probeer het opnieuw.');
      }

      sendBtn.disabled = false;
      input.focus();
    }

    sendBtn.addEventListener('click', () => {
      const q = input.value.trim();
      if (q) ask(q);
    });

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const q = input.value.trim();
        if (q) ask(q);
      }
    });

    input.focus();
  </script>
</body>
</html>`;
}
