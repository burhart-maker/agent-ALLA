# Agent ALLA development and deployment

## Current production

The public website agentalla.com is served by Cloudflare Pages project `agentalla`, not by the Render custom domain. Cloudflare DNS points to agentalla.pages.dev. The Pages project is not connected to GitHub and its deployments are newer than the source on main.

Render service `alla-backend` runs this repository's backend from main. Its root directory is backend and automatic deployment is enabled. Do not change DNS to Render to resolve its pending custom domain verification.

## Release gate

Do not publish this repository's public-site directory to the production Pages project until the current deployed application's complete source is reconciled. HTML and other public assets alone do not recover Pages Functions. A downloaded Wrangler configuration is not a source backup.

Required before enabling automatic production deployments:

1. Obtain the latest source used for Pages deployments, including Functions, build inputs and dependencies.
2. Reconcile it with this repository and document the actual chat API destination.
3. Pin the build dependencies and configuration; keep credentials out of Git.
4. Build a separate preview with isolated test settings, checking chat, mobile layout, assets and installation behavior.
5. Record the previous production deployment and publish the verified build.
6. Verify the live site and retain a rollback path. Database changes, if any, require a separate recovery plan.

## Working access on the owner's Mac

GitHub CLI uses the macOS credential store; Git is configured to use its credential helper. Cloudflare Wrangler uses encrypted credentials with a key in macOS Keychain. No browser tab needs to stay open. OAuth can be revoked and may require reauthorization.

The local operations launchers are in the parent workspace's `operations/bin` directory:

- `github`: GitHub CLI (repository reads/writes and pull requests).
- `cloudflare`: Wrangler (Pages management).
- `check-access`: read-only verification of GitHub repo write permissions and Pages project access, without printing credentials.

Cloudflare access is intentionally limited to account/user reads and Pages writes. Do not add unrelated account permissions to silence generic Wrangler warnings.

## Development routine

Work on a branch, review the diff, run relevant checks, and prepare a preview before releasing. Production changes should come from a known commit and a reproducible build. Until the release gate above is satisfied, main and production remain unchanged.
