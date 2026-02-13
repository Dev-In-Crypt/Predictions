const DEFAULT_SERVICE_BASE = "http://127.0.0.1:8787";
const HEALTH_TIMEOUT_MS = 1200;
const HEALTH_POLL_MINUTES = 1;
const HEALTH_ALARM = "health_poll";
const SCHEMA_VERSION = "1.0";
const HISTORY_KEY = "analysis_history";
const HISTORY_LIMIT = 20;
const activeJobs = new Map();
let healthFailureCount = 0;
let healthOkEffective = true;

async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs && tabs.length > 0 ? tabs[0] : null;
}

async function requestSlug(tabId) {
  return await chrome.tabs.sendMessage(tabId, { type: "GET_POLYMARKET_SLUG" });
}

async function requestPageSource(tabId) {
  return await chrome.tabs.sendMessage(tabId, { type: "GET_PAGE_SOURCE" });
}

async function pingContentScript(tabId) {
  return await chrome.tabs.sendMessage(tabId, { type: "PING_CONTENT_SCRIPT" });
}

async function fetchJsonWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new Error("Non-JSON response.");
    }
  } finally {
    clearTimeout(timeoutId);
  }
}

async function getServiceBase() {
  const stored = await chrome.storage.local.get(["service_url"]);
  const url = stored?.service_url;
  if (typeof url === "string" && url.trim().length > 0) {
    const candidate = url.trim().replace(/\/$/, "");
    try {
      const parsed = new URL(candidate);
      const hostAllowed = parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost";
      if (parsed.protocol === "http:" && hostAllowed) {
        return candidate;
      }
    } catch {
      // Ignore invalid URL and fall back to default.
    }
  }
  return DEFAULT_SERVICE_BASE;
}

async function analyzeSlug(slug, signal, sources) {
  const base = await getServiceBase();
  const url = `${base}/analyze?slug=${encodeURIComponent(slug)}`;
  const hasSources = Array.isArray(sources) && sources.length > 0;
  const res = await fetch(url, {
    method: hasSources ? "POST" : "GET",
    headers: hasSources ? { "Content-Type": "application/json" } : undefined,
    body: hasSources ? JSON.stringify({ sources }) : undefined,
    signal,
  });
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("Non-JSON response.");
  }
}

function buildClientError(message, errorCode) {
  const timestamp = new Date().toISOString();
  return {
    status: "error",
    step: "client",
    error_code: errorCode,
    message,
    retryable: false,
    schema_version: SCHEMA_VERSION,
    timestamp_utc: timestamp,
    resolved_via: "event_index",
    cache: { hit: false, ttl_sec: 0, expires_at_utc: timestamp },
  };
}

function compactSuccess(result) {
  return {
    quick_view: result?.quick_view ?? null,
    cache: result?.cache ?? null,
    schema_version: result?.schema_version ?? null,
    timestamp_utc: result?.timestamp_utc ?? null,
    resolved_via: result?.resolved_via ?? null,
    request_id: result?.request_id ?? null,
    sources: Array.isArray(result?.sources) ? result.sources : [],
    sources_used_count:
      typeof result?.sources_used_count === "number" ? result.sources_used_count : 0,
    sources_missing: result?.sources_missing === true,
  };
}

function compactError(result) {
  return {
    status: "error",
    step: result?.step ?? null,
    error_code: result?.error_code ?? null,
    message: result?.message ?? null,
    retryable: result?.retryable ?? false,
    schema_version: result?.schema_version ?? null,
    timestamp_utc: result?.timestamp_utc ?? null,
    resolved_via: result?.resolved_via ?? null,
    cache: result?.cache ?? null,
    request_id: result?.request_id ?? null,
  };
}

function compactResult(result) {
  if (result?.status === "error") {
    return compactError(result);
  }
  return compactSuccess(result);
}

function clampPercent(value) {
  if (typeof value !== "number" || Number.isNaN(value)) return null;
  return Math.max(0, Math.min(100, Math.round(value * 1000) / 1000));
}

function toPercent(value) {
  if (typeof value === "number") return clampPercent(value);
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    return clampPercent(parsed);
  }
  return null;
}

function readEvidenceModeFlag(result) {
  if (!result || typeof result !== "object") return undefined;
  if (Object.prototype.hasOwnProperty.call(result, "evidence_mode")) {
    return result.evidence_mode;
  }
  const quick = result.quick_view;
  if (quick && typeof quick === "object" && Object.prototype.hasOwnProperty.call(quick, "evidence_mode")) {
    return quick.evidence_mode;
  }
  return undefined;
}

