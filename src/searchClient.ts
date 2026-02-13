export type SourceTier = "tier1" | "tier2" | "unknown";

export interface ExternalSource {
  source_id: string;
  url: string;
  canonical_url: string;
  title: string;
  snippet: string;
  published_at?: string;
  domain: string;
  tier: SourceTier;
  relevance_score: number;
  recency_score: number;
  combined_score: number;
}

export interface SearchBundle {
  queries: string[];
  results: ExternalSource[];
}

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

function hash(value: string): string {
  let h = 5381;
  for (let i = 0; i < value.length; i += 1) {
    h = (h * 33) ^ value.charCodeAt(i);
  }
  return (h >>> 0).toString(16);
}

export function canonicalizeUrl(value: string): string {
  try {
    const parsed = new URL(value.trim());
    parsed.hash = "";
    ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "gclid", "fbclid", "ref"].forEach((k) => {
      parsed.searchParams.delete(k);
    });
    const query = parsed.searchParams.toString();
    const path = parsed.pathname.replace(/\/+$/g, "") || "/";
    return `${parsed.protocol}//${parsed.hostname.toLowerCase()}${path}${query ? `?${query}` : ""}`;
  } catch {
    return value.trim().toLowerCase().replace(/\/+$/g, "");
  }
}

export function domainFromUrl(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

function classifyTier(domain: string): SourceTier {
  if (!domain) return "unknown";
  if (domain.endsWith(".gov") || domain.endsWith(".edu") || domain.endsWith(".int")) return "tier1";
  if (TIER1_DOMAINS.some((d) => domain.endsWith(d))) return "tier1";
  if (TIER2_DOMAINS.some((d) => domain.endsWith(d))) return "tier2";
  return "unknown";
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 3);
}

function parsePublishedAt(raw?: string): string | undefined {
  if (!raw) return undefined;
  const ts = Date.parse(raw);
  if (!Number.isFinite(ts)) return undefined;
  return new Date(ts).toISOString();
}

function recencyScore(publishedAt?: string): number {
  if (!publishedAt) return 0;
  const ts = Date.parse(publishedAt);
  if (!Number.isFinite(ts)) return 0;
  const days = (Date.now() - ts) / (1000 * 60 * 60 * 24);
  if (days <= 7) return 4;
  if (days <= 30) return 3;
  if (days <= 180) return 2;
  return 1;
}

function relevanceScore(title: string, snippet: string, query: string): number {
  const hay = `${title} ${snippet}`.toLowerCase();
  const tokens = Array.from(new Set(tokenize(query)));
  if (tokens.length === 0) return 0;
  let matched = 0;
  for (const token of tokens) {
    if (hay.includes(token)) matched += 1;
  }
  return matched;
}

async function fetchBrave(apiKey: string, query: string, timeoutMs: number, count: number): Promise<Array<{ url?: string; title?: string; description?: string; published?: string; page_age?: string }>> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${count}`;
    const res = await fetch(url, {
      headers: {
        Accept: "application/json",
        "X-Subscription-Token": apiKey,
      },
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Brave search error (${res.status}): ${text}`);
    }
    const data = (await res.json()) as {
      web?: { results?: Array<{ url?: string; title?: string; description?: string; published?: string; page_age?: string }> };
    };
    return data.web?.results ?? [];
  } finally {
    clearTimeout(timeoutId);
  }
}

function buildSourceId(canonicalUrl: string): string {
  return `ext:${hash(canonicalUrl)}`;
}

export function generateQueries(params: {
  title: string;
  description?: string;
  resolutionCriteria?: string;
}): string[] {
  const base = params.title.trim().replace(/\s+/g, " ");
  if (!base) return [];
  const queries = new Set<string>();
  queries.add(base);
  if (params.description) {
    const entityWords = params.description
      .split(/\s+/)
      .filter((w) => /^[A-Z][A-Za-z\-]+$/.test(w))
      .slice(0, 3);
    if (entityWords.length > 0) queries.add(`${base} ${entityWords.join(" ")}`);
  }
  if (params.resolutionCriteria) {
    const criteria = params.resolutionCriteria.split(/[.;]/)[0]?.trim();
    if (criteria) queries.add(`${base} ${criteria}`);
  }
  queries.add(`${base} latest`);
  return Array.from(queries).slice(0, 4);
}

async function withRetries<T>(fn: () => Promise<T>, retries: number, backoffMs: number): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt >= retries) break;
      const delay = backoffMs * Math.pow(2, attempt);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw (lastErr instanceof Error ? lastErr : new Error("Search failed"));
}

export async function searchBrave(
  apiKey: string,
  queries: string[],
  opts: {
    timeoutMs: number;
    retries: number;
    backoffMs: number;
    perQueryCount: number;
    topN: number;
    maxPerDomain: number;
  },
): Promise<SearchBundle> {
  const rows: Array<{ query: string; url: string; title: string; snippet: string; published_at?: string; domain: string; tier: SourceTier; relevance: number; recency: number; combined: number }> = [];

  for (const query of queries) {
    const items = await withRetries(
      () => fetchBrave(apiKey, query, opts.timeoutMs, opts.perQueryCount),
      Math.max(0, opts.retries),
      Math.max(0, opts.backoffMs),
    );

    for (const item of items) {
      const url = (item.url ?? "").trim();
      if (!url) continue;
      const canonical = canonicalizeUrl(url);
      const title = (item.title ?? "").trim();
      const snippet = (item.description ?? "").trim();
      const domain = domainFromUrl(canonical);
      const tier = classifyTier(domain);
      const published_at = parsePublishedAt(item.published ?? item.page_age);
      const relevance = relevanceScore(title, snippet, query);
      const recency = recencyScore(published_at);
      const combined = relevance * 3 + recency;
      rows.push({ query, url: canonical, title, snippet, published_at, domain, tier, relevance, recency, combined });
    }
  }

  rows.sort((a, b) => b.combined - a.combined);

  const byCanonical = new Map<string, typeof rows[number]>();
  for (const row of rows) {
    const existing = byCanonical.get(row.url);
    if (!existing || row.combined > existing.combined) {
      byCanonical.set(row.url, row);
    }
  }

  const byDomainCount = new Map<string, number>();
  const selected: ExternalSource[] = [];
  for (const row of Array.from(byCanonical.values())) {
    if (selected.length >= opts.topN) break;
    const domainCount = byDomainCount.get(row.domain) ?? 0;
    if (domainCount >= opts.maxPerDomain) continue;
    byDomainCount.set(row.domain, domainCount + 1);
    selected.push({
      source_id: buildSourceId(row.url),
      url: row.url,
      canonical_url: row.url,
      title: row.title,
      snippet: row.snippet,
      published_at: row.published_at,
      domain: row.domain,
      tier: row.tier,
      relevance_score: row.relevance,
      recency_score: row.recency,
      combined_score: row.combined,
    });
  }

  return {
    queries,
    results: selected,
  };
}
