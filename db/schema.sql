-- Agent Alla — accounts, entitlement and usage ledger (Cloudflare D1).
--
-- Applied with:
--   npx wrangler d1 execute alla --remote --file=schema.sql
--
-- Design notes that matter later:
--   * Money is stored as INTEGER micro-euros (1 EUR = 1_000_000), never as a
--     float. Floating-point euros drift, and this table is the source of
--     truth for what a customer owes.
--   * Model prices and the FX rate live in tables, not in code, so a price
--     change by Anthropic is a data update rather than a redeploy.
--   * Every write is idempotent-friendly: Stripe retries webhooks, and a
--     replayed event must not double-charge or double-credit anyone.

CREATE TABLE IF NOT EXISTS users (
  id                 TEXT PRIMARY KEY,
  email              TEXT NOT NULL UNIQUE,
  display_name       TEXT,              -- what this person is called in the UI
                                        -- (footer, cabinet). NULL -> the email.
  password_hash      TEXT,              -- NULL for OAuth-only accounts
  password_salt      TEXT,
  created_at         INTEGER NOT NULL,
  trial_started_at   INTEGER,           -- set on first message, not on signup
  trial_messages     INTEGER NOT NULL DEFAULT 0,
  stripe_customer_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_users_stripe ON users(stripe_customer_id);

-- Session tokens are stored hashed: a leaked database must not hand over
-- working sessions.
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS subscriptions (
  user_id                TEXT PRIMARY KEY,
  plan                   TEXT NOT NULL,            -- 'standard' | 'pro'
  status                 TEXT NOT NULL,            -- 'active' | 'past_due' | 'canceled' | 'trialing'
  stripe_subscription_id TEXT,
  current_period_start   INTEGER,
  current_period_end     INTEGER,
  autopay                INTEGER NOT NULL DEFAULT 0, -- overage charging is opt-in only
  updated_at             INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_subs_stripe ON subscriptions(stripe_subscription_id);

-- One row per answered message. This is what the allowance is measured
-- against, and what an invoice dispute would be reconstructed from.
CREATE TABLE IF NOT EXISTS usage_ledger (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       TEXT,                  -- NULL for anonymous visitors
  anon_key      TEXT,                  -- hashed IP+day bucket when user_id IS NULL
  at            INTEGER NOT NULL,
  model         TEXT NOT NULL,
  input_tokens  INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  -- Web searches are billed per search, not per token, so they are counted
  -- separately and folded into eur_micros alongside the token cost.
  search_requests INTEGER NOT NULL DEFAULT 0,
  eur_micros    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_usage_user_at ON usage_ledger(user_id, at);
CREATE INDEX IF NOT EXISTS idx_usage_anon_at ON usage_ledger(anon_key, at);

-- Stripe sends the same event more than once. Recording processed ids is
-- what makes the webhook safe to replay.
CREATE TABLE IF NOT EXISTS stripe_events (
  id           TEXT PRIMARY KEY,
  type         TEXT NOT NULL,
  processed_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS model_prices (
  model                 TEXT PRIMARY KEY,
  input_usd_per_mtok    REAL NOT NULL,
  output_usd_per_mtok   REAL NOT NULL,
  updated_at            INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- ---------------------------------------------------------------
-- Seed. Every one of these is a knob you can change with a single
-- UPDATE, without touching code.
-- ---------------------------------------------------------------

-- VERIFY BEFORE BILLING: list price for the model in use, USD per million
-- tokens. If Anthropic's published rate differs, update this row — every
-- euro figure in the product derives from it.
INSERT OR IGNORE INTO model_prices (model, input_usd_per_mtok, output_usd_per_mtok, updated_at)
VALUES ('claude-sonnet-4-5-20250929', 3.0, 15.0, 0);

INSERT OR IGNORE INTO settings (key, value) VALUES
  ('usd_to_eur',              '0.92'),   -- refresh periodically
  ('web_search_usd_per_search','0.01'),  -- billed per search on top of tokens
  ('trial_days',              '14'),
  ('trial_messages',          '25'),
  ('anon_messages_per_day',   '5'),      -- what a signed-out visitor gets
  ('allowance_standard_eur',  '10'),     -- underlying model cost included in €36
  ('allowance_pro_eur',       '25'),     -- underlying model cost included in €72
  ('price_id_standard',       ''),       -- Stripe price id, set after Stripe setup
  ('price_id_pro',            ''),
  ('billing_enabled',         '0');      -- 0 = preview: nothing is charged, limits still counted
