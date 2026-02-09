import { normalizeNumberArray, normalizeStringArray } from "./utils.js";

export interface MarketSide {
  id?: string;
  outcome?: string;
  description?: string;
  price?: number | string;
  lastTradePrice?: number | string;
  [key: string]: unknown;
}

export interface MarketData {
  id: string;
  slug?: string;
  question?: string;
  description?: string;
  resolutionCriteria?: string;
  endDate?: string;
  category?: string;
  subcategory?: string;
  outcomes: string[];
  outcomePrices: number[];
  sides?: MarketSide[];
  bbo?: Record<string, unknown>;
  raw?: Record<string, unknown>;
}

const DEFAULT_GAMMA_BASE_URL = "https://gamma-api.polymarket.com";

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, {
    headers: {
      "Accept": "application/json",
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Polymarket API error (${res.status}): ${text}`);
  }
  return (await res.json()) as T;
}

export async function fetchMarketBySlug(
  slug: string,
  baseUrl = DEFAULT_GAMMA_BASE_URL,
): Promise<Record<string, unknown>> {
  return fetchJson<Record<string, unknown>>(`${baseUrl}/markets/slug/${encodeURIComponent(slug)}`);
}

export async function fetchMarketById(
  id: string,
  baseUrl = DEFAULT_GAMMA_BASE_URL,
): Promise<Record<string, unknown>> {
  return fetchJson<Record<string, unknown>>(`${baseUrl}/markets/${encodeURIComponent(id)}`);
}

export async function fetchEventBySlug(
  slug: string,
  baseUrl = DEFAULT_GAMMA_BASE_URL,
): Promise<Record<string, unknown>> {
  try {
    return await fetchJson<Record<string, unknown>>(`${baseUrl}/events/slug/${encodeURIComponent(slug)}`);
  } catch (err) {
    const fallback = await fetchJson<Record<string, unknown>[]>(
      `${baseUrl}/events?slug=${encodeURIComponent(slug)}`,
    );
    if (fallback.length === 0) throw err;
    return fallback[0];
  }
}

export async function fetchMarketData(params: {
  slug?: string;
  id?: string;
  eventSlug?: string;
  marketIndex?: number;
  gammaBaseUrl?: string;
}): Promise<MarketData> {
  const gammaBaseUrl = params.gammaBaseUrl ?? DEFAULT_GAMMA_BASE_URL;
  let market: Record<string, unknown>;
  if (params.eventSlug) {
    const event = await fetchEventBySlug(params.eventSlug, gammaBaseUrl);
    const markets = Array.isArray((event as { markets?: unknown }).markets)
      ? ((event as { markets?: unknown }).markets as Record<string, unknown>[])
      : [];
    if (markets.length === 0) {
      throw new Error("Event has no markets.");
    }
    const index = params.marketIndex ?? 0;
    if (index < 0 || index >= markets.length) {
      throw new Error(`Event market index out of range. Max index: ${markets.length - 1}`);
    }
    const selected = markets[index];
    const marketSlug = typeof selected.slug === "string" ? selected.slug : undefined;
    const marketId = typeof selected.id === "string" ? selected.id : undefined;
    if (marketSlug) {
      market = await fetchMarketBySlug(marketSlug, gammaBaseUrl);
    } else if (marketId) {
      market = await fetchMarketById(marketId, gammaBaseUrl);
    } else {
      market = selected;
    }
  } else if (params.slug) {
    market = await fetchMarketBySlug(params.slug, gammaBaseUrl);
  } else if (params.id) {
    market = await fetchMarketById(params.id, gammaBaseUrl);
  } else {
    throw new Error("Provide either a market slug, market id, or event slug.");
  }

  const id = String(market.id ?? market.marketId ?? "");
  if (!id) throw new Error("Polymarket response missing market id.");

  const outcomes = normalizeStringArray(market.outcomes);
  const outcomePrices = normalizeNumberArray(market.outcomePrices);

  return {
    id,
    slug: typeof market.slug === "string" ? market.slug : params.slug,
    question: typeof market.question === "string" ? market.question : undefined,
    description: typeof market.description === "string" ? market.description : undefined,
    resolutionCriteria:
      typeof market.resolutionCriteria === "string" ? market.resolutionCriteria : undefined,
    endDate:
      typeof market.endDate === "string"
        ? market.endDate
        : typeof market.closeDate === "string"
          ? market.closeDate
          : undefined,
    category: typeof market.category === "string" ? market.category : undefined,
    subcategory: typeof market.subcategory === "string" ? market.subcategory : undefined,
    outcomes,
    outcomePrices,
    sides: undefined,
    bbo: undefined,
    raw: market,
  };
}