function buildHistoryEntry({ slug, result, serviceBase }) {
  const quick = result?.quick_view ?? {};
  const yes = toPercent(quick?.estimate_yes_pct ?? quick?.estimate_yes);
  const no = yes === null ? null : clampPercent(100 - yes);
  const evidenceMode = readEvidenceModeFlag(result);
  const entry = {
    slug,
    timestamp_utc: new Date().toISOString(),
    yes_percent: yes,
    no_percent: no,
    confidence: typeof quick?.confidence === "string" ? quick.confidence : null,
    request_id: result?.request_id ?? null,
    cache_expires_at_utc:
      typeof result?.cache?.expires_at_utc === "string" ? result.cache.expires_at_utc : null,
    service_url: serviceBase,
    report_url: `${serviceBase}/report?slug=${encodeURIComponent(slug)}`,
  };
  if (evidenceMode !== undefined) {
    entry.evidence_mode = evidenceMode;
  }
  return entry;
}

async function upsertHistoryEntry(entry) {
  const stored = await chrome.storage.local.get([HISTORY_KEY]);
  const history = Array.isArray(stored?.[HISTORY_KEY]) ? stored[HISTORY_KEY] : [];
  const next = [entry, ...history.filter((item) => item?.slug !== entry.slug)].slice(0, HISTORY_LIMIT);
  await chrome.storage.local.set({ [HISTORY_KEY]: next });
}

async function recordHistorySuccess(slug, result) {
  if (!slug || !result || result?.status === "error") return;
  const serviceBase = await getServiceBase();
  const entry = buildHistoryEntry({ slug, result, serviceBase });
  await upsertHistoryEntry(entry);
}

function isValidHealthPayload(payload) {
  if (!payload || typeof payload !== "object") return false;
  if (payload.ok !== true) return false;
  if (payload.status !== "ok") return false;
  if (typeof payload.service_version !== "string") return false;
  if (typeof payload.time_utc !== "string") return false;
  if (typeof payload.uptime_sec !== "number") return false;
  if (Number.isNaN(Date.parse(payload.time_utc))) return false;
  return true;
}

function setBadgeOff() {
  chrome.action.setBadgeText({ text: "OFF" });
  chrome.action.setBadgeBackgroundColor({ color: "#6B7280" });
}

function setBadgeErr() {
  chrome.action.setBadgeText({ text: "ERR" });
  chrome.action.setBadgeBackgroundColor({ color: "#B91C1C" });
}

function clearBadge() {
  chrome.action.setBadgeText({ text: "" });
}

function recordHealth(healthOk) {
  if (healthOk) {
    healthFailureCount = 0;
    healthOkEffective = true;
    return healthOkEffective;
  }
  healthFailureCount += 1;
  if (healthFailureCount >= 2) {
    healthOkEffective = false;
  }
  return healthOkEffective;
}

function getHealthEffective() {
  return healthOkEffective;
}

async function evaluateBadge({ healthOk, analysisStatus }) {
  if (!healthOk) {
    setBadgeOff();
    return;
  }
  if (analysisStatus === "error") {
    setBadgeErr();
    return;
  }
  clearBadge();
}

function getStoredAnalysisStatus(stored) {
  const analysis = stored?.last_analysis;
  if (!analysis) return undefined;
  return analysis?.status;
}

async function checkHealth() {
  try {
    const base = await getServiceBase();
    const payload = await fetchJsonWithTimeout(`${base}/health`, HEALTH_TIMEOUT_MS);
    if (!isValidHealthPayload(payload)) {
      return { ok: false, error: "Bad health payload." };
    }
    return { ok: true, payload };
  } catch (err) {
    return { ok: false, error: err?.message ?? String(err) };
  }
}

async function initializeBadge() {
  const [health, stored] = await Promise.all([
    checkHealth(),
    chrome.storage.local.get(["last_analysis"]),
  ]);
  const analysisStatus = getStoredAnalysisStatus(stored);
  const effectiveHealth = recordHealth(health.ok);
  await evaluateBadge({ healthOk: effectiveHealth, analysisStatus });
}

async function pollHealthAndUpdate() {
  const [health, stored] = await Promise.all([
    checkHealth(),
    chrome.storage.local.get(["last_analysis"]),
  ]);
  const effectiveHealth = recordHealth(health.ok);
  await evaluateBadge({ healthOk: effectiveHealth, analysisStatus: getStoredAnalysisStatus(stored) });
  await chrome.storage.local.set({
    last_service_ok: health.ok,
    last_service_checked: Date.now(),
    last_service_version: health.ok ? health.payload?.service_version ?? null : null,
  });
}

