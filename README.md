# Polymarket Analyzer MVP

Minimal Node.js/TypeScript script that fetches Polymarket market data, sends it to an LLM, and prints a structured JSON report.

## Setup
1. `npm install`
2. Create `.env` using `.env.example` as a template.

## Smoke
Terminal A:
```
npm run service
```
Terminal B:
```
npm run smoke:health && npm run smoke:service && npm run smoke:history
```

## Run
### By event slug
```
npm run dev -- --event <event-slug>
```

### By market slug
```
npm run dev -- --slug <market-slug>
```

### By market id
```
npm run dev -- --id <market-id>
```

## Local service (MV3 bridge)
Run the local HTTP service:
```
npm run service
```
It listens on `http://127.0.0.1:8787/analyze?slug=<event-slug-or-path>`.

### /health contract (stable)
`GET /health` returns a small JSON payload and must not call the analyzer:
```json
{
  "ok": true,
  "status": "ok",
  "service_version": "1.0.0",
  "time_utc": "2026-02-12T17:42:31.123Z",
  "uptime_sec": 42
}
```
- `time_utc` is ISO-8601 UTC (ending in `Z`).
- `uptime_sec` is integer seconds since process start.

Extension skeleton lives in `extension/` (load unpacked in Chrome).

## Quick validations
### Smoke: service JSON contract
1. Start the service:
```
npm run service
```
2. In another shell:
```
npm run smoke:service
```
The smoke check calls the local service for the first `type=event` gold slug and asserts:
`schema_version`, `timestamp_utc`, `resolved_via`, `cache.hit`, and required `quick_view` fields.

### Smoke: health JSON contract
1. Start the service:
```
npm run service
```
2. In another shell:
```
npm run smoke:health
```
The health check asserts `ok`, `status`, `service_version`, `time_utc` (ISO UTC), and `uptime_sec`.

### Smoke: history HTML contract
1. Start the service:
```
npm run service
```
2. In another shell:
```
npm run smoke:history
```
The history smoke asserts `GET /history` returns HTML with status 200 for both:
- an empty history payload
- a populated history payload

### Deterministic local workflow
Terminal A:
```
npm run service
```
Terminal B:
```
npm run smoke:health && npm run smoke:service && npm run smoke:history
```

## Stage 7 behavior
- Extension stores a compact bounded history (`N=20`) in `chrome.storage.local` under `analysis_history`.
- History is upserted by slug (re-analysis updates existing row and moves it to newest position).
- Popup shows last 3 entries and opens:
  - full report for one entry (`/report?slug=...`)
  - full history page (`/history#history=...`)
- `/history` supports filters by slug search, confidence, and time range.
- `/report` supports export actions:
  - Copy JSON
  - Copy short summary
  - Download JSON
- `Clear data` removes analysis and history data, but keeps `service_url`.

## Troubleshooting
- **Service offline**: Ensure npm run service is running. Check the popup for Service: offline and the OFF badge.
- **Wrong URL**: Open "Service settings" in the popup and confirm the Service URL is correct and reachable.
- **Smokes failing**: Start the service in Terminal A and rerun the smoke commands in Terminal B.
- **EADDRINUSE (port already in use)**: Stop the process using that port, or run the service on a different port (set ANALYZER_PORT) and update the extension Service URL to match.
- **npm run dev fails with EPERM**: This is environment-dependent in some setups. Use npm run build plus npm run service as the local workflow.

### Manual: extension flow checklist (content → background → service → chrome.storage)
Use these 5 gold slugs (one includes `/`):
- `macron-out-in-2025`
- `will-trump-deport-750000-or-more-people-in-2025`
- `what-will-happen-before-gta-vi`
- `gta-vi-released-before-june-2026`
- `what-will-happen-before-gta-vi/gta-vi-released-before-june-2026` (event/market path)

Checklist per slug:
1. Open `https://polymarket.com/event/<slug>` (for the `/` slug, paste it directly after `/event/`).
2. Click the extension action (pin it for easy access).
3. Confirm a small notification or badge appears.
4. In DevTools → Application → Storage → `chrome.storage`, verify `last_slug` matches the page,
   `last_updated` is recent, and `last_analysis.schema_version`, `timestamp_utc`, `resolved_via`,
   `cache.hit`, `cache.expires_at_utc`, plus `last_analysis.quick_view.estimate_yes_pct`,
   `range_yes_pct`, `confidence`, `market_yes_pct`, `delta_vs_market_pp`, `top_drivers`,
   `one_sentence_take` are present.

## Environment Variables
- `AI_API_KEY` (required)
- `AI_PROVIDER` (`openai` or `openrouter`, default: `openai`)
- `AI_BASE_URL` (optional, e.g. `https://openrouter.ai`)
- `AI_MODEL` (optional)
- `AI_RESPONSE_FORMAT` (`json_object` or `none`)
- `AI_PROMPT_PATH` (optional, default: `./prompts/base.txt`)
- `POLYMARKET_GAMMA_API_ENDPOINT` (optional, default: `https://gamma-api.polymarket.com`)

## Notes
- Outputs JSON when the model responds with a structured report.
- If JSON is invalid or violates schema, it retries once with a stricter instruction.
- Local/generated artifacts are intentionally git-ignored (for example: `.cache/`, `runs/`, `dist/`, logs, `*.crx`, `*.pem`, and local env files).

## Gold Slugs & Regression
### Build gold slugs
Generates a 50-slug dataset sourced from active Gamma events and validates each slug.
```
npm run build
node scripts/build_gold_slugs.mjs
```
Outputs:
- `data/gold_slugs.txt` (one slug per line)
- `data/gold_slugs.json` (slug metadata: `slug`, `type`, `resolved_via`, `timestamp`)

### Run regression on gold list
1) Run all gold slugs (event vs market based on metadata) and capture outputs:
```
powershell -Command "$gold = Get-Content data\\gold_slugs.json | ConvertFrom-Json; $out = @(); foreach ($item in $gold) { $slug = $item.slug; $type = $item.type; $before = Get-ChildItem runs -Directory | Select-Object -ExpandProperty Name; $start = Get-Date; if ($type -eq 'market') { $stdout = node dist\\main.js --slug $slug } else { $stdout = node dist\\main.js --event $slug } $elapsed = (Get-Date) - $start; $after = Get-ChildItem runs -Directory | Select-Object -ExpandProperty Name; $newDirs = $after | Where-Object { $before -notcontains $_ }; $runDir = if ($newDirs -and $newDirs.Count -gt 0) { ($newDirs | Sort-Object | Select-Object -Last 1) } else { $null }; $out += [pscustomobject]@{ slug=$slug; type=$type; runtime_seconds=[Math]::Round($elapsed.TotalSeconds,2); stdout=$stdout; run_dir=$runDir } }; $out | ConvertTo-Json -Depth 6 | Set-Content run_outputs_gold.json"
```
2) Convert outputs into metrics:
```
node scripts/regenerate_metrics.mjs --outputs run_outputs_gold.json --gold data\\gold_slugs.json --summary metrics_summary_gold.json --partial metrics_partial_gold.json
```

### Metrics outputs
- `metrics_summary_gold.json` (overall + per-slug metrics)
- `metrics_partial_gold.json` (per-slug metrics only)

