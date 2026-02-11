# Polymarket Market Analysis MVP

Minimal Node.js/TypeScript script that fetches Polymarket market data, sends it to an LLM, and prints a structured JSON report.

## Setup
1. `npm install`
2. Create `.env` using `.env.example` as a template.

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

Extension skeleton lives in `extension/` (load unpacked in Chrome).

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
