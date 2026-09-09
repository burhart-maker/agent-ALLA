/**
 * Alla embeddable website-agent widget.
 *
 * Usage on an agency's site:
 *   <script
 *     src="https://YOUR-DEPLOYED-BACKEND/widget/alla-widget.js"
 *     data-tenant="roility"
 *     data-backend="https://YOUR-DEPLOYED-BACKEND"
 *   ></script>
 *
 * This is a self-contained script (no build step, no framework) that
 * injects the floating pink orb + chat panel into whatever page it's
 * loaded on, and talks to the same /api/chat endpoint the public site
 * uses. It is the "website agent" role from the addendum — a visitor
 * chats directly with Alla, free to the visitor, paid for by the agency
 * embedding it.
 */
(function () {
  const scriptEl = document.currentScript;
  const TENANT = scriptEl.getAttribute('data-tenant') || 'roility';
  const BACKEND = (scriptEl.getAttribute('data-backend') || '').replace(/\/$/, '');

  if (!BACKEND) {
    console.error('[alla-widget] Missing data-backend attribute on the <script> tag.');
    return;
  }

  const history = [];
  let open = false;

  const style = document.createElement('style');
  style.textContent = `
    .alla-orb {
      position: fixed; bottom: 20px; right: 20px; width: 60px; height: 60px;
      border-radius: 50%; background: #e10886; color: #fff; border: none;
      box-shadow: 0 6px 20px rgba(225,8,134,0.4); cursor: pointer; z-index: 999999;
      font-family: 'Space Grotesk', system-ui, sans-serif; font-weight: 700; font-size: 13px;
      animation: alla-spin-in 0.6s ease-out;
    }
    @keyframes alla-spin-in { from { transform: rotate(-90deg) scale(0.6); opacity: 0; } to { transform: rotate(0) scale(1); opacity: 1; } }
    .alla-panel {
      position: fixed; bottom: 92px; right: 20px; width: 340px; max-width: calc(100vw - 32px);
      height: 460px; max-height: calc(100vh - 140px); background: #fff; border-radius: 16px;
      box-shadow: 0 12px 40px rgba(0,0,0,0.18); display: none; flex-direction: column; overflow: hidden;
      font-family: 'Manrope', system-ui, sans-serif; z-index: 999999; border: 1px solid #ece7ec;
    }
    .alla-panel.open { display: flex; }
    .alla-panel-header { background: #e10886; color: #fff; padding: 12px 14px; font-weight: 600; font-size: 14px; }
    .alla-panel-body { flex: 1; overflow-y: auto; padding: 12px; display: flex; flex-direction: column; gap: 8px; }
    .alla-msg { padding: 8px 12px; border-radius: 12px; font-size: 13.5px; line-height: 1.4; max-width: 85%; white-space: pre-wrap; }
    .alla-msg.alla { background: #fbe3ef; align-self: flex-start; }
    .alla-msg.user { background: #17131a; color: #fff; align-self: flex-end; }
    .alla-panel-footer { display: flex; border-top: 1px solid #ece7ec; }
    .alla-panel-footer input { flex: 1; border: none; padding: 10px 12px; font-size: 13.5px; font-family: inherit; }
    .alla-panel-footer input:focus { outline: none; }
    .alla-panel-footer button { border: none; background: #e10886; color: #fff; padding: 0 14px; font-weight: 600; cursor: pointer; }
  `;
  document.head.appendChild(style);

  const orb = document.createElement('button');
  orb.className = 'alla-orb';
  orb.textContent = 'AllA';
  orb.setAttribute('aria-label', 'Chat with Alla');

  const panel = document.createElement('div');
  panel.className = 'alla-panel';
  panel.innerHTML = `
    <div class="alla-panel-header">Alla — ask about this property</div>
    <div class="alla-panel-body" id="alla-body">
      <div class="alla-msg alla">Hi! I'm Alla. Ask me anything about this listing, financing, or the buying process.</div>
    </div>
    <form class="alla-panel-footer" id="alla-form">
      <input id="alla-input" type="text" autocomplete="off" placeholder="Ask Alla…" />
      <button type="submit">Send</button>
    </form>
  `;

  document.body.appendChild(orb);
  document.body.appendChild(panel);

  const body = panel.querySelector('#alla-body');
  const form = panel.querySelector('#alla-form');
  const input = panel.querySelector('#alla-input');

  function addMsg(role, text, pending) {
    const div = document.createElement('div');
    div.className = 'alla-msg ' + (role === 'user' ? 'user' : 'alla');
    if (pending) div.style.opacity = '0.6';
    div.textContent = text;
    body.appendChild(div);
    body.scrollTop = body.scrollHeight;
    return div;
  }

  orb.addEventListener('click', () => {
    open = !open;
    panel.classList.toggle('open', open);
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    addMsg('user', text);
    history.push({ role: 'user', content: text });
    const pendingEl = addMsg('assistant', 'Thinking…', true);

    try {
      const res = await fetch(BACKEND + '/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tenant: TENANT, messages: history }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'request failed');
      pendingEl.textContent = data.reply;
      pendingEl.style.opacity = '1';
      history.push({ role: 'assistant', content: data.reply });
    } catch (err) {
      pendingEl.textContent = "Sorry — couldn't reach Alla just now.";
      pendingEl.style.opacity = '1';
    }
  });
})();
