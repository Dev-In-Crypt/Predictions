import "dotenv/config";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fetchMarketData } from "./marketFetcher.js";
import { requestPrediction } from "./aiClient.js";
import { DEFAULT_PROMPT } from "./prompt.js";
import { formatPercent, readEnv, safeJsonParse } from "./utils.js";
import { generateQueries, searchBrave, SearchResult } from "./searchClient.js";

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

type ErrorStep = "market_fetch" | "search" | "llm" | "parse" | "validate" | "cache" | "overall";

interface ErrorEnvelope {
  status: "error";
  step: ErrorStep;
  error_code: string;
  message: string;
  retryable: boolean;
}

function outputError(err: ErrorEnvelope & { attempts?: number; sources_count?: number }): void {
  process.stdout.write(`${JSON.stringify(err)}\n`);
}

function outputJson(obj: unknown): void {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

function shouldDebug(): boolean {
  return process.env.DEBUG_TRACE === "1";
}

function debugLog(message: string): void {
  if (shouldDebug()) {
    process.stderr.write(`${message}\n`);
  }
}

async function rateLimitCheck(
  minIntervalMs: number,
  key: string,
): Promise<ErrorEnvelope | null> {
  if (minIntervalMs <= 0) return null;
  const now = Date.now();
  const cacheDir = resolve(".cache");
  const rateFile = resolve(".cache", `ratelimit_${key}.json`);
  try {
    const raw = await readFile(rateFile, "utf-8");
    const parsed = safeJsonParse<{ lastRunAt?: number }>(raw);
    const last = typeof parsed?.lastRunAt === "number" ? parsed.lastRunAt : 0;
    if (now - last < minIntervalMs) {
      return {
        status: "error",
        step: "overall",
        error_code: "RATE_LIMIT",
        message: "Too many requests; please wait before retrying.",
        retryable: true,
      };
    }
  } catch {
    // ignore missing/invalid file
  }
  try {
    await mkdir(cacheDir, { recursive: true });
    await writeFile(rateFile, JSON.stringify({ lastRunAt: now }));
  } catch {
    // ignore write failures
  }
  return null;
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

function summarizeSources(sources: SearchResult[]): string {
  if (sources.length === 0) return "count=0 tiers={} newest=unknown";
  const tiers: Record<string, number> = {};
  let newest: string | undefined;
  for (const s of sources) {
    tiers[s.tier] = (tiers[s.tier] ?? 0) + 1;
    if (s.publishedDate) {
      if (!newest || Date.parse(s.publishedDate) > Date.parse(newest)) newest = s.publishedDate;
    }
  }
  return `count=${sources.length} tiers=${JSON.stringify(tiers)} newest=${newest ?? "unknown"}`;
}

function evidenceQuality(sources: SearchResult[]): {
  sourceCount: number;
  bestTier: string;
  recencySummary: string;
  conflictsDetected: string[];
} {
  if (sources.length === 0) {
    return { sourceCount: 0, bestTier: "unknown", recencySummary: "unknown", conflictsDetected: [] };
  }
  const tiers = sources.map((s) => s.tier);
  const bestTier = tiers.includes("tier1")
    ? "tier1"
    : tiers.includes("tier2")
      ? "tier2"
      : tiers.includes("tier3")
        ? "tier3"
        : "unknown";
  const recencySummary = sources.some((s) => s.publishedDate) ? "mixed" : "unknown";
  return { sourceCount: sources.length, bestTier, recencySummary, conflictsDetected: [] };
}

async function writeRunArtifacts(runId: string, artifacts: Record<string, unknown>): Promise<void> {
  const dir = resolve("runs", runId);
  await mkdir(dir, { recursive: true });
  for (const [name, payload] of Object.entries(artifacts)) {
    await writeFile(resolve(dir, `${name}.json`), JSON.stringify(payload, null, 2));
  }
}

function sanitizeUnsupportedStrings(obj: unknown): unknown {
  const banned = [
    "current date",
    "post-election",
    "post election",
    "already happened",
    "as of today",
    "today",
    "yesterday",
  ];
  if (obj == null) return obj;
  if (typeof obj === "string") {
    const lower = obj.toLowerCase();
    if (banned.some((b) => lower.includes(b))) return "unknown / needs confirmation";
    return obj;
  }
  if (Array.isArray(obj)) return obj.map((v) => sanitizeUnsupportedStrings(v));
  if (typeof obj === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      out[k] = sanitizeUnsupportedStrings(v);
    }
    return out;
  }
  return obj;
}

async function withRetries<T>(
  fn: (attempt: number) => Promise<T>,
  retries: number,
  backoffMs: number,
): Promise<{ value?: T; attempts: number; error?: Error }> {
  let attempt = 0;
  while (attempt <= retries) {
    try {
      const value = await fn(attempt);
      return { value, attempts: attempt + 1 };
    } catch (err) {
      if (attempt >= retries) {
        return { attempts: attempt + 1, error: err as Error };
      }
      const delay = backoffMs * Math.pow(2, attempt);
      await new Promise((r) => setTimeout(r, delay));
    }
    attempt += 1;
  }
  return { attempts: retries + 1, error: new Error("unknown") };
}

async function run(): Promise<void> {
  const slug = getArg("--slug");
  const id = getArg("--id");
  const eventSlug = getArg("--event");
  const marketIndexRaw = getArg("--market-index");
  const marketIndex = marketIndexRaw ? Number.parseInt(marketIndexRaw, 10) : undefined;
  if (!slug && !id && !eventSlug) {
    outputError({
      status: "error",
      step: "overall",
      error_code: "BAD_RESPONSE",
      message:
        "Usage: node dist/main.js --slug <market-slug> OR --id <market-id> OR --event <event-slug> [--market-index N]",
      retryable: false,
    });
    return;
  }

  let apiKey: string;
  try {
    apiKey = readEnv("AI_API_KEY", true) as string;
  } catch (err) {
    outputError({
      status: "error",
      step: "overall",
      error_code: "BAD_RESPONSE",
      message: err instanceof Error ? err.message : "Missing AI_API_KEY",
      retryable: false,
    });
    return;
  }

  const gammaEndpoint = process.env.POLYMARKET_GAMMA_API_ENDPOINT ?? undefined;
  const model = process.env.AI_MODEL ?? undefined;
  const aiProvider = (process.env.AI_PROVIDER ?? "openai") as "openai" | "openrouter";
  const aiBaseUrl = process.env.AI_BASE_URL ?? undefined;
  const aiResponseFormat = (process.env.AI_RESPONSE_FORMAT ?? undefined) as
    | "json_object"
    | "none"
    | undefined;

  const overallTimeoutMs = Number.parseInt(process.env.OVERALL_TIMEOUT_MS ?? "45000", 10);
  const llmTimeoutMs = Number.parseInt(process.env.LLM_TIMEOUT_MS ?? "30000", 10);
  const marketTimeoutMs = Number.parseInt(process.env.MARKET_TIMEOUT_MS ?? "15000", 10);
  const searchTimeoutMs = Number.parseInt(process.env.SEARCH_TIMEOUT_MS ?? "15000", 10);
  const minIntervalMs = Number.parseInt(process.env.RATE_LIMIT_MS ?? "0", 10);

  const rateLimitError = await rateLimitCheck(minIntervalMs, "overall");
  if (rateLimitError) {
    outputError(rateLimitError);
    return;
  }

  const runWithTimeout = async <T>(promise: Promise<T>, timeoutMs: number): Promise<T> => {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise;
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) =>
        setTimeout(() => reject(new Error("OVERALL_TIMEOUT")), timeoutMs),
      ),
    ]);
  };

  try {
    await runWithTimeout(
      (async () => {
        const marketController = new AbortController();
        const marketTimer = setTimeout(() => marketController.abort(), marketTimeoutMs);
        let market;
        try {
          const gammaRate = await rateLimitCheck(
            Number.parseInt(process.env.GAMMA_RATE_LIMIT_MS ?? "0", 10),
            "gamma",
          );
          if (gammaRate) {
            outputError(gammaRate);
            return;
          }
          const retries = Number.parseInt(process.env.GAMMA_RETRIES ?? "2", 10);
          const backoff = Number.parseInt(process.env.GAMMA_BACKOFF_MS ?? "500", 10);
          const res = await withRetries(
            () =>
              fetchMarketData({
                slug: slug ?? undefined,
                id: id ?? undefined,
                eventSlug: eventSlug ?? undefined,
                marketIndex,
                gammaBaseUrl: gammaEndpoint,
                signal: marketController.signal,
              }),
            retries,
            backoff,
          );
          if (res.error) {
            (res.error as { attempts?: number }).attempts = res.attempts;
            throw res.error;
          }
          market = res.value;
          debugLog("market fetch: ok");
        } catch (err) {
          debugLog("market fetch: fail");
          const isTimeout = err instanceof Error && err.name === "AbortError";
          outputError({
            status: "error",
            step: "market_fetch",
            error_code: isTimeout ? "TIMEOUT" : "NETWORK_ERROR",
            message: isTimeout ? "Market fetch timed out." : "Market fetch failed.",
            retryable: true,
            attempts:
              typeof (err as { attempts?: number }).attempts === "number"
                ? ((err as { attempts?: number }).attempts as number)
                : Number.parseInt(process.env.GAMMA_RETRIES ?? "2", 10) + 1,
            sources_count: 0,
          });
          return;
        } finally {
          clearTimeout(marketTimer);
        }

        if (!market) {
          outputError({
            status: "error",
            step: "market_fetch",
            error_code: "BAD_RESPONSE",
            message: "Market data unavailable.",
            retryable: true,
          });
          return;
        }

        const outcomeSummary = formatOutcomeSummary(market.outcomes, market.outcomePrices);
        const promptTemplate = await loadPromptTemplate();

        let sources: SearchResult[] = [];
        const searchApiKey = process.env.SEARCH_API_KEY;
        if (searchApiKey) {
          try {
            const searchRate = await rateLimitCheck(
              Number.parseInt(process.env.SEARCH_RATE_LIMIT_MS ?? "0", 10),
              "search",
            );
            if (searchRate) {
              outputError({ ...searchRate, attempts: 1, sources_count: 0 });
              return;
            }
            const queries = generateQueries({
              title: market.question ?? market.slug ?? market.id,
              description: market.description,
              resolutionCriteria: market.resolutionCriteria,
            });
            const retries = Number.parseInt(process.env.SEARCH_RETRIES ?? "2", 10);
            const backoff = Number.parseInt(process.env.SEARCH_BACKOFF_MS ?? "500", 10);
            const res = await withRetries(
              () => searchBrave(searchApiKey, queries, { timeoutMs: searchTimeoutMs }),
              retries,
              backoff,
            );
            if (!res.error && res.value) {
              sources = res.value.results;
            } else {
              debugLog("search: fail (graceful, using no sources)");
              sources = [];
            }
          } catch (err) {
            debugLog("search: fail (graceful, using no sources)");
            sources = [];
          }
        }

        debugLog(`sources: ${summarizeSources(sources)}`);
        debugLog("cache: miss");

        const evidence = evidenceQuality(sources);
        const sourcesBlock =
          sources.length === 0
            ? "No sources provided."
            : sources
                .map(
                  (s) =>
                    `title: ${s.title}\n` +
                    `snippet: ${s.snippet}\n` +
                    `url: ${s.url}\n` +
                    `published_date: ${s.publishedDate ?? "unknown"}\n` +
                    `domain: ${s.domain}\n` +
                    `tier: ${s.tier}`,
                )
                .join("\n\n");

        const prompt = buildPrompt(promptTemplate, {
          title: market.question ?? market.slug ?? market.id,
          description: market.description ?? "unknown",
          resolutionCriteria: market.resolutionCriteria ?? "unknown",
          endDate: market.endDate ?? "unknown",
          outcomesWithPrices: outcomeSummary.length > 0 ? outcomeSummary.join(", ") : "unknown",
          marketContext: "none provided",
          N: String(sources.length),
          sourceTitle: "",
          sourceSnippet: "",
          sourceUrl: "",
          sourcePublishedDate: "",
          sourceDomain: "",
          sourceTier: "",
        });

        const fullPrompt = `${prompt}\n\nSources (${sources.length})\n${sourcesBlock}`;

        let prediction;
        try {
          prediction = await requestPrediction({
            apiKey,
            model,
            provider: aiProvider,
            baseUrl: aiBaseUrl,
            prompt: fullPrompt,
            responseFormat: aiResponseFormat,
            maxRetries: 2,
            timeoutMs: llmTimeoutMs,
          });
          debugLog("llm call: ok");
          debugLog(`sanitize used: ${prediction.sanitizeUsed ? "yes" : "no"}`);
          debugLog(`retry used: ${prediction.retryUsed ? "yes" : "no"}`);
        } catch (err) {
          debugLog("llm call: fail");
          const message = err instanceof Error ? err.message : "LLM failure.";
          const isTimeout = err instanceof Error && err.name === "AbortError";
          const isValidation = typeof message === "string" && message.includes("validation");
          const isInvalidJson = typeof message === "string" && message.includes("invalid JSON");
          const sanitizeUsed =
            typeof (err as { sanitizeUsed?: boolean }).sanitizeUsed === "boolean"
              ? ((err as { sanitizeUsed?: boolean }).sanitizeUsed as boolean)
              : undefined;
          const retryUsed =
            typeof (err as { retryUsed?: boolean }).retryUsed === "boolean"
              ? ((err as { retryUsed?: boolean }).retryUsed as boolean)
              : undefined;
          debugLog(`sanitize used: ${sanitizeUsed === undefined ? "unknown" : sanitizeUsed ? "yes" : "no"}`);
          debugLog(`retry used: ${retryUsed === undefined ? "unknown" : retryUsed ? "yes" : "no"}`);
          outputError({
            status: "error",
            step: isInvalidJson ? "parse" : isValidation ? "validate" : "llm",
            error_code: isTimeout ? "TIMEOUT" : isInvalidJson ? "INVALID_JSON" : "BAD_RESPONSE",
            message,
            retryable: true,
            attempts: Number.parseInt(process.env.LLM_RETRIES ?? "2", 10) + 1,
            sources_count: sources.length,
          });
          return;
        }

        let structured = safeJsonParse<Record<string, unknown>>(prediction.rawText);
        if (structured && typeof structured === "object") {
          structured = sanitizeUnsupportedStrings(structured) as Record<string, unknown>;
          outputJson(structured);
        } else {
          outputError({
            status: "error",
            step: "parse",
            error_code: "INVALID_JSON",
            message: "LLM output could not be parsed as JSON.",
            retryable: true,
            attempts: 1,
            sources_count: sources.length,
          });
        }

        const runId = `${Date.now()}_${(market.slug ?? market.id ?? "market").replace(/[^a-zA-Z0-9_-]/g, "_")}`;
        await writeRunArtifacts(runId, {
          evidence_bundle: {
            market_text: {
              title: market.question ?? market.slug ?? market.id,
              description: market.description ?? "unknown",
              resolution_criteria: market.resolutionCriteria ?? "unknown",
              end_date: market.endDate ?? "unknown",
            },
            outcomes_with_prices: outcomeSummary,
            sources,
            evidence_quality: evidence,
          },
          final_report: structured ?? { error: "invalid json" },
          metrics: {
            source_count: evidence.sourceCount,
            best_tier: evidence.bestTier,
            recency_summary: evidence.recencySummary,
            sanitizeUsed: prediction.sanitizeUsed,
            retryUsed: prediction.retryUsed,
            hallucination_red_flags: JSON.stringify(structured ?? {}).match(
              /(current date|post-election|post election|already happened|as of today|today|yesterday)/i,
            )
              ? 1
              : 0,
          },
        });
      })(),
      overallTimeoutMs,
    );
  } catch (err) {
    const isTimeout = err instanceof Error && err.message === "OVERALL_TIMEOUT";
    outputError({
      status: "error",
      step: "overall",
      error_code: isTimeout ? "TIMEOUT" : "BAD_RESPONSE",
      message: isTimeout ? "Overall run timed out." : "Unexpected failure.",
      retryable: true,
    });
  }
}

run();
