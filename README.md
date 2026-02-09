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
