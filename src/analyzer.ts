import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fetchMarketData } from "./marketFetcher.js";
import { requestPrediction } from "./aiClient.js";
import { DEFAULT_PROMPT } from "./prompt.js";
import { formatPercent, readEnv, safeJsonParse } from "./utils.js";
import type { SearchResult } from "./searchClient.js";

const SCHEMA_VERSION = "1.0";
const DEFAULT_CACHE_TTL_SEC = 1800;

export type ErrorStep = "market_fetch" | "search" | "llm" | "parse" | "validate" | "cache" | "overall";

export interface ErrorEnvelope {
  status: "error";
  step: ErrorStep;
  error_code: string;
  message: string;
  retryable: boolean;
  schema_version?: string;
  timestamp_utc?: string;
  resolved_via?: "market_slug" | "event_index" | "event_market_path";
  cache?: CacheMeta;
  attempts?: number;
  sources_count?: number;
}

export interface CacheMeta {
  hit: boolean;
  ttl_sec: number;
  expires_at_utc?: string;
}

export type SuccessPayload = Record<string, unknown> & {
  schema_version?: string;
  timestamp_utc?: string;
  resolved_via?: "market_slug" | "event_index" | "event_market_path";
  cache?: CacheMeta;
};

export type AnalysisResult =
  | { status: "success"; payload: SuccessPayload }
  | { status: "error"; error: ErrorEnvelope };

export interface AnalysisInput {
  slug?: string;
  id?: string;
  eventSlug?: string;
  marketIndex?: number;
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
  shouldRetry?: (err: unknown) => boolean,
): Promise<{ value?: T; attempts: number; error?: Error }> {
  let attempt = 0;
  while (attempt <= retries) {
    try {
      const value = await fn(attempt);
      return { value, attempts: attempt + 1 };
    } catch (err) {
      const retryable = shouldRetry ? shouldRetry(err) : true;
      if (!retryable || attempt >= retries) {
        return { attempts: attempt + 1, error: err as Error };
      }
      const delay = backoffMs * Math.pow(2, attempt);
      await new Promise((r) => setTimeout(r, delay));
    }
    attempt += 1;
  }
  return { attempts: retries + 1, error: new Error("unknown") };
}

function normalizeSlugKey(input: string): string {
  const trimmed = input.trim().toLowerCase();
  const normalized = trimmed.replace(/^\/+|\/+$/g, "").replace(/\/{2,}/g, "/");
  return normalized.length > 0 ? normalized : "unknown";
}

function buildCacheKey(input: AnalysisInput): string {
  const baseRaw = input.slug ?? input.eventSlug ?? (input.id ? `id:${input.id}` : "");
  const base = normalizeSlugKey(baseRaw || "unknown");
  const parts = [base];
  if (typeof input.marketIndex === "number" && Number.isFinite(input.marketIndex)) {
    parts.push(`market_index=${input.marketIndex}`);
  }
  return parts.join("|");
}

function cacheFileForKey(key: string): string {
  const safe = key.replace(/[^a-z0-9_-]/gi, "_");
  return resolve(".cache", `analysis_${safe}.json`);
}

