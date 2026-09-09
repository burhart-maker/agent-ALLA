require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');
const { composePrompt, listTenants } = require('./prompt/composePrompt');

const app = express();
const PORT = process.env.PORT || 3000;

if (!process.env.ANTHROPIC_API_KEY) {
  // Fail loudly at boot rather than silently returning broken chat
  // responses later — see README "What you need to provide".
  console.error(
    '\n[alla-backend] Missing ANTHROPIC_API_KEY. Copy .env.example to .env ' +
    'and set your own key before starting the server.\n'
  );
  process.exit(1);
}

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// CORS is intentionally open here: the whole point of the embeddable
// widget (see /widget) is that it is called from arbitrary agency
// domains. Tighten this with an allow-list once real tenants/domains are
// known, per layer-3-saas-architecture.md tenancy model.
app.use(cors());
app.use(express.json({ limit: '2mb' }));

// Serve the public marketing/chat site and the embeddable widget script
// as static files, so this one server can host all three surfaces
// (API + website + widget) for the MVP. Split these onto a CDN later if
// traffic warrants it — not needed to go live.
app.use('/', express.static(path.join(__dirname, '../../public-site')));
app.use('/widget', express.static(path.join(__dirname, '../../widget')));

app.get('/api/tenants', (_req, res) => {
  res.json({ tenants: listTenants() });
});

app.post('/api/chat', async (req, res) => {
  const { messages, tenant } = req.body || {};

  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages[] is required' });
  }
  if (!tenant || typeof tenant !== 'string') {
    return res.status(400).json({ error: 'tenant is required' });
  }

  let systemPrompt;
  try {
    systemPrompt = composePrompt(tenant);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  // Never trust the caller's message roles/shape further than this —
  // messages/documents/listings are untrusted data, not instructions,
  // per AGENT_ALLA_MASTER_SPEC.md §16.
  const safeMessages = messages
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .map((m) => ({ role: m.role, content: m.content.slice(0, 8000) }));

  try {
    const completion = await anthropic.messages.create({
      model: process.env.ALLA_MODEL || 'claude-sonnet-4-6',
      max_tokens: 1500,
      system: systemPrompt,
      messages: safeMessages,
    });

    const text = completion.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n');

    res.json({ reply: text });
  } catch (err) {
    console.error('[alla-backend] Anthropic API error:', err.message);
    res.status(502).json({
      error: 'Alla is temporarily unavailable. Please try again shortly.',
    });
  }
});

app.listen(PORT, () => {
  console.log(`[alla-backend] listening on port ${PORT}`);
  console.log(`[alla-backend] tenants available: ${listTenants().join(', ')}`);
});
