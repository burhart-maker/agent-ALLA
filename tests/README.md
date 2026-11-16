# Entitlement regression checks

Run `node --test tests/gate-chat.test.mjs` with Node 22 or newer.

These tests evaluate the complete worker in an isolated context, use synthetic
users and a strict read-only D1 stand-in, and prohibit network calls. They cover
anonymous and trial boundaries with billing enabled and disabled, active and
trialing subscriptions, autopay opt-in, both plan allowances, and refusal through
the real chat and transcription routes before upstream calls or background work.

To verify the regression against the original code, set `ALLA_TEST_WORKER` to an
absolute path containing the original worker. The original ab994ea fails the
billing-disabled limit checks.

These checks do not replace the lost authentication/browser suite described in
the handover. No real D1, provider, billing, email or production data is used.
Outstanding coverage: real D1 integration, concurrent requests, missing DB,
settings validation, full auth/browser regressions and provider streaming.
