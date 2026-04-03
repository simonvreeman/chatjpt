/**
 * ChatJPT — Chat UI Module
 *
 * Generates a self-contained HTML5 chat interface served at /chatjpt.
 * The entire page — HTML, CSS, and JavaScript — is returned as a single
 * template literal string. No external dependencies, no build step.
 *
 * Features:
 * - Real-time SSE streaming with token-by-token display (typewriter effect)
 * - Minimal markdown rendering (bold, links, lists, paragraphs)
 * - Source citation display below each answer
 * - Conversation history tracking (sent as `prev` parameter for context)
 * - Responsive layout (mobile-friendly, max-width 720px)
 * - Accessible: focus-visible outlines, semantic HTML, keyboard support
 * - Cityguys-branded color scheme (warm neutrals with pink accent)
 *
 * Design decisions:
 * - Self-contained: No external CSS/JS files means zero additional HTTP requests
 *   and trivial deployment (just the Worker, no static assets to manage).
 * - Vanilla JS: At ~160 lines of client-side JS, a framework would add more
 *   complexity than it removes. EventSource isn't used because we need to
 *   read raw SSE from a fetch() response body for better error handling.
 * - Emoji favicon: Avoids a separate favicon.ico request to the Worker.
 */

/**
 * Returns the complete HTML page as a string.
 * Called by the Worker's fetch handler when the user visits /chatjpt.
 *
 * @returns {string} Complete HTML document for the chat UI.
 */
