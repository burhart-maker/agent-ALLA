# ALLA AI runtime migration — 2026-11-16

Active chat and standing-note generation now use OpenAI Responses. No active
code reads ANTHROPIC_API_KEY or calls api.anthropic.com. Existing Cloudflare D1,
R2, sign-in, transcription, frontend and application tools are retained.

## Configuration

- OPENAI_API_KEY: existing Cloudflare production secret; never expose or export.
- OPENAI_MODEL: optional model override. Default gpt-6-astra, reasoning low.
- A new override must be checked for Responses, web search, MCP, image/PDF and
  function-call support. Add its verified prices to model_prices before use.
- Default model pricing fallback is $10/M input, $50/M output, verified against
  official docs 2026-11-16. Cached input is conservatively counted at full price.
- Requests set store=false; this does not remove provider abuse-monitoring logs.
- Existing expired Anthropic secret can remain inert during rollback window;
  it is neither read nor used as a fallback by this release.

## Behaviour

The browser-facing SSE envelope remains stable. Responses text/refusal deltas
stream progressively; completion translates model usage and web-search count
for the existing ledger. A failed/interrupted response is not stored as a
completed assistant answer or written into the client's standing note.

Function tool rounds preserve the entire preceding output, encrypted reasoning
and tool results. Round cap is four model calls, up to six hosted tool calls per
round. No retry switches models or repeats application tools after execution.
PDFs and images remain inline; no Files API upload or external conversation
store is introduced. The listing MCP server is offered only for listing queries.
Third-party listing server availability and licensing remain separate concerns.

The previously prepared gateChat fix is included: anonymous/trial/plan limits
apply with billing off; overage requires billing on AND autopay opt-in. Missing
usage DB now fails closed. Charging is not enabled and prices are not changed.
Completed-message accounting is not an atomic concurrent-request reservation;
distributed requests can still exceed per-IP quotas. This is not a global hard
spending ceiling. Background profile generation remains separately unmetered,
as in the preceding release, and needs a follow-up cost-accounting change.

## Verification

Run `node --test tests/*.test.mjs`. Network-free tests cover complete/fragmented
streams, errors, tool continuation/failure/cap, attachments, profile updates,
provider routing, pricing, composer controls and entitlement limits. Build both
as .mjs and esbuild ESM. Test preview without secrets for honest degraded mode;
then verify production with synthetic chat, file, search and tool requests.
Never treat HTTP 200 or a green deployment alone as proof of a working answer.

Rollback record before migration: production 0453ae20-1975-4e31-bbc7-99934a031be2,
commit 9ecad45. That release's Anthropic key has expired, so rolling back code
alone does not restore its AI. Preserve D1/R2; no database migration is needed.

Only factual provider names are updated in privacy/terms/FAQ. Existing broader
legal and product-claim gaps recorded in the handover remain unresolved; this
change does not constitute legal review or certify those documents.

## Sources

- https://developers.openai.com/api/docs/guides/streaming-responses
- https://developers.openai.com/api/docs/guides/function-calling
- https://developers.openai.com/api/docs/guides/file-inputs
- https://developers.openai.com/api/docs/guides/tools-connectors-mcp
- https://developers.openai.com/api/docs/models/gpt-6-astra
- https://developers.openai.com/api/docs/guides/your-data
