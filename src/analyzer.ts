import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fetchMarketData } from "./marketFetcher.js";
import { requestPrediction } from "./aiClient.js";
import { DEFAULT_PROMPT } from "./prompt.js";
import { generateQueries, searchBrave, type ExternalSource } from "./searchClient.js";
import { formatPercent, readEnv, safeJsonParse } from "./utils.js";

const SCHEMA_VERSION = "1.0";
const DEFAULT_CACHE_TTL_SEC = 1800;
const CACHE_PIPELINE_VERSION = "stage6_0";

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
  sources?: unknown;
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

type SourceItem = {
  source_id?: string;
  url?: string;
  canonical_url?: string;
  title?: string;
  snippet?: string;
  description?: string;
  resolution_criteria?: string;
  domain?: string;
  published_at?: string;
  published_date?: string;
  tier?: "tier1" | "tier2" | "unknown";
  captured_at_utc?: string;
  retrieved_at_utc?: string;
  type?: string;
  label?: string;
};

const ALLOWED_TIERS = new Set(["tier1", "tier2", "unknown"]);
const TIER1_DOMAINS = [
  "reuters.com",
  "apnews.com",
  "bbc.com",
  "nytimes.com",
  "wsj.com",
  "ft.com",
  "bloomberg.com",
  "economist.com",
];
const TIER2_DOMAINS = [
  "cnn.com",
  "theguardian.com",
  "washingtonpost.com",
  "politico.com",
  "axios.com",
  "npr.org",
  "cnbc.com",
  "usatoday.com",
  "latimes.com",
];
const MAX_TITLE = 200;
const MAX_SNIPPET = 1200;
const MAX_DESCRIPTION = 2000;
const MAX_RESOLUTION = 1200;
const MAX_LABEL = 120;

function inferTier(domain: string): SourceItem["tier"] {
  if (!domain) return "unknown";
  if (TIER1_DOMAINS.some((d) => domain.endsWith(d))) return "tier1";
  if (TIER2_DOMAINS.some((d) => domain.endsWith(d))) return "tier2";
  if (domain.endsWith(".gov") || domain.endsWith(".edu") || domain.endsWith(".int")) return "tier1";
  return "unknown";
}

