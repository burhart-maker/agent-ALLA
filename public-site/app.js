(function () {
  const TENANT = 'roility'; // this deployment of the public site = the roility tenant
  const scrollEl = document.getElementById('chatScroll');
  const form = document.getElementById('composer');
  const input = document.getElementById('composerInput');

  const history = []; // [{role, content}], sent back to the backend each turn

  function addMessage(role, content, pending) {
    const div = document.createElement('div');
    div.className = 'msg ' + (role === 'user' ? 'user' : 'alla') + (pending ? ' pending' : '');
    div.textContent = content;
    scrollEl.appendChild(div);
    scrollEl.scrollTop = scrollEl.scrollHeight;
    return div;
  }

  async function send(text) {
    addMessage('user', text);
    history.push({ role: 'user', content: text });
    const pendingEl = addMessage('assistant', 'Thinking…', true);

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tenant: TENANT, messages: history }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'request failed');

      pendingEl.textContent = data.reply;
      pendingEl.classList.remove('pending');
      history.push({ role: 'assistant', content: data.reply });
    } catch (err) {
      pendingEl.textContent = "Sorry — I couldn't reach the server just now. Please try again.";
      pendingEl.classList.remove('pending');
    }
  }

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    send(text);
  });
})();
