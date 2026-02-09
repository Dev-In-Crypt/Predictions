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

async function fetchJson<T>(url: string, options?: { signal?: AbortSignal }): Promise<T> {
  const res = await fetch(url, {
    headers: {
      "Accept": "application/json",
    },
    signal: options?.signal,
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
  options?: { signal?: AbortSignal },
): Promise<Record<string, unknown>> {
  return fetchJson<Record<string, unknown>>(
    `${baseUrl}/markets/slug/${encodeURIComponent(slug)}`,
    options,
  );
}

export async function fetchMarketById(
  id: string,
  baseUrl = DEFAULT_GAMMA_BASE_URL,
  options?: { signal?: AbortSignal },
): Promise<Record<string, unknown>> {
  return fetchJson<Record<string, unknown>>(`${baseUrl}/markets/${encodeURIComponent(id)}`, options);
}

export async function fetchEventBySlug(
  slug: string,
  baseUrl = DEFAULT_GAMMA_BASE_URL,
  options?: { signal?: AbortSignal },
): Promise<Record<string, unknown>> {
  try {
    return await fetchJson<Record<string, unknown>>(
      `${baseUrl}/events/slug/${encodeURIComponent(slug)}`,
      options,
    );
  } catch (err) {
    const fallback = await fetchJson<Record<string, unknown>[]>(
      `${baseUrl}/events?slug=${encodeURIComponent(slug)}`,
      options,
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
  signal?: AbortSignal;
}): Promise<MarketData> {
  const gammaBaseUrl = params.gammaBaseUrl ?? DEFAULT_GAMMA_BASE_URL;
  let market: Record<string, unknown>;
  if (params.eventSlug) {
    let eventSlug = params.eventSlug;
    let marketSlugFromPath: string | undefined;
    if (eventSlug.includes("/")) {
      const [eventPart, marketPart] = eventSlug.split("/", 2);
      eventSlug = eventPart;
      marketSlugFromPath = marketPart;
    }

    let event: Record<string, unknown> | null = null;
    let directMarket: Record<string, unknown> | null = null;
    try {
      event = await fetchEventBySlug(eventSlug, gammaBaseUrl, { signal: params.signal });
    } catch (err) {
      if (marketSlugFromPath) {
        try {
          directMarket = await fetchMarketBySlug(marketSlugFromPath, gammaBaseUrl, {
            signal: params.signal,
          });
          event = null;
        } catch {
          throw err;
        }
      } else {
        try {
          directMarket = await fetchMarketBySlug(eventSlug, gammaBaseUrl, {
            signal: params.signal,
          });
          event = null;
        } catch {
          throw err;
        }
      }
      if (!event && !directMarket) {
        throw err;
      }
    }
    if (!event && directMarket) {
      return {
        id: String(directMarket.id ?? directMarket.marketId ?? ""),
        slug: typeof directMarket.slug === "string" ? directMarket.slug : marketSlugFromPath,
        question: typeof directMarket.question === "string" ? directMarket.question : undefined,
        description:
          typeof directMarket.description === "string" ? directMarket.description : undefined,
        resolutionCriteria:
          typeof directMarket.resolutionCriteria === "string"
            ? directMarket.resolutionCriteria
            : undefined,
        endDate:
          typeof directMarket.endDate === "string"
            ? directMarket.endDate
            : typeof directMarket.closeDate === "string"
              ? directMarket.closeDate
              : undefined,
        category: typeof directMarket.category === "string" ? directMarket.category : undefined,
        subcategory:
          typeof directMarket.subcategory === "string" ? directMarket.subcategory : undefined,
        outcomes: normalizeStringArray(directMarket.outcomes),
        outcomePrices: normalizeNumberArray(directMarket.outcomePrices),
        sides: undefined,
        bbo: undefined,
        raw: directMarket,
      };
    }

    const markets = Array.isArray((event as { markets?: unknown }).markets)
      ? ((event as { markets?: unknown }).markets as Record<string, unknown>[])
      : [];
    if (markets.length === 0) {
      throw new Error("Event has no markets.");
    }
    let selected: Record<string, unknown> | undefined;
    if (marketSlugFromPath) {
      selected = markets.find(
        (m) => typeof m.slug === "string" && m.slug === marketSlugFromPath,
      );
    }
    if (!selected) {
      const index = params.marketIndex ?? 0;
      if (index < 0 || index >= markets.length) {
        throw new Error(`Event market index out of range. Max index: ${markets.length - 1}`);
      }
      selected = markets[index];
    }
    const marketSlug = typeof selected.slug === "string" ? selected.slug : undefined;
    const marketId = typeof selected.id === "string" ? selected.id : undefined;
    if (marketSlug) {
      market = await fetchMarketBySlug(marketSlug, gammaBaseUrl, { signal: params.signal });
    } else if (marketId) {
      market = await fetchMarketById(marketId, gammaBaseUrl, { signal: params.signal });
    } else {
      market = selected;
    }
  } else if (params.slug) {
    market = await fetchMarketBySlug(params.slug, gammaBaseUrl, { signal: params.signal });
  } else if (params.id) {
    market = await fetchMarketById(params.id, gammaBaseUrl, { signal: params.signal });
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