function normalizeInputSources(input: unknown): { sources: SourceItem[]; malformed: boolean } {
  if (input === undefined || input === null) return { sources: [], malformed: false };
  if (!Array.isArray(input)) return { sources: [], malformed: true };

  const clampText = (value: string | undefined, max: number): string | undefined => {
    if (!value) return undefined;
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
  };

  const hash = (value: string): string => {
    let h = 5381;
    for (let i = 0; i < value.length; i += 1) {
      h = (h * 33) ^ value.charCodeAt(i);
    }
    return (h >>> 0).toString(16);
  };

  const derivePageSourceId = (url: string): string | undefined => {
    try {
      const parsed = new URL(url);
      if (!parsed.hostname.endsWith("polymarket.com")) return undefined;
      const marker = "/event/";
      const idx = parsed.pathname.indexOf(marker);
      if (idx === -1) return undefined;
      const slug = parsed.pathname.slice(idx + marker.length).replace(/^\/+|\/+$/g, "");
      if (!slug) return undefined;
      return `page:polymarket:${slug}`;
    } catch {
      return undefined;
    }
  };

  const normalized: SourceItem[] = [];
  let malformed = false;
  const nowIso = new Date().toISOString();
  for (const raw of input) {
    if (!raw || typeof raw !== "object") {
      malformed = true;
      continue;
    }
    const obj = raw as Record<string, unknown>;
    const url = typeof obj.url === "string" ? obj.url.trim() : "";
    if (!url) {
      malformed = true;
      continue;
    }
    const title = clampText(typeof obj.title === "string" ? obj.title : undefined, MAX_TITLE);
    const snippet = clampText(typeof obj.snippet === "string" ? obj.snippet : undefined, MAX_SNIPPET);
    let domain = typeof obj.domain === "string" ? obj.domain.trim() : "";
    if (!domain && url) {
      try {
        domain = new URL(url).hostname.replace(/^www\./, "");
      } catch {
        domain = "";
      }
    }
    const publishedRaw =
      typeof obj.published_date === "string"
        ? obj.published_date.trim()
        : typeof obj.publishedDate === "string"
          ? obj.publishedDate.trim()
          : undefined;
    const tierRaw = typeof obj.tier === "string" ? obj.tier.trim() : undefined;
    const tier =
      tierRaw && ALLOWED_TIERS.has(tierRaw)
        ? (tierRaw as SourceItem["tier"])
        : inferTier(domain || "");

    const description = clampText(
      typeof obj.description === "string" ? obj.description : undefined,
      MAX_DESCRIPTION,
    );
    const resolutionCriteria = clampText(
      typeof obj.resolution_criteria === "string" ? obj.resolution_criteria : undefined,
      MAX_RESOLUTION,
    );

    let sourceId = typeof obj.source_id === "string" ? obj.source_id.trim() : undefined;
    const type = typeof obj.type === "string" ? obj.type.trim() : undefined;
    if (!sourceId) {
      if (type === "page") {
        sourceId = derivePageSourceId(url) ?? `page:${hash(normalizeUrl(url))}`;
      } else {
        sourceId = `url:${hash(normalizeUrl(url))}`;
      }
    }

    const capturedAt =
      typeof obj.captured_at_utc === "string"
        ? obj.captured_at_utc.trim()
        : typeof obj.capturedAtUtc === "string"
          ? obj.capturedAtUtc.trim()
          : undefined;
    const retrievedAt =
      typeof obj.retrieved_at_utc === "string"
        ? obj.retrieved_at_utc.trim()
        : typeof obj.retrievedAtUtc === "string"
          ? obj.retrievedAtUtc.trim()
          : undefined;
    const ensuredCaptured = capturedAt || retrievedAt ? capturedAt : type === "page" ? nowIso : undefined;
    const ensuredRetrieved = retrievedAt || capturedAt ? retrievedAt : type === "page" ? undefined : nowIso;

    normalized.push({
      source_id: sourceId,
      url,
      title,
      snippet,
      description,
      resolution_criteria: resolutionCriteria,
      domain: domain || undefined,
      published_date: publishedRaw,
      tier,
      captured_at_utc: ensuredCaptured,
      retrieved_at_utc: ensuredRetrieved,
      type,
      label: clampText(typeof obj.label === "string" ? obj.label : undefined, MAX_LABEL),
    });
  }

  const fingerprint = (source: SourceItem): string => {
    const data = [
      normalizeUrl(source.url ?? ""),
      source.title ?? "",
      source.snippet ?? "",
      source.description ?? "",
      source.resolution_criteria ?? "",
      source.published_date ?? "",
    ].join("|");
    return hash(data);
  };

  const deduped = new Map<string, SourceItem>();
  for (const source of normalized) {
    const key = `${normalizeUrl(source.url ?? "")}::${fingerprint(source)}`;
    if (!deduped.has(key)) {
      deduped.set(key, source);
    }
  }

  return { sources: Array.from(deduped.values()), malformed };
}

function summarizeSources(sources: SourceItem[]): string {
  if (sources.length === 0) return "count=0 tiers={} newest=unknown";
  const tiers: Record<string, number> = {};
  let newest: string | undefined;
  for (const s of sources) {
    const tier = s.tier ?? "unknown";
    tiers[tier] = (tiers[tier] ?? 0) + 1;
    if (s.published_date) {
      if (!newest || Date.parse(s.published_date) > Date.parse(newest)) newest = s.published_date;
    }
  }
  return `count=${sources.length} tiers=${JSON.stringify(tiers)} newest=${newest ?? "unknown"}`;
}

function evidenceQuality(sources: SourceItem[]): {
  sourceCount: number;
  bestTier: string;
  recencySummary: string;
  conflictsDetected: string[];
} {
  if (sources.length === 0) {
    return { sourceCount: 0, bestTier: "unknown", recencySummary: "unknown", conflictsDetected: [] };
  }
  const tiers = sources.map((s) => s.tier ?? "unknown");
  const bestTier = tiers.includes("tier1")
    ? "tier1"
    : tiers.includes("tier2")
      ? "tier2"
      : "unknown";
  const recencySummary = sources.some((s) => s.published_date) ? "mixed" : "unknown";
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

function ensureStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item) => typeof item === "string");
}

