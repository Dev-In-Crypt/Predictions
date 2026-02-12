const DEFAULT_SERVICE_BASE = "http://127.0.0.1:8787";
const HEALTH_TIMEOUT_MS = 1200;
const HEALTH_POLL_MINUTES = 1;
const HEALTH_ALARM = "health_poll";
const SCHEMA_VERSION = "1.0";
const activeJobs = new Map();

async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs && tabs.length > 0 ? tabs[0] : null;
}

async function requestSlug(tabId) {
  return await chrome.tabs.sendMessage(tabId, { type: "GET_POLYMARKET_SLUG" });
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
    return url.trim().replace(/\/$/, "");
  }
  return DEFAULT_SERVICE_BASE;
}

async function analyzeSlug(slug, signal) {
  const base = await getServiceBase();
  const url = `${base}/analyze?slug=${encodeURIComponent(slug)}`;
  const res = await fetch(url, { signal });
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
  await evaluateBadge({ healthOk: health.ok, analysisStatus });
}

async function pollHealthAndUpdate() {
  const [health, stored] = await Promise.all([
    checkHealth(),
    chrome.storage.local.get(["last_analysis"]),
  ]);
  await evaluateBadge({ healthOk: health.ok, analysisStatus: getStoredAnalysisStatus(stored) });
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
    healthOk: !setOfflineBadge,
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
  job.controller.abort(reason);
  activeJobs.delete(tabId);
  return true;
}

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
    throw new Error("No active tab found.");
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
    throw new Error("Failed to contact content script.");
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
    throw new Error("No Polymarket slug found.");
  }

  cancelActiveJob(tab.id, "superseded");

  const cached = await getCachedResult(slug);
  if (cached) {
    await notifyResult(slug, cached);
    await evaluateBadge({ healthOk: true, analysisStatus: cached?.status });
    return { slug, result: cached, cached: true };
  }

  const controller = new AbortController();
  const jobId = `${tab.id}-${Date.now()}`;
  activeJobs.set(tab.id, { controller, jobId, slug });

  try {
    const result = await analyzeSlug(slug, controller.signal);
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

    if (compact?.status === "error") {
      await chrome.storage.local.set({
        last_error_message: compact?.message ?? "Analyzer returned an error.",
        last_error_hint: "Try again or restart the service.",
      });
    }

    await notifyResult(slug, compact);
    await evaluateBadge({ healthOk: true, analysisStatus: compact?.status });
    return { slug, result: compact };
  } catch (err) {
    if (activeJobs.get(tab.id)?.jobId === jobId) {
      activeJobs.delete(tab.id);
    }
    if (err?.name === "AbortError" || err?.message === "superseded") {
      throw err;
    }
    await storeError({
      slug,
      message: "Analyzer request failed.",
      hint: "Run: npm run service",
      errorCode: "ANALYZER_UNREACHABLE",
      setOfflineBadge: true,
      badgeStatus: "error",
    });
    throw err;
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
      const data = await runAnalysisForActiveTab();
      return { ok: true, resultStatus: data.result?.status ?? "success", cached: data.cached ?? false };
    })()
      .then(sendResponse)
      .catch((err) => {
        if (err?.name === "AbortError" || err?.message === "superseded") {
          sendResponse({ ok: false, cancelled: true });
          return;
        }
        console.error("Popup analysis failed.", err);
        sendResponse({ ok: false, error: err?.message ?? String(err) });
      });
    return true;
  }

  if (message?.type === "HEALTH_CHECK") {
    (async () => {
      const health = await checkHealth();
      const stored = await chrome.storage.local.get(["last_analysis"]);
      await evaluateBadge({ healthOk: health.ok, analysisStatus: getStoredAnalysisStatus(stored) });
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
});