function parseTimestampUtc(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function computeExpiresAtUtc(baseMs: number, ttlSec: number): string {
  const ttlMs = Math.max(0, ttlSec) * 1000;
  return new Date(baseMs + ttlMs).toISOString();
}

async function readCache(key: string): Promise<{ payload: SuccessPayload; ttlRemaining: number } | null> {
  try {
    const raw = await readFile(cacheFileForKey(key), "utf-8");
    const parsed = safeJsonParse<SuccessPayload>(raw);
    if (!parsed || typeof parsed !== "object") return null;
    const timestampMs = parseTimestampUtc(parsed.timestamp_utc);
    if (!timestampMs) return null;
    const ageSec = (Date.now() - timestampMs) / 1000;
    if (ageSec >= DEFAULT_CACHE_TTL_SEC) return null;
    return { payload: parsed, ttlRemaining: Math.max(0, Math.floor(DEFAULT_CACHE_TTL_SEC - ageSec)) };
  } catch {
    return null;
  }
}

async function writeCache(key: string, payload: SuccessPayload): Promise<void> {
  await mkdir(resolve(".cache"), { recursive: true });
  await writeFile(cacheFileForKey(key), JSON.stringify(payload));
}

function resolveVia(input: AnalysisInput): "market_slug" | "event_index" | "event_market_path" {
  const slug = input.slug ?? input.eventSlug ?? "";
  if (slug.includes("/")) return "event_market_path";
  if (input.eventSlug || typeof input.marketIndex === "number") return "event_index";
  return "market_slug";
}

function withEnvelopeMeta<T extends ErrorEnvelope | SuccessPayload>(
  payload: T,
  resolvedVia: "market_slug" | "event_index" | "event_market_path",
  cache: CacheMeta,
): T {
  payload.schema_version = SCHEMA_VERSION;
  if (!payload.timestamp_utc) {
    payload.timestamp_utc = new Date().toISOString();
  }
  payload.resolved_via = resolvedVia;
  const timestampMs = Date.parse(payload.timestamp_utc);
  payload.cache = {
    ...cache,
    expires_at_utc: computeExpiresAtUtc(Number.isFinite(timestampMs) ? timestampMs : Date.now(), cache.ttl_sec),
  };
  return payload;
}

export async function analyzeMarket(input: AnalysisInput): Promise<AnalysisResult> {
  const resolvedVia = resolveVia(input);
  const cacheKey = buildCacheKey(input);
  const cached = await readCache(cacheKey);
  if (cached) {
    debugLog("cache: hit");
    cached.payload.resolved_via = resolvedVia;
    cached.payload.schema_version = SCHEMA_VERSION;
    cached.payload.cache = {
      hit: true,
      ttl_sec: cached.ttlRemaining,
      expires_at_utc: computeExpiresAtUtc(Date.now(), cached.ttlRemaining),
    };
    return { status: "success", payload: cached.payload };
  }

  debugLog("cache: miss");

  if (!input.slug && !input.id && !input.eventSlug) {
    return {
      status: "error",
      error: withEnvelopeMeta(
        {
          status: "error",
          step: "overall",
          error_code: "BAD_RESPONSE",
          message:
            "Usage: node dist/main.js --slug <market-slug> OR --id <market-id> OR --event <event-slug> [--market-index N]",
          retryable: false,
        },
        resolvedVia,
        { hit: false, ttl_sec: 0 },
      ),
    };
  }

  let apiKey: string;
  try {
    apiKey = readEnv("AI_API_KEY", true) as string;
  } catch (err) {
    return {
      status: "error",
      error: withEnvelopeMeta(
        {
          status: "error",
          step: "overall",
          error_code: "BAD_RESPONSE",
          message: err instanceof Error ? err.message : "Missing AI_API_KEY",
          retryable: false,
        },
        resolvedVia,
        { hit: false, ttl_sec: 0 },
      ),
    };
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
  const minIntervalMs = Number.parseInt(process.env.RATE_LIMIT_MS ?? "0", 10);
  const gammaDelayMs = Number.parseInt(process.env.GAMMA_REQUEST_DELAY_MS ?? "120", 10);

  const rateLimitError = await rateLimitCheck(minIntervalMs, "overall");
  if (rateLimitError) {
    return {
      status: "error",
      error: withEnvelopeMeta(rateLimitError, resolvedVia, { hit: false, ttl_sec: 0 }),
    };
  }

  const runWithTimeout = async <T>(promise: Promise<T>, timeoutMs: number): Promise<T> => {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<T>((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error("OVERALL_TIMEOUT")), timeoutMs);
    });
    try {
      return await Promise.race([promise, timeoutPromise]);
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }
  };

  const isRetryableGammaError = (err: unknown): boolean => {
    if (err && typeof err === "object") {
      const retryable = (err as { retryable?: boolean }).retryable;
      if (typeof retryable === "boolean") return retryable;
      const code = (err as { code?: string }).code;
      if (code === "NOT_FOUND") return false;
      const status = (err as { status?: number }).status;
      if (status === 404 || status === 410) return false;
      if (status === 429 || (typeof status === "number" && status >= 500)) return true;
    }
    if (err instanceof Error) {
      if (err.name === "AbortError") return true;
      const maybe = err as { code?: string };
      if (maybe.code && ["ECONNRESET", "ETIMEDOUT", "EAI_AGAIN", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_SOCKET"].includes(maybe.code)) {
        return true;
      }
    }
    return false;
  };

  try {
    const payload = await runWithTimeout(
      (async (): Promise<SuccessPayload | ErrorEnvelope> => {
        const marketController = new AbortController();
        const marketTimer = setTimeout(() => marketController.abort(), marketTimeoutMs);
        let market;
        try {
          const gammaRate = await rateLimitCheck(
            Number.parseInt(process.env.GAMMA_RATE_LIMIT_MS ?? "0", 10),
            "gamma",
          );
          if (gammaRate) {
            return withEnvelopeMeta(gammaRate, resolvedVia, { hit: false, ttl_sec: 0 });
          }
          const retries = Number.parseInt(process.env.GAMMA_RETRIES ?? "2", 10);
          const backoff = Number.parseInt(process.env.GAMMA_BACKOFF_MS ?? "500", 10);
          const res = await withRetries(
            () =>
              fetchMarketData({
                slug: input.slug ?? undefined,
                id: input.id ?? undefined,
                eventSlug: input.eventSlug ?? undefined,
                marketIndex: input.marketIndex,
                gammaBaseUrl: gammaEndpoint,
                gammaDelayMs,
                signal: marketController.signal,
              }),
            retries,
            backoff,
            isRetryableGammaError,
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
          const errorCode = (err as { code?: string }).code;
          const status = (err as { status?: number }).status;
          const isNotFound = errorCode === "NOT_FOUND" || status === 404 || status === 410;
          const retryable =
            typeof (err as { retryable?: boolean }).retryable === "boolean"
              ? ((err as { retryable?: boolean }).retryable as boolean)
              : isTimeout
                ? true
                : !isNotFound;
          return withEnvelopeMeta(
            {
              status: "error",
              step: "market_fetch",
              error_code: isTimeout ? "TIMEOUT" : isNotFound ? "NOT_FOUND" : "NETWORK_ERROR",
              message: isTimeout
                ? "Market fetch timed out."
                : isNotFound
                  ? "Market not found."
                  : "Market fetch failed.",
              retryable,
              attempts:
                typeof (err as { attempts?: number }).attempts === "number"
                  ? ((err as { attempts?: number }).attempts as number)
                  : Number.parseInt(process.env.GAMMA_RETRIES ?? "2", 10) + 1,
              sources_count: 0,
            },
            resolvedVia,
            { hit: false, ttl_sec: 0 },
          );
        } finally {
          clearTimeout(marketTimer);
        }

        if (!market) {
          return withEnvelopeMeta(
            {
              status: "error",
              step: "market_fetch",
              error_code: "BAD_RESPONSE",
              message: "Market data unavailable.",
              retryable: true,
            },
            resolvedVia,
            { hit: false, ttl_sec: 0 },
          );
        }

        const outcomeSummary = formatOutcomeSummary(market.outcomes, market.outcomePrices);
        const promptTemplate = await loadPromptTemplate();

        const sources: SearchResult[] = [];

        debugLog(`sources: ${summarizeSources(sources)}`);

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
          return withEnvelopeMeta(
            {
              status: "error",
              step: isInvalidJson ? "parse" : isValidation ? "validate" : "llm",
              error_code: isTimeout ? "TIMEOUT" : isInvalidJson ? "INVALID_JSON" : "BAD_RESPONSE",
              message,
              retryable: true,
              attempts: Number.parseInt(process.env.LLM_RETRIES ?? "2", 10) + 1,
              sources_count: sources.length,
            },
            resolvedVia,
            { hit: false, ttl_sec: 0 },
          );
        }

        let structured = safeJsonParse<Record<string, unknown>>(prediction.rawText);
        if (structured && typeof structured === "object") {
          structured = sanitizeUnsupportedStrings(structured) as Record<string, unknown>;
        } else {
          return withEnvelopeMeta(
            {
              status: "error",
              step: "parse",
              error_code: "INVALID_JSON",
              message: "LLM output could not be parsed as JSON.",
              retryable: true,
              attempts: 1,
              sources_count: sources.length,
            },
            resolvedVia,
            { hit: false, ttl_sec: 0 },
          );
        }

        const withMeta = withEnvelopeMeta(
          structured as SuccessPayload,
          resolvedVia,
          { hit: false, ttl_sec: DEFAULT_CACHE_TTL_SEC },
        );

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
          final_report: withMeta ?? { error: "invalid json" },
          metrics: {
            source_count: evidence.sourceCount,
            best_tier: evidence.bestTier,
            recency_summary: evidence.recencySummary,
            sanitizeUsed: prediction.sanitizeUsed,
            retryUsed: prediction.retryUsed,
            hallucination_red_flags: JSON.stringify(withMeta ?? {}).match(
              /(current date|post-election|post election|already happened|as of today|today|yesterday)/i,
            )
              ? 1
              : 0,
          },
        });

        try {
          await writeCache(cacheKey, withMeta);
        } catch {
          // cache write failures should not block result
        }

        return withMeta;
      })(),
      overallTimeoutMs,
    );

    if ((payload as ErrorEnvelope).status === "error") {
      return { status: "error", error: payload as ErrorEnvelope };
    }
    return { status: "success", payload: payload as SuccessPayload };
  } catch (err) {
    const isTimeout = err instanceof Error && err.message === "OVERALL_TIMEOUT";
    return {
      status: "error",
      error: withEnvelopeMeta(
        {
          status: "error",
          step: "overall",
          error_code: isTimeout ? "TIMEOUT" : "BAD_RESPONSE",
          message: isTimeout ? "Overall run timed out." : "Unexpected failure.",
          retryable: true,
        },
        resolvedVia,
        { hit: false, ttl_sec: 0 },
      ),
    };
  }
}

function formatOutcomeSummary(outcomes: string[], prices: number[]): string[] {
  if (outcomes.length === 0) return [];
  return outcomes.map((outcome, i) => {
    const price = prices[i];
    if (price == null) return outcome;
    return `${outcome} (${formatPercent(price)})`;
  });
}
