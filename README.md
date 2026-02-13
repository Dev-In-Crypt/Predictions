# Polymarket Analyzer MVP

Minimal Node.js/TypeScript analyzer plus Chrome extension bridge for Polymarket event pages.

## Setup
1. `npm install`
2. Create `.env` from `.env.example`.

## Run
1. Start service: `npm run service`
2. Load extension unpacked from `extension/` in Chrome.

## Smoke
Terminal A:
```bash
npm run service
```
Terminal B:
```bash
npm run smoke:health && npm run smoke:service && npm run smoke:history
```

## API contracts
### `/health`
```json
{
  "ok": true,
  "status": "ok",
  "service_version": "8.0.0",
  "time_utc": "2026-02-13T12:00:00.000Z",
  "uptime_sec": 42
}
```

### `/analyze`
Returns structured analysis JSON with required fields including `schema_version`, `timestamp_utc`, `resolved_via`, `cache`, and `quick_view`.

### `/history`
Returns HTML history view. Supports empty and populated history payloads.

## Release notes
### v8.0.0 (Stage 8.0 hardening)
- Version bumped to `8.0.0` in `extension/manifest.json` and reflected in popup UI (`Extension version`).
- Service health version bumped to `8.0.0` and surfaced in popup UI (`Service version`).
- Added deterministic packaging command: `npm run package:zip`.
- Popup summary/history spacing and typography tightened for production feel.
- Report and history pages polished for card/table readability and narrow-width layout.
- Intentional empty states added for:
  - no popup history yet
  - no key facts/sources in report
  - no/filtered history rows in history page

### Verify this release
1. In popup header, confirm `Extension version: 8.0.0`.
2. Click `Test health`; confirm `Service version: 8.0.0`.
3. Open `/health` and verify `service_version` is `8.0.0`.

## Stage 7 final manual checklist
Use at least 22 unique market pages to validate history bound behavior.

1. History bound (`N=20`)
- Run analysis on 22 unique slugs.
- In extension debug (`Copy debug`) and `chrome.storage.local.analysis_history`, confirm length is exactly `20`.
- Re-run one existing slug and verify it moves to the top (upsert behavior).

2. View all history
- Click `View all` in popup.
- Confirm `/history#history=...` opens and rows match popup data.
- Validate slug, timestamp, yes/no, confidence, request id, cache expiry, service URL, evidence mode.
- Confirm slug/confidence/time filters reduce rows as expected.

3. Export buttons (report page)
- Open `Full report`.
- Click `Copy JSON` and validate clipboard is valid JSON.
- Click `Copy short summary` and confirm compact text with slug, yes/no, confidence, context.
- Click `Download JSON` and confirm file downloads and contains same payload.

4. Clear data behavior
- Click `Clear data` in popup.
- Confirm `last_analysis`, `last_slug`, `last_updated`, and `analysis_history` are removed.
- Confirm `service_url` remains persisted.
- Reopen popup and verify empty-state rendering is intentional.

5. Offline behavior
- Stop local service.
- Click `Test health` and verify popup shows service offline state + hint.
- Attempt analysis and confirm graceful error state (no crash, actionable status).
- Restart service and verify state recovers without reload loops.

## Stage 8.1 packaging decision
Shipping path selected:
- `Local unpacked` for day-to-day development.
- `Zip artifact` for sharing builds now.
- `Chrome Web Store` deferred until a later release.

### Repeatable zip artifact
```bash
npm run package:zip
```
Output:
- `artifacts/polymarket-analyzer-v8.0.0.zip`

This command always reads the version from `extension/manifest.json` and recreates the zip at the same output path.

## Stage 8.3 optional later features
- Return to Stage 6 external search (API key + provider).
- Evidence mode and stronger source-linking logic.
- More robust market parsing (rules and resolution details).

## Environment variables
- `AI_API_KEY` (required)
- `AI_PROVIDER` (`openai` or `openrouter`, default: `openai`)
- `AI_BASE_URL` (optional)
- `AI_MODEL` (optional)
- `AI_RESPONSE_FORMAT` (`json_object` or `none`)
- `AI_PROMPT_PATH` (optional, default `./prompts/base.txt`)
- `POLYMARKET_GAMMA_API_ENDPOINT` (optional, default `https://gamma-api.polymarket.com`)

## Regression utilities
Build and run the analyzer as needed:
- `npm run build`
- `npm run dev -- --event <event-slug>`
- `npm run dev -- --slug <market-slug>`
- `npm run dev -- --id <market-id>`

