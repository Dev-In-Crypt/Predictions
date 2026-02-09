export interface SearchResult {
  url: string;
  title: string;
  snippet: string;
  domain: string;
  publishedDate?: string;
  tier: "tier1" | "tier2" | "tier3" | "unknown";
  score: number;
}

export interface SearchBundle {
  queries: string[];
  results: SearchResult[];
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

function domainFromUrl(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function classifyTier(domain: string): SearchResult["tier"] {
  if (!domain) return "unknown";
  if (TIER1_DOMAINS.some((d) => domain.endsWith(d))) return "tier1";
  if (TIER2_DOMAINS.some((d) => domain.endsWith(d))) return "tier2";
  if (domain.endsWith(".gov") || domain.endsWith(".edu") || domain.endsWith(".int")) return "tier1";
  return "tier3";
}

function recencyScore(publishedDate?: string): number {
  if (!publishedDate) return 0;
  const ts = Date.parse(publishedDate);
  if (Number.isNaN(ts)) return 0;
  const days = (Date.now() - ts) / (1000 * 60 * 60 * 24);
  if (days < 7) return 3;
  if (days < 30) return 2;
  if (days < 180) return 1;
  return 0;
}

function tierScore(tier: SearchResult["tier"]): number {
  if (tier === "tier1") return 3;
  if (tier === "tier2") return 2;
  if (tier === "tier3") return 1;
  return 0;
}

export function generateQueries(params: {
  title: string;
  description?: string;
  resolutionCriteria?: string;
}): string[] {
  const title = params.title.trim();
  const base = title.replace(/\s+/g, " ");
  const queries = new Set<string>();
  queries.add(base);
  queries.add(`${base} resolution`);
  queries.add(`${base} official announcement`);
  if (params.resolutionCriteria) {
    const rc = params.resolutionCriteria.split(".")[0]?.trim();
    if (rc) queries.add(`${base} ${rc}`);
  }
  if (params.description) {
    const words = params.description
      .split(/\s+/)
      .filter((w) => /^[A-Z][A-Za-z\-]+$/.test(w))
      .slice(0, 3);
    if (words.length > 0) queries.add(`${base} ${words.join(" ")}`);
  }
  return Array.from(queries).slice(0, 7);
}

export async function searchBrave(
  apiKey: string,
  queries: string[],
  opts: { timeoutMs: number },
): Promise<SearchBundle> {
  const results: SearchResult[] = [];
  for (const query of queries) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), opts.timeoutMs);
    const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=20`;
    const res = await fetch(url, {
      headers: {
        "Accept": "application/json",
        "X-Subscription-Token": apiKey,
      },
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Brave search error (${res.status}): ${text}`);
    }
    const data = (await res.json()) as {
      web?: { results?: Array<{ url?: string; title?: string; description?: string; published?: string; page_age?: string }> };
    };
    const items = data.web?.results ?? [];
    for (const item of items) {
      const url = item.url ?? "";
      if (!url) continue;
      const domain = domainFromUrl(url);
      const tier = classifyTier(domain);
      const publishedDate = item.published ?? item.page_age ?? undefined;
      const score = tierScore(tier) + recencyScore(publishedDate);
      results.push({
        url,
        title: item.title ?? "",
        snippet: item.description ?? "",
        domain,
        publishedDate,
        tier,
        score,
      });
    }
  }

  // Deduplicate by URL and domain, then keep top 8–12.
  const byUrl = new Map<string, SearchResult>();
  for (const r of results) {
    if (!byUrl.has(r.url)) byUrl.set(r.url, r);
  }
  const deduped = Array.from(byUrl.values());
  const byDomain = new Map<string, SearchResult>();
  for (const r of deduped.sort((a, b) => b.score - a.score)) {
    if (!byDomain.has(r.domain)) byDomain.set(r.domain, r);
  }
  const ranked = Array.from(byDomain.values()).sort((a, b) => b.score - a.score);
  return {
    queries,
    results: ranked.slice(0, 12),
  };
}
