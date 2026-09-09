# Alla — working backend, public site, and embeddable widget

This is real, runnable code — not the Claude-artifact prototype
(`alla-mvp.html`), which only works inside a Claude/Cowork session. This
calls the Anthropic API directly from a normal Node.js server, so it works
from any browser, any device, once deployed.

## What's in here

```
backend/        Express API server. Serves /api/chat, the public site,
                 and the widget script, all from one process.
public-site/    The public "About Alla" + working chat page
                 (installable to a phone home screen — see below).
widget/         alla-widget.js — the one <script> tag any agency adds
                 to their own site to get the floating pink orb + chat.
```

## What you need to provide before this can go live

I can write and test the code, but I cannot make it *live and public*
without a few things only you can provide:

1. **Your own Anthropic API key** (from console.anthropic.com). The Claude
   session capability used in the `alla-mvp.html` prototype does not work
   outside a Claude conversation — a real server needs a real key, billed
   to your own account.
2. **A hosting target.** Any Node.js host works (Render, Railway, Fly.io,
   a VPS, etc.) — I don't have a preference you're locked into, but I'd
   suggest Render or Railway for the fastest path to "it has a public
   URL" with the least setup. Tell me which one you want and I can write
   the exact deploy steps for it.
3. **The domain name** you mentioned you already own — I need the exact
   spelling to wire it up (DNS, HTTPS cert, links).
4. **App-store accounts**, only for a *native* mobile app later (Apple
   Developer Program, ~$99/year; Google Play, one-time ~$25). Not needed
   for what's built here — see "Mobile" below.

Nothing above blocks you from testing this right now on your own machine
(see "Run it locally").

## Run it locally right now

```bash
cd backend
cp .env.example .env
# edit .env, paste your ANTHROPIC_API_KEY
npm install
npm start
```

Then open `http://localhost:3000` — that's the public chat site, working
for real, calling the real Anthropic API. The widget is served at
`http://localhost:3000/widget/alla-widget.js` for testing on any local
HTML page:

```html
<script src="http://localhost:3000/widget/alla-widget.js"
        data-tenant="roility"
        data-backend="http://localhost:3000"></script>
```

## Deploying it publicly (once you pick a host)

The shape is the same on any Node host:
1. Push `backend/`, `public-site/`, and `widget/` to the host.
2. Set the `ANTHROPIC_API_KEY` environment variable in the host's
   dashboard (never commit it to a repo).
3. Point your domain's DNS at the host, or use the host's default URL to
   start.
4. Agencies embed the widget from your public backend URL, e.g.:
   `<script src="https://alla-yourdomain.com/widget/alla-widget.js" data-tenant="roility" data-backend="https://alla-yourdomain.com"></script>`

Tell me which host you want and I'll write the exact step-by-step for
that specific platform (they differ slightly in how env vars and
deploys are configured).

## Mobile — what's realistic now vs. later

**Now, with zero app-store review:** the public site is a installable
Progressive Web App (PWA) — `manifest.json` + a minimal service worker
are already wired up. Once deployed on a real HTTPS domain, a visitor on
a phone can open the site and use "Add to Home Screen" (Android: browser
menu; iPhone: Safari share sheet → Add to Home Screen). It then behaves
like an installed app icon — full-screen, no browser chrome — with zero
app-store submission or waiting for review. This is genuinely
installable today, not a placeholder.

**Later, if you want it in the App Store / Google Play specifically:**
that requires wrapping this (or rebuilding the client) in a native shell
— React Native, Flutter, or Capacitor are the standard choices — plus the
developer accounts listed above and each store's review process (Apple
review can take a few days; rejections for a first submission are
common and normal, budget time for at least one round of fixes). This is
real, multi-week work, not something to promise for the Santander
timeline — I'd treat it as the Phase 2 already described in
`layer-3-saas-architecture.md`.

## What is deliberately NOT done yet (honest gaps, not oversights)

- **Multi-tenant beyond ROILITY.** Only the `roility` tenant overlay
  exists (`backend/src/prompt/tenants/roility.js`). MallorcaIbiza/Natalia
  needs real data before her tenant file can be written honestly — see
  `status-and-open-items.md` §2.
- **No conversation persistence.** Chat history lives only in the
  browser tab's memory (`history` array in `app.js`/`alla-widget.js`) and
  is lost on refresh. The `Communication`/`Handoff` object model from the
  transaction-graph addendum is architecture, not yet code — this is the
  next real milestone once the basic chat is confirmed live and working.
- **CORS is wide open** (`app.use(cors())` with no allow-list) so the
  widget works from any agency domain immediately. Fine for a pilot with
  one or two known tenants; tighten to an explicit domain allow-list
  before opening this to unknown third parties.
- **No rate limiting / abuse protection** on `/api/chat` — add this
  before the public URL is shared widely, not before internal testing.
- **Role/disclosure model (`alla_role`) from the graph-communicator
  addendum is not implemented** — this server always answers as a
  neutral advisor. Fine for the current buyer-facing/website-agent use
  case; needed before the copilot/agency-employee roles go live for real
  (per master spec §16/40, disclosure must not be left to the model's
  discretion).