async function storeError({ slug, message, hint, errorCode, setOfflineBadge, badgeStatus }) {
  const errorPayload = buildClientError(message, errorCode);
  await chrome.storage.local.set({
    last_analysis: errorPayload,
    last_slug: slug ?? null,
    last_updated: Date.now(),
    last_error_message: message,
    last_error_hint: hint,
  });
  await notifyResult(slug ?? "", errorPayload);
  await evaluateBadge({
    healthOk: getHealthEffective(),
    analysisStatus: badgeStatus ?? "error",
  });
}

async function notifyResult(slug, result) {
  const isError = result?.status === "error";
  const title = isError ? "Analysis failed" : "Analysis ready";
  const confidence = result?.quick_view?.confidence;
  const message = isError
    ? result?.message ?? "Analyzer returned an error."
    : `${slug}${confidence ? ` (${confidence})` : ""}`;

  chrome.action.setTitle({ title: `${title}: ${message}` });
}

function isFreshCache(result) {
  const expiresAt = result?.cache?.expires_at_utc;
  if (!expiresAt || typeof expiresAt !== "string") return false;
  const expiresMs = Date.parse(expiresAt);
  if (Number.isNaN(expiresMs)) return false;
  return Date.now() < expiresMs;
}

async function getCachedResult(slug) {
  const stored = await chrome.storage.local.get(["last_analysis", "last_slug"]);
  if (!stored?.last_analysis || stored?.last_slug !== slug) return null;
  if (stored.last_analysis?.status === "error") return null;
  if (!isFreshCache(stored.last_analysis)) return null;
  return stored.last_analysis;
}

function cancelActiveJob(tabId, reason) {
  const job = activeJobs.get(tabId);
  if (!job) return false;
  job.cancelled = true;
  job.controller.abort(reason);
  activeJobs.delete(tabId);
  return true;
}

function isAbortLike(err) {
  if (!err) return false;
  const name = err?.name ?? "";
  const message = err?.message ?? "";
  if (name === "AbortError") return true;
  const lower = String(message).toLowerCase();
  return lower.includes("superseded") || lower.includes("cancelled") || lower.includes("canceled");
}

self.addEventListener("unhandledrejection", (event) => {
  if (isAbortLike(event?.reason)) {
    event.preventDefault();
  }
});

self.addEventListener("error", (event) => {
  const message = event?.message ?? "";
  if (isAbortLike({ message })) {
    event.preventDefault();
  }
});

async function runAnalysisForActiveTab() {
  const tab = await getActiveTab();
  if (!tab?.id) {
    await storeError({
      slug: null,
      message: "No active tab found.",
      hint: "Open a Polymarket event page and try again.",
      errorCode: "NO_ACTIVE_TAB",
      setOfflineBadge: false,
      badgeStatus: "error",
    });
    return { ok: false, error: "No active tab found." };
  }

  let slug;
  try {
    const response = await requestSlug(tab.id);
    slug = response?.slug;
  } catch (err) {
    await storeError({
      slug: null,
      message: "Failed to contact content script.",
      hint: "Reload the Polymarket page and try again.",
      errorCode: "CONTENT_SCRIPT_UNAVAILABLE",
      setOfflineBadge: false,
      badgeStatus: "error",
    });
    return { ok: false, error: "Failed to contact content script." };
  }

  if (!slug) {
    await storeError({
      slug: null,
      message: "No Polymarket slug found.",
      hint: "Open a Polymarket event page and try again.",
      errorCode: "MISSING_SLUG",
      setOfflineBadge: false,
      badgeStatus: "error",
    });
    return { ok: false, error: "No Polymarket slug found." };
  }

  cancelActiveJob(tab.id, "superseded");

  const cached = await getCachedResult(slug);
  if (cached) {
    await recordHistorySuccess(slug, cached);
    await notifyResult(slug, cached);
    await evaluateBadge({ healthOk: getHealthEffective(), analysisStatus: cached?.status });
    return { ok: true, resultStatus: cached?.status ?? "success", cached: true };
  }

  const controller = new AbortController();
  const jobId = `${tab.id}-${Date.now()}`;
  activeJobs.set(tab.id, { controller, jobId, slug, cancelled: false });

  try {
    let sources = [];
    try {
      const page = await requestPageSource(tab.id);
      const source = page?.source;
      const url = typeof source?.url === "string" ? source.url.trim() : "";
      if (url) {
        let domain = "";
        try {
          domain = new URL(url).hostname.replace(/^www\./, "");
        } catch {
          domain = "";
        }
        sources = [
          {
            source_id: `page:polymarket:${slug}`,
            url,
            title: typeof source?.title === "string" ? source.title.trim() : undefined,
            snippet: typeof source?.snippet === "string" ? source.snippet.trim() : undefined,
            description: typeof source?.description === "string" ? source.description.trim() : undefined,
            resolution_criteria:
              typeof source?.resolution_criteria === "string" ? source.resolution_criteria.trim() : undefined,
            captured_at_utc:
              typeof source?.captured_at_utc === "string" ? source.captured_at_utc.trim() : new Date().toISOString(),
            domain: domain || undefined,
            tier: "tier1",
            type: "page",
            label: "Polymarket event page",
          },
        ];
      }
    } catch (err) {
      sources = [];
    }

    const result = await analyzeSlug(slug, controller.signal, sources);
    if (activeJobs.get(tab.id)?.jobId === jobId) {
      activeJobs.delete(tab.id);
    }
    const compact = compactResult(result);
    await chrome.storage.local.set({
      last_analysis: compact,
      last_slug: slug,
      last_updated: Date.now(),
      last_error_message: null,
      last_error_hint: null,
    });
    await recordHistorySuccess(slug, compact);

    if (compact?.status === "error") {
      await chrome.storage.local.set({
        last_error_message: compact?.message ?? "Analyzer returned an error.",
        last_error_hint: "Try again or restart the service.",
      });
    }

    await notifyResult(slug, compact);
    await evaluateBadge({ healthOk: getHealthEffective(), analysisStatus: compact?.status });
    return { ok: true, resultStatus: compact?.status ?? "success", cached: false };
  } catch (err) {
    if (activeJobs.get(tab.id)?.jobId === jobId) {
      activeJobs.delete(tab.id);
    }
    if (controller.signal.aborted) {
      return { ok: false, cancelled: true };
    }
    await storeError({
      slug,
      message: "Analyzer request failed.",
      hint: "Run: npm run service",
      errorCode: "ANALYZER_UNREACHABLE",
      setOfflineBadge: false,
      badgeStatus: "error",
    });
    return { ok: false, error: "Analyzer request failed." };
  }
}