export function chatPage() {
  return `<!DOCTYPE html>
<html lang="nl">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>ChatJPT - Vraag het aan Cityguys</title>
  <!-- Inline SVG emoji favicon — avoids an extra HTTP request for favicon.ico -->
  <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🍔</text></svg>">
  <style>
    /* ────────────────────────────────────────────
       CSS Custom Properties (Design Tokens)
       Cityguys brand: warm neutrals with a pink accent (#EA0059).
       ──────────────────────────────────────────── */
    :root {
      --bg: #f7f5f2;             /* Page background: warm off-white */
      --surface: #ffffff;         /* Card/message background */
      --surface2: #f0edea;        /* Secondary surface (unused, reserved) */
      --border: #e2ddd6;          /* Border color: warm gray */
      --text: #1c1917;            /* Primary text: near-black */
      --text-muted: #78716c;      /* Secondary text: warm medium gray */
      --accent: #EA0059;          /* Brand accent: Cityguys pink */
      --accent-hover: #D50051;    /* Accent on hover: slightly darker pink */
      --accent-light: #fed7aa;    /* Light accent (unused, reserved for highlights) */
    }

    /* ── Dark Mode (auto-detected from OS preference) ── */
    @media (prefers-color-scheme: dark) {
      :root {
        --bg: #010017;
        --surface: #030030;
        --surface2: #0a0a3a;
        --border: #1a1a4a;
        --text: #e5e5e5;
        --text-muted: #a3a3a3;
        --accent: #FF2D78;
        --accent-hover: #FF4D8E;
        --accent-light: #5c2d3a;
      }
    }

    /* Reset: normalize spacing and use border-box for predictable sizing */
    * { margin: 0; padding: 0; box-sizing: border-box; }

    body {
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: var(--bg);
      color: var(--text);
      min-height: 100vh;
      display: flex;
      flex-direction: column;
    }

    /* Accessible focus indicator: visible outline on keyboard navigation */
    *:focus-visible {
      outline: 2px solid var(--accent);
      outline-offset: 2px;
    }

    /* ── Header ────────────────────────────────── */
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

    /* "JPT" in the title is accented pink */
    header h1 span { color: var(--accent); }

    header p {
      font-size: 0.85rem;
      color: var(--text-muted);
      margin-top: 0.25rem;
    }

    /* ── Main Content Area ─────────────────────── */
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

    /* Messages container: scrollable chat log */
    #messages {
      flex: 1;
      overflow-y: auto;
      display: flex;
      flex-direction: column;
      gap: 0.75rem;
    }

    /* ── Chat Bubbles ──────────────────────────── */
    .message {
      padding: 0.75rem 1rem;
      border-radius: 12px;
      max-width: 85%;
      line-height: 1.5;
      font-size: 0.95rem;
    }

    /* User messages: dark background, aligned right with squared bottom-right corner */
    .message.user {
      background: var(--text);
      color: var(--surface);
      align-self: flex-end;
      border-bottom-right-radius: 4px;
    }

    /* Assistant messages: white background with border, aligned left */
    .message.assistant {
      background: var(--surface);
      border: 1px solid var(--border);
      align-self: flex-start;
      border-bottom-left-radius: 4px;
    }

    /* Links in assistant messages use the accent color */
    .message.assistant a {
      color: var(--accent);
      text-decoration: none;
    }

    .message.assistant a:hover { text-decoration: underline; }

    /* Spacing for paragraphs within assistant messages */
    .message.assistant p { margin-bottom: 0.5rem; }
    .message.assistant p:last-child { margin-bottom: 0; }

    /* List styling within assistant messages */
    .message.assistant ul, .message.assistant ol {
      margin: 0.5rem 0 0.5rem 1.25rem;
    }

    .message.assistant strong { font-weight: 600; }

    /* ── Source Citations ───────────────────────── */
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

    /* ── Typing Indicator (three bouncing dots) ── */
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

    /* Each dot blinks with a staggered delay for a wave effect */
    .typing-indicator span {
      animation: blink 1.4s infinite both;
    }
    .typing-indicator span:nth-child(2) { animation-delay: 0.2s; }
    .typing-indicator span:nth-child(3) { animation-delay: 0.4s; }

    @keyframes blink {
      0%, 80%, 100% { opacity: 0.2; }
      40% { opacity: 1; }
    }

    /* ── Input Area ─────────────────────────────── */
    #input-area {
      display: flex;
      align-items: flex-end;
      gap: 0.5rem;
      padding: 0.5rem 0;
    }

    /* Text input: pill-shaped with subtle border, auto-expands */
    #query-input {
      flex: 1;
      height: 42px;
      padding: 0.575rem 1rem;
      border: 1px solid var(--border);
      border-radius: 24px;
      font-size: 0.95rem;
      outline: none;
      transition: border-color 0.2s;
      background: var(--surface);
      color: var(--text);
      resize: none;
      overflow-y: hidden;
      font-family: inherit;
      line-height: 1.4;
      max-height: 150px;
    }

    /* Accent border on focus */
    #query-input:focus { border-color: var(--accent); }

    /* Send button: pill-shaped accent button */
    #send-btn {
      height: 42px;
      padding: 0 1.25rem;
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

    /* Reset button: subtle circular button to start a new conversation */
    #reset-btn {
      width: 42px;
      height: 42px;
      border: 1px solid var(--border);
      border-radius: 50%;
      background: var(--surface);
      color: var(--text-muted);
      font-size: 1.2rem;
      cursor: pointer;
      transition: border-color 0.2s, color 0.2s;
      flex-shrink: 0;
    }

    #reset-btn:hover { border-color: var(--accent); color: var(--accent); }

    /* ── Footer ─────────────────────────────────── */
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
  <!-- ── Page Header ───────────────────────────── -->
  <header>
    <h1>Chat<span>JPT</span></h1>
    <p>Vraag het aan Cityguys</p>
  </header>

  <!-- ── Chat Interface ────────────────────────── -->
  <main>
    <!-- Messages container: holds all chat bubbles -->
    <div id="messages">
      <!-- Initial greeting message from the assistant -->
      <div class="message assistant">
        Dit is ChatJPT, de AI die alles weet wat Cityguys ooit heeft opgeschreven. 🍔 Burgers, 🍺 bars, 🏙️ citytrips, noem het maar. Vraag maar raak.
      </div>
    </div>

    <!-- Query input area: text field + send/reset buttons -->
    <div id="input-area">
      <button id="reset-btn" title="Nieuw gesprek" aria-label="Nieuw gesprek" style="display:none;">&#x21bb;</button>
      <textarea id="query-input" placeholder="Stel een vraag..." autocomplete="off" rows="1"></textarea>
      <button id="send-btn">Verstuur</button>
    </div>
  </main>

  <!-- ── Footer ────────────────────────────────── -->
  <footer>
    Powered by <a href="https://cityguys.nl" target="_blank">Cityguys</a> &amp; Cloudflare Workers AI
  </footer>

  <script>
    // ────────────────────────────────────────────
    // DOM References & State
    // ────────────────────────────────────────────

    /** @type {HTMLElement} The messages container element */
    const messages = document.getElementById('messages');
    /** @type {HTMLTextAreaElement} The query text area */
    const input = document.getElementById('query-input');
    /** @type {HTMLButtonElement} The send button */
    const sendBtn = document.getElementById('send-btn');
    /** @type {HTMLButtonElement} The reset button */
    const resetBtn = document.getElementById('reset-btn');

    /**
     * Conversation history — stores previous { query, answer } pairs.
     * Sent to the API as the 'prev' parameter (last 3 exchanges) so
     * the LLM has context for follow-up questions.
     */
    const history = [];

    /**
     * Session storage key for persisting conversation across navigations.
     */
    const STORAGE_KEY = 'chatjpt_conversation';

    /**
     * Saves current conversation state (history + displayed messages) to
     * sessionStorage so it survives page navigations within the same tab.
     */
    function saveConversation() {
      try {
        sessionStorage.setItem(STORAGE_KEY, JSON.stringify(history));
      } catch { /* Storage full or unavailable — silently degrade */ }
    }

    /**
     * Restores a previous conversation from sessionStorage.
     * Re-renders all messages and rebuilds the history array.
     */
    function restoreConversation() {
      try {
        const saved = sessionStorage.getItem(STORAGE_KEY);
        if (!saved) return;
        const entries = JSON.parse(saved);
        if (!Array.isArray(entries) || entries.length === 0) return;

        // Remove the default greeting — we'll replay the conversation
        messages.innerHTML = '';

        for (const entry of entries) {
          addMessage('user', entry.query);
          const msgEl = addMessage('assistant', entry.answer);
          if (entry.sources) addSources(msgEl, entry.sources);
          history.push(entry);
        }

        // Show reset button when there's conversation to clear
        resetBtn.style.display = '';
      } catch {
        // Corrupted data — clear it and start fresh
        sessionStorage.removeItem(STORAGE_KEY);
      }
    }

    // ────────────────────────────────────────────
    // Utility Functions
    // ────────────────────────────────────────────

    /**
     * Escapes HTML special characters to prevent XSS when inserting
     * user-generated text into the DOM via innerHTML.
     * Uses a temporary div element for safe encoding.
     *
     * @param {string} text - Raw text to escape.
     * @returns {string} HTML-safe string.
     */
    function escapeHtml(text) {
      const div = document.createElement('div');
      div.textContent = text;
      return div.innerHTML;
    }

    /**
     * Converts a subset of markdown to HTML for rendering assistant messages.
     *
     * Supported syntax:
     * - **bold** → <strong>bold</strong>
     * - [text](url) → <a href="url" target="_blank">text</a>
     * - Lines starting with - or * → <li> wrapped in <ul>
     * - Double newlines → paragraph breaks
     * - Single newlines → <br> line breaks
     *
     * This is intentionally minimal — it covers the markdown patterns the LLM
     * actually uses in its responses without the weight of a full parser.
     *
     * @param {string} md - Markdown text from the LLM.
     * @returns {string} HTML string safe for innerHTML.
     */
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

    // ────────────────────────────────────────────
    // Chat UI Functions
    // ────────────────────────────────────────────

    /**
     * Adds a new message bubble to the chat log.
     *
     * @param {string} role - 'user' or 'assistant' (determines styling and alignment).
     * @param {string} content - Message text. Assistant messages are rendered as
     *   markdown; user messages are plain text (XSS-safe via textContent).
     * @returns {HTMLElement} The created message div (for later updates during streaming).
     */
    function addMessage(role, content) {
      const div = document.createElement('div');
      div.className = 'message ' + role;
      if (role === 'assistant') {
        div.innerHTML = renderMarkdown(content);
      } else {
        div.textContent = content;
      }
      messages.appendChild(div);
      // Auto-scroll to the latest message
      messages.scrollTop = messages.scrollHeight;
      return div;
    }

    /**
     * Appends a source citation block below an assistant message.
     * Each source is rendered as a clickable link that opens in a new tab.
     *
     * @param {HTMLElement} el - The assistant message element to append sources to.
     * @param {Object[]} sources - Array of { url, title } source objects.
     */
    function addSources(el, sources) {
      if (!sources || sources.length === 0) return;
      const div = document.createElement('div');
      div.className = 'sources';
      div.innerHTML = 'Bronnen: ' + sources.map(
        (s) => '<a href="' + escapeHtml(s.url) + '" target="_blank">' + escapeHtml(s.title) + '</a>'
      ).join(' ');
      el.appendChild(div);
    }

    /**
     * Shows a "typing" indicator (three animated dots) while waiting
     * for the AI response.
     */
    function showTyping() {
      const div = document.createElement('div');
      div.className = 'typing-indicator';
      div.id = 'typing';
      div.innerHTML = '<span>.</span><span>.</span><span>.</span>';
      messages.appendChild(div);
      messages.scrollTop = messages.scrollHeight;
    }

    /**
     * Removes the typing indicator from the chat log.
     * Called when the first token arrives or when an error occurs.
     */
    function removeTyping() {
      const el = document.getElementById('typing');
      if (el) el.remove();
    }

    // ────────────────────────────────────────────
    // Main Query Handler
    // ────────────────────────────────────────────

    /**
     * Sends a query to the ChatJPT API and handles the response.
     *
     * Supports two response modes:
     * 1. **SSE streaming** (text/event-stream): Reads tokens from the stream
     *    one by one, updating the message bubble in real-time for a typewriter
     *    effect. The stream ends with a final message containing source citations.
     *
     * 2. **JSON fallback**: If the server returns JSON instead of SSE (e.g.,
     *    when streaming fails), the complete answer is displayed at once.
     *
     * Conversation history (last 3 exchanges) is sent as the 'prev' parameter
     * to enable context-aware follow-up questions.
     *
     * @param {string} query - The user's question to send to the API.
     */
    async function ask(query) {
      // Display the user's message and reset the input
      addMessage('user', query);
      input.value = '';
      input.style.height = 'auto';
      sendBtn.disabled = true;
      showTyping();

      try {
        // Build the API request URL with query parameters
        const params = new URLSearchParams({
          q: query,
          mode: 'stream',
        });
        // Include conversation history for context (last 3 exchanges)
        if (history.length > 0) {
          params.set('prev', JSON.stringify(history.slice(-3)));
        }

        const res = await fetch('/chatjpt/ask?' + params.toString());

        // Handle HTTP errors (non-2xx status)
        if (!res.ok) {
          removeTyping();
          const err = await res.json().catch(() => ({}));
          addMessage('assistant', err.error || 'Er ging iets mis. Probeer het opnieuw.');
          sendBtn.disabled = false;
          return;
        }

        // Determine response type: SSE stream or JSON
        const contentType = res.headers.get('content-type') || '';

        if (contentType.includes('text/event-stream')) {
          // ── SSE Streaming Mode ──────────────────
          removeTyping();
          // Create an empty message bubble that we'll fill token by token
          const msgEl = addMessage('assistant', '');
          let fullAnswer = '';
          let lastSources = null;

          // Read the SSE stream using a ReadableStream reader
          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          let buffer = ''; // Buffer for incomplete SSE lines

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            // Decode the chunk and add to buffer
            buffer += decoder.decode(value, { stream: true });
            // Split on newlines; keep the last incomplete line in the buffer
            const lines = buffer.split('\\n');
            buffer = lines.pop() || '';

            // Process each complete SSE line
            for (const line of lines) {
              if (!line.startsWith('data: ')) continue;
              const raw = line.slice(6); // Remove "data: " prefix
              try {
                const data = JSON.parse(raw);

                // Token received — append to the message and re-render
                if (data.token) {
                  fullAnswer += data.token;
                  msgEl.innerHTML = renderMarkdown(fullAnswer);
                  messages.scrollTop = messages.scrollHeight;
                }

                // Fallback response (AI produced too short an answer)
                if (data.fallback) {
                  fullAnswer = data.fallback;
                  msgEl.innerHTML = renderMarkdown(fullAnswer);
                }

                // Source citations (sent in the final SSE message)
                if (data.sources) {
                  lastSources = data.sources;
                  addSources(msgEl, data.sources);
                }

                // Error during streaming
                if (data.error) {
                  if (!fullAnswer) {
                    msgEl.innerHTML = renderMarkdown(data.error);
                  }
                }
              } catch { /* Skip non-JSON lines (e.g., empty lines, comments) */ }
            }
          }

          // Store this exchange for conversation history
          history.push({ query, answer: fullAnswer, sources: lastSources });
          resetBtn.style.display = '';
          saveConversation();

        } else {
          // ── JSON Fallback Mode ──────────────────
          // Server returned a complete JSON response instead of SSE
          removeTyping();
          const data = await res.json();
          const answer = data.answer || data.summary || 'Geen antwoord gevonden.';
          const msgEl = addMessage('assistant', answer);
          if (data.sources) addSources(msgEl, data.sources);
          history.push({ query, answer, sources: data.sources || null });
          resetBtn.style.display = '';
          saveConversation();
        }
      } catch (err) {
        // Network error or other unexpected failure
        removeTyping();
        addMessage('assistant', 'Er ging iets mis met de verbinding. Probeer het opnieuw.');
      }

      // Re-enable the input for the next question
      sendBtn.disabled = false;
      input.focus();
    }

    // ────────────────────────────────────────────
    // Event Listeners
    // ────────────────────────────────────────────

    // Restore any previous conversation from this browser tab
    restoreConversation();

    // Send on button click
    sendBtn.addEventListener('click', () => {
      const q = input.value.trim();
      if (q) ask(q);
    });

    // Reset: clear conversation and start fresh
    resetBtn.addEventListener('click', () => {
      history.length = 0;
      sessionStorage.removeItem(STORAGE_KEY);
      messages.innerHTML = '<div class="message assistant">Dit is ChatJPT, de AI die alles weet wat Cityguys ooit heeft opgeschreven. \u{1F354} Burgers, \u{1F37A} bars, \u{1F3D9}\uFE0F citytrips, noem het maar. Vraag maar raak.</div>';
      resetBtn.style.display = 'none';
      input.focus();
    });

    // Auto-resize textarea as content changes
    function autoResize() {
      input.style.height = 'auto';
      input.style.height = input.scrollHeight + 'px';
      input.style.overflowY = input.scrollHeight > 150 ? 'auto' : 'hidden';
    }
    input.addEventListener('input', autoResize);

    // Send on Enter, newline on Shift+Enter
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        const q = input.value.trim();
        if (q) ask(q);
      }
    });

    // Auto-focus the input field on page load
    input.focus();
  </script>
</body>
</html>`;
}
