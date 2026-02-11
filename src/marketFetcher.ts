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
  resolvedVia?: string;
}

const DEFAULT_GAMMA_BASE_URL = "https://gamma-api.polymarket.com";

interface GammaFetchOptions {
  signal?: AbortSignal;
  delayMs?: number;
}

type GammaErrorCode = "NOT_FOUND" | "NETWORK_ERROR";

class GammaFetchError extends Error {
  status?: number;
  retryable: boolean;
  code: GammaErrorCode;

  constructor(message: string, options: { status?: number; retryable: boolean; code: GammaErrorCode }) {
    super(message);
    this.name = "GammaFetchError";
    this.status = options.status;
    this.retryable = options.retryable;
    this.code = options.code;
  }
}

let lastGammaRequestAt = 0;

async function enforceGammaDelay(delayMs?: number): Promise<void> {
  if (!delayMs || delayMs <= 0) return;
  const now = Date.now();
  const wait = delayMs - (now - lastGammaRequestAt);
  if (wait > 0) {
    await new Promise((resolve) => setTimeout(resolve, wait));
  }
  lastGammaRequestAt = Date.now();
}

function isNotFoundStatus(status: number): boolean {
  return status === 404 || status === 410;
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

async function fetchJson<T>(url: string, options?: GammaFetchOptions): Promise<T> {
  await enforceGammaDelay(options?.delayMs);
  const res = await fetch(url, {
    headers: {
      "Accept": "application/json",
    },
    signal: options?.signal,
  });
  if (!res.ok) {
    const text = await res.text();
    const status = res.status;
    const code: GammaErrorCode = isNotFoundStatus(status) ? "NOT_FOUND" : "NETWORK_ERROR";
    const retryable = isRetryableStatus(status);
    throw new GammaFetchError(`Polymarket API error (${status}): ${text}`, {
      status,
      retryable,
      code,
    });
  }
  return (await res.json()) as T;
}

export async function fetchMarketBySlug(
  slug: string,
  baseUrl = DEFAULT_GAMMA_BASE_URL,
  options?: GammaFetchOptions,
): Promise<Record<string, unknown>> {
  return fetchJson<Record<string, unknown>>(
    `${baseUrl}/markets/slug/${encodeURIComponent(slug)}`,
    options,
  );
}

export async function fetchMarketById(
  id: string,
  baseUrl = DEFAULT_GAMMA_BASE_URL,
  options?: GammaFetchOptions,
): Promise<Record<string, unknown>> {
  return fetchJson<Record<string, unknown>>(`${baseUrl}/markets/${encodeURIComponent(id)}`, options);
}

export async function fetchEventBySlug(
  slug: string,
  baseUrl = DEFAULT_GAMMA_BASE_URL,
  options?: GammaFetchOptions,
): Promise<Record<string, unknown>> {
  try {
    return await fetchJson<Record<string, unknown>>(
      `${baseUrl}/events/slug/${encodeURIComponent(slug)}`,
      options,
    );
  } catch (err) {
    if (err instanceof GammaFetchError && err.code !== "NOT_FOUND") {
      throw err;
    }
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
  gammaDelayMs?: number;
}): Promise<MarketData> {
  const gammaBaseUrl = params.gammaBaseUrl ?? DEFAULT_GAMMA_BASE_URL;
  const delayMs = params.gammaDelayMs ?? 0;
  const fetchOptions = { signal: params.signal, delayMs };
  let market: Record<string, unknown>;
  let resolvedVia: string | undefined;
  const normalizeMarket = (
    raw: Record<string, unknown>,
    fallbackSlug?: string,
    resolvedVia?: string,
  ): MarketData => {
    return {
      id: String(raw.id ?? raw.marketId ?? ""),
      slug: typeof raw.slug === "string" ? raw.slug : fallbackSlug,
      question: typeof raw.question === "string" ? raw.question : undefined,
      description: typeof raw.description === "string" ? raw.description : undefined,
      resolutionCriteria:
        typeof raw.resolutionCriteria === "string" ? raw.resolutionCriteria : undefined,
      endDate:
        typeof raw.endDate === "string"
          ? raw.endDate
          : typeof raw.closeDate === "string"
            ? raw.closeDate
            : undefined,
      category: typeof raw.category === "string" ? raw.category : undefined,
      subcategory: typeof raw.subcategory === "string" ? raw.subcategory : undefined,
      outcomes: normalizeStringArray(raw.outcomes),
      outcomePrices: normalizeNumberArray(raw.outcomePrices),
      sides: undefined,
      bbo: undefined,
      raw,
      resolvedVia,
    };
  };

  const lookupBySlug = async (inputSlug: string): Promise<MarketData> => {
    if (inputSlug.includes("/")) {
      const [eventPart, marketPart] = inputSlug.split("/", 2);
      const event = await fetchEventBySlug(eventPart, gammaBaseUrl, fetchOptions);
      const markets = Array.isArray((event as { markets?: unknown }).markets)
        ? ((event as { markets?: unknown }).markets as Record<string, unknown>[])
        : [];
      if (markets.length === 0) {
        throw new GammaFetchError("Event has no markets.", {
          retryable: false,
          code: "NOT_FOUND",
        });
      }
      const selected = markets.find(
        (m) => typeof m.slug === "string" && m.slug === marketPart,
      );
      if (!selected) {
        throw new GammaFetchError("Market not found in event.", {
          retryable: false,
          code: "NOT_FOUND",
        });
      }
      const marketSlug = typeof selected.slug === "string" ? selected.slug : undefined;
      const marketId = typeof selected.id === "string" ? selected.id : undefined;
      if (marketSlug) {
        const fullMarket = await fetchMarketBySlug(marketSlug, gammaBaseUrl, fetchOptions);
        return normalizeMarket(fullMarket, marketSlug, "event_market_slug");
      }
      if (marketId) {
        const fullMarket = await fetchMarketById(marketId, gammaBaseUrl, fetchOptions);
        return normalizeMarket(fullMarket, marketPart, "event_market_id");
      }
      return normalizeMarket(selected, marketPart, "event_market_inline");
    }

    try {
      const directMarket = await fetchMarketBySlug(inputSlug, gammaBaseUrl, fetchOptions);
      return normalizeMarket(directMarket, inputSlug, "market_slug");
    } catch (err) {
      if (!(err instanceof GammaFetchError) || err.code !== "NOT_FOUND") {
        throw err;
      }
    }

    const event = await fetchEventBySlug(inputSlug, gammaBaseUrl, fetchOptions);
    const markets = Array.isArray((event as { markets?: unknown }).markets)
      ? ((event as { markets?: unknown }).markets as Record<string, unknown>[])
      : [];
    if (markets.length === 0) {
      throw new GammaFetchError("Event has no markets.", {
        retryable: false,
        code: "NOT_FOUND",
      });
    }
    const index = params.marketIndex ?? 0;
    if (index < 0 || index >= markets.length) {
      throw new Error(`Event market index out of range. Max index: ${markets.length - 1}`);
    }
    const selected = markets[index];
    const marketSlug = typeof selected.slug === "string" ? selected.slug : undefined;
    const marketId = typeof selected.id === "string" ? selected.id : undefined;
    if (marketSlug) {
      const fullMarket = await fetchMarketBySlug(marketSlug, gammaBaseUrl, fetchOptions);
      return normalizeMarket(fullMarket, marketSlug, "event_index");
    }
    if (marketId) {
      const fullMarket = await fetchMarketById(marketId, gammaBaseUrl, fetchOptions);
      return normalizeMarket(fullMarket, inputSlug, "event_index");
    }
    return normalizeMarket(selected, inputSlug, "event_index");
  };

  if (params.id) {
    market = await fetchMarketById(params.id, gammaBaseUrl, fetchOptions);
    resolvedVia = "market_id";
  } else if (params.slug) {
    return await lookupBySlug(params.slug);
  } else if (params.eventSlug) {
    return await lookupBySlug(params.eventSlug);
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
    resolvedVia,
  };
}
