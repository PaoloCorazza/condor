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
