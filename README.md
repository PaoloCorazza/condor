# Agrimarket Playwright worker

Background worker that reads its 22 OLX search targets and runtime settings from Supabase, scans up to five pages per query with Playwright/Chromium, upserts listings, records each scrape run, maintains a heartbeat, and marks listings inactive after seven days without being seen.

## Required environment variables

- `SUPABASE_URL`
- `SUPABASE_SECRET_KEY` (recommended) or the legacy `SUPABASE_SERVICE_ROLE_KEY`
- `WORKER_NAME` (optional; defaults to `agrimarket-playwright-v3`)

Do not commit Supabase keys to the repository.

## Local commands

```bash
npm ci
npm run check
npm start
```

The Docker image and the npm Playwright package are intentionally pinned to the same version.

## Free manual execution

The GitHub Actions workflow can be started manually and uses a GitHub-hosted runner. Add `SUPABASE_SECRET_KEY` as an encrypted repository secret before starting it.

Automatic execution is intentionally disabled. A validation run on 27 August 2026 confirmed that OLX presents its Human Verification page (HTTP 405) to GitHub-hosted runners. The worker stops immediately when this happens and skips stale-listing cleanup, so existing Supabase listings are not deactivated after a blocked scrape.

Do not bypass the verification page. Re-enable automation only after moving to an access method permitted by OLX, such as an approved official API.

## Render cost notice

Render does not offer a free compute plan for background workers. The included `render.yaml` intentionally declares no services, so it cannot create the paid worker configuration. Add a paid service only after the recurring cost has been explicitly approved.