chrome.runtime.onInstalled.addListener(() => {
  initializeBadge();
  chrome.alarms.create(HEALTH_ALARM, { periodInMinutes: HEALTH_POLL_MINUTES });
});

chrome.runtime.onStartup.addListener(() => {
  initializeBadge();
  chrome.alarms.create(HEALTH_ALARM, { periodInMinutes: HEALTH_POLL_MINUTES });
});

initializeBadge();
chrome.alarms.create(HEALTH_ALARM, { periodInMinutes: HEALTH_POLL_MINUTES });

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm?.name === HEALTH_ALARM) {
    pollHealthAndUpdate();
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.service_url) {
    pollHealthAndUpdate();
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "RUN_ANALYSIS") {
    (async () => {
      return await runAnalysisForActiveTab();
    })()
      .then(sendResponse)
      .catch((err) => {
        if (isAbortLike(err)) {
          sendResponse({ ok: false, cancelled: true });
          return;
        }
        sendResponse({ ok: false, error: err?.message ?? String(err) });
      });
    return true;
  }

  if (message?.type === "HEALTH_CHECK") {
    (async () => {
      const health = await checkHealth();
      const stored = await chrome.storage.local.get(["last_analysis"]);
      const effectiveHealth = recordHealth(health.ok);
      await evaluateBadge({ healthOk: effectiveHealth, analysisStatus: getStoredAnalysisStatus(stored) });
      await chrome.storage.local.set({
        last_service_ok: health.ok,
        last_service_checked: Date.now(),
        last_service_version: health.ok ? health.payload?.service_version ?? null : null,
      });
      return { ok: health.ok, payload: health.payload, error: health.error };
    })()
      .then(sendResponse)
      .catch((err) => {
        sendResponse({ ok: false, error: err?.message ?? String(err) });
      });
    return true;
  }

  if (message?.type === "CANCEL_ANALYSIS") {
    (async () => {
      const tab = await getActiveTab();
      if (!tab?.id) {
        return { ok: false, error: "No active tab." };
      }
      const cancelled = cancelActiveJob(tab.id, "cancelled");
      if (!cancelled) {
        return { ok: false, error: "No active analysis." };
      }
      return { ok: true, cancelled: true };
    })()
      .then(sendResponse)
      .catch((err) => {
        sendResponse({ ok: false, error: err?.message ?? String(err) });
      });
    return true;
  }

  if (message?.type === "CHECK_CONTENT_SCRIPT") {
    (async () => {
      const tab = await getActiveTab();
      if (!tab?.id) {
        return { ok: false, ready: false, error: "No active tab." };
      }
      try {
        const response = await pingContentScript(tab.id);
        return { ok: true, ready: response?.ok === true };
      } catch {
        return { ok: true, ready: false };
      }
    })()
      .then(sendResponse)
      .catch((err) => {
        sendResponse({ ok: false, ready: false, error: err?.message ?? String(err) });
      });
    return true;
  }
});