function applyOutputSourceDefaults(
  payload: Record<string, unknown>,
  sources: SourceItem[],
  options?: { forceSourcesMissing?: boolean },
): Record<string, unknown> {
  if (!Array.isArray(payload.sources)) {
    payload.sources = sources;
  }

  if (typeof payload.sources_used_count !== "number") {
    payload.sources_used_count = Array.isArray(payload.sources) ? (payload.sources as unknown[]).length : 0;
  }

  if (typeof payload.sources_missing !== "boolean") {
    const count = typeof payload.sources_used_count === "number" ? payload.sources_used_count : 0;
    payload.sources_missing = count === 0;
  }
  if (options?.forceSourcesMissing) {
    payload.sources_missing = true;
  }

  const full = (payload.full_report as Record<string, unknown>) ?? {};
  const keyFacts = Array.isArray(full.key_facts) ? (full.key_facts as Record<string, unknown>[]) : null;
  if (keyFacts) {
    for (const item of keyFacts) {
      if (!Array.isArray(item?.support_ids)) {
        item.support_ids = [];
      }
    }
  }

  if (payload.sources_missing === true) {
    const riskFlags = ensureStringArray(full.risk_flags);
    if (!riskFlags.includes("sources_missing")) {
      riskFlags.push("sources_missing");
    }
    full.risk_flags = riskFlags;
  }

  payload.full_report = full;
  return payload;
}

function normalizeUrl(value: string): string {
  return value.trim().replace(/\/+$/g, "").toLowerCase();
}

function isEnabled(name: string, fallback = "0"): boolean {
  const raw = (process.env[name] ?? fallback).trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "on";
}

function searchEnabled(): boolean {
  return isEnabled("SEARCH_ENABLED", "0");
}

function fromExternalSource(source: ExternalSource): SourceItem {
  return {
    source_id: source.source_id,
    url: source.url,
    canonical_url: source.canonical_url,
    title: source.title,
    snippet: source.snippet,
    domain: source.domain,
    published_at: source.published_at,
    published_date: source.published_at,
    tier: source.tier,
    retrieved_at_utc: new Date().toISOString(),
    type: "search",
    label: "External search",
  };
}

function mergeSourceLists(inputSources: SourceItem[], externalSources: SourceItem[]): SourceItem[] {
  if (externalSources.length === 0) return inputSources;
  const merged = new Map<string, SourceItem>();
  const all = [...inputSources, ...externalSources];
  for (const source of all) {
    const key = normalizeUrl(source.canonical_url ?? source.url ?? "");
    if (!key) continue;
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, source);
      continue;
    }
    const existingTier = existing.tier ?? "unknown";
    const currentTier = source.tier ?? "unknown";
    const rank = (tier: string): number => (tier === "tier1" ? 2 : tier === "tier2" ? 1 : 0);
    if (rank(currentTier) > rank(existingTier)) {
      merged.set(key, source);
    }
  }
  return Array.from(merged.values());
}

function enforceKeyFactSupport(
  payload: Record<string, unknown>,
  sources: SourceItem[],
): { payload: Record<string, unknown>; usedSourceIds: string[] } {
  const full = (payload.full_report as Record<string, unknown>) ?? {};
  const keyFacts = Array.isArray(full.key_facts) ? (full.key_facts as Record<string, unknown>[]) : null;
  if (!keyFacts) return { payload, usedSourceIds: [] };

  const sourceById = new Map<string, SourceItem>();
  const sourceByUrl = new Map<string, SourceItem>();
  for (const source of sources) {
    if (typeof source.source_id === "string" && source.source_id.trim()) {
      sourceById.set(source.source_id.trim(), source);
    }
    if (typeof source.url === "string" && source.url.trim()) {
      sourceByUrl.set(normalizeUrl(source.url), source);
    }
  }

  const usedIds = new Set<string>();
  const filtered: Record<string, unknown>[] = [];
  for (const item of keyFacts) {
    const rawSources = ensureStringArray(item.sources);
    const supportIds: string[] = [];
    for (const ref of rawSources) {
      const matchById = sourceById.get(ref);
      if (matchById?.source_id) {
        supportIds.push(matchById.source_id);
        usedIds.add(matchById.source_id);
        continue;
      }
      const matchByUrl = sourceByUrl.get(normalizeUrl(ref));
      if (matchByUrl?.source_id) {
        supportIds.push(matchByUrl.source_id);
        usedIds.add(matchByUrl.source_id);
        continue;
      }
      if (matchByUrl?.url) {
        supportIds.push(matchByUrl.url);
        usedIds.add(matchByUrl.url);
      }
    }
    if (supportIds.length > 0) {
      item.support_ids = Array.from(new Set(supportIds));
      filtered.push(item);
    }
  }

  full.key_facts = filtered;
  payload.full_report = full;
  return { payload, usedSourceIds: Array.from(usedIds) };
}

const CONFIDENCE_ORDER = ["low", "medium", "high"];

function lowerConfidence(confidence: string, steps = 1): string {
  const idx = CONFIDENCE_ORDER.indexOf(confidence);
  if (idx === -1) return confidence;
  return CONFIDENCE_ORDER[Math.max(0, idx - steps)];
}

