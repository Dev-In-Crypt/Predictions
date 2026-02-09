import "dotenv/config";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fetchMarketData } from "./marketFetcher.js";
import { requestPrediction } from "./aiClient.js";
import { DEFAULT_PROMPT } from "./prompt.js";
import { formatPercent, readEnv, safeJsonParse } from "./utils.js";

function getArg(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  if (idx === -1) return undefined;
  return process.argv[idx + 1];
}

function formatOutcomeSummary(outcomes: string[], prices: number[]): string[] {
  if (outcomes.length === 0) return [];
  return outcomes.map((outcome, i) => {
    const price = prices[i];
    if (price == null) return outcome;
    return `${outcome} (${formatPercent(price)})`;
  });
}

async function loadPromptTemplate(): Promise<string> {
  const promptPath = process.env.AI_PROMPT_PATH;
  const effectivePath = promptPath ?? "./prompts/base.txt";
  const absolute = resolve(effectivePath);
  try {
    return await readFile(absolute, "utf-8");
  } catch {
    return DEFAULT_PROMPT;
  }
}

function buildPrompt(template: string, params: Record<string, string>): string {
  let output = template;
  for (const [key, value] of Object.entries(params)) {
    output = output.replaceAll(`{${key}}`, value);
  }
  return output;
}

async function run(): Promise<void> {
  const slug = getArg("--slug");
  const id = getArg("--id");
  const eventSlug = getArg("--event");
  const marketIndexRaw = getArg("--market-index");
  const marketIndex = marketIndexRaw ? Number.parseInt(marketIndexRaw, 10) : undefined;
  if (!slug && !id && !eventSlug) {
    throw new Error(
      "Usage: node dist/main.js --slug <market-slug> OR --id <market-id> OR --event <event-slug> [--market-index N]",
    );
  }

  const apiKey = readEnv("AI_API_KEY", true) as string;
  const gammaEndpoint = process.env.POLYMARKET_GAMMA_API_ENDPOINT ?? undefined;
  const model = process.env.AI_MODEL ?? undefined;
  const aiProvider = (process.env.AI_PROVIDER ?? "openai") as "openai" | "openrouter";
  const aiBaseUrl = process.env.AI_BASE_URL ?? undefined;
  const aiResponseFormat = (process.env.AI_RESPONSE_FORMAT ?? undefined) as
    | "json_object"
    | "none"
    | undefined;

  const market = await fetchMarketData({
    slug: slug ?? undefined,
    id: id ?? undefined,
    eventSlug: eventSlug ?? undefined,
    marketIndex,
    gammaBaseUrl: gammaEndpoint,
  });

  const outcomeSummary = formatOutcomeSummary(market.outcomes, market.outcomePrices);
  const promptTemplate = await loadPromptTemplate();
  const prompt = buildPrompt(promptTemplate, {
    title: market.question ?? market.slug ?? market.id,
    description: market.description ?? "unknown",
    resolutionCriteria: market.resolutionCriteria ?? "unknown",
    endDate: market.endDate ?? "unknown",
    outcomesWithPrices: outcomeSummary.length > 0 ? outcomeSummary.join(", ") : "unknown",
    marketContext: "none provided",
    N: "0",
    sourceTitle: "",
    sourceSnippet: "",
    sourceUrl: "",
    sourcePublishedDate: "",
    sourceDomain: "",
    sourceTier: "",
  });

  const prediction = await requestPrediction({
    apiKey,
    model,
    provider: aiProvider,
    baseUrl: aiBaseUrl,
    prompt,
    responseFormat: aiResponseFormat,
    maxRetries: 1,
  });

  console.log(`Market: ${market.question ?? market.slug ?? market.id}`);
  if (market.description) console.log(`Description: ${market.description}`);
  if (outcomeSummary.length > 0) console.log(`Outcomes: ${outcomeSummary.join(", ")}`);

  const structured = safeJsonParse<Record<string, unknown>>(prediction.rawText);
  if (structured && typeof structured === "object" && "quick_view" in structured) {
    console.log("AI Report:");
    console.log(JSON.stringify(structured, null, 2));
  } else {
    console.log(`Prediction (${prediction.model}): ${formatPercent(prediction.probability)}`);
    console.log(`Explanation: ${prediction.explanation}`);
  }
}

run().catch((err) => {
  console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