function applyTieringSignals(payload: Record<string, unknown>, sources: SourceItem[]): Record<string, unknown> {
  const full = (payload.full_report as Record<string, unknown>) ?? {};
  const quick = (payload.quick_view as Record<string, unknown>) ?? {};
  const confidence = typeof quick.confidence === "string" ? quick.confidence : undefined;

  const sourcesMissing = payload.sources_missing === true || sources.length === 0;
  const weakSources =
    !sourcesMissing &&
    sources.length > 0 &&
    sources.every((s) => {
      const tier = s.tier ?? "unknown";
      return tier === "unknown";
    });

  if (sourcesMissing && confidence) {
    quick.confidence = "low";
  } else if (weakSources && confidence) {
    quick.confidence = lowerConfidence(confidence, 1);
  }

  if (weakSources) {
    const riskFlags = ensureStringArray(full.risk_flags);
    if (!riskFlags.includes("weak_sources")) {
      riskFlags.push("weak_sources");
    }
    full.risk_flags = riskFlags;
  }

  payload.quick_view = quick;
  payload.full_report = full;
  return payload;
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
  const parts = [base, `pipeline=${CACHE_PIPELINE_VERSION}`, `search=${searchEnabled() ? "on" : "off"}`];
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
    const cachedSources = Array.isArray(cached.payload.sources) ? (cached.payload.sources as SourceItem[]) : [];
    cached.payload = applyOutputSourceDefaults(cached.payload as Record<string, unknown>, cachedSources);
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
  const searchRequestTimeoutMs = Number.parseInt(process.env.SEARCH_TIMEOUT_MS ?? "5000", 10);
  const searchTotalTimeoutMs = Number.parseInt(process.env.SEARCH_TOTAL_TIMEOUT_MS ?? "12000", 10);
  const searchRetries = Number.parseInt(process.env.SEARCH_RETRIES ?? "1", 10);
  const searchBackoffMs = Number.parseInt(process.env.SEARCH_BACKOFF_MS ?? "400", 10);
  const searchRateLimitMs = Number.parseInt(process.env.SEARCH_RATE_LIMIT_MS ?? "0", 10);
  const searchPerQueryCount = Number.parseInt(process.env.SEARCH_PER_QUERY_COUNT ?? "10", 10);
  const searchTopN = Number.parseInt(process.env.SEARCH_TOP_N ?? "12", 10);
  const searchMaxPerDomain = Number.parseInt(process.env.SEARCH_MAX_PER_DOMAIN ?? "2", 10);

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

        const { sources: inputSources, malformed: sourcesMalformed } = normalizeInputSources(input.sources);
        let sources = inputSources;

        if (searchEnabled()) {
          try {
            const searchApiKey = readEnv("SEARCH_API_KEY", true) as string;
            const searchRateLimited = await rateLimitCheck(searchRateLimitMs, "search");
            if (!searchRateLimited) {
              const queries = generateQueries({
                title: market.question ?? market.slug ?? market.id,
                description: market.description,
                resolutionCriteria: market.resolutionCriteria,
              });
              if (queries.length > 0) {
                const searchPromise = searchBrave(searchApiKey, queries, {
                  timeoutMs: searchRequestTimeoutMs,
                  retries: searchRetries,
                  backoffMs: searchBackoffMs,
                  perQueryCount: searchPerQueryCount,
                  topN: searchTopN,
                  maxPerDomain: searchMaxPerDomain,
                });
                const bundle = await runWithTimeout(searchPromise, searchTotalTimeoutMs);
                const normalizedExternal = bundle.results.map(fromExternalSource);
                sources = mergeSourceLists(inputSources, normalizedExternal);
              }
            }
          } catch (err) {
            debugLog(`search: skipped (${err instanceof Error ? err.message : "error"})`);
          }
        }

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
                    `published_date: ${s.published_date ?? s.published_at ?? "unknown"}\n` +
                    `domain: ${s.domain ?? "unknown"}\n` +
                    `tier: ${s.tier ?? "unknown"}`,
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
          structured = applyOutputSourceDefaults(structured, sources, {
            forceSourcesMissing: sourcesMalformed && sources.length === 0,
          }) as Record<string, unknown>;
          const enforced = enforceKeyFactSupport(structured, sources);
          structured = enforced.payload;
          structured.sources_used_count = enforced.usedSourceIds.length;
          structured = applyTieringSignals(structured, sources);
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
