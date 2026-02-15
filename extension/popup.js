const DEFAULT_SERVICE_BASE = "http://127.0.0.1:8787";
const EXTENSION_VERSION = chrome.runtime.getManifest().version;

import { UiStates, transition, deriveUi, computeControls } from "./popup_state.mjs";

const runButton = document.getElementById("run");
const cancelButton = document.getElementById("cancel");
const retryButton = document.getElementById("retry");
const statusEl = document.getElementById("status");
const metaEl = document.getElementById("meta");
const serviceEl = document.getElementById("service");
const serviceHintEl = document.getElementById("serviceHint");
const successEl = document.getElementById("success");
const errorEl = document.getElementById("error");
const serviceVersionEl = document.getElementById("serviceVersion");
const extensionVersionEl = document.getElementById("extensionVersion");

const yesPctEl = document.getElementById("yesPct");
const noPctEl = document.getElementById("noPct");
const confidenceEl = document.getElementById("confidence");
const contextLineEl = document.getElementById("contextLine");
const openFullReportButton = document.getElementById("openFullReport");
const errorMessageEl = document.getElementById("errorMessage");
const historyListEl = document.getElementById("historyList");
const viewAllHistoryButton = document.getElementById("viewAllHistory");

const serviceUrlInput = document.getElementById("serviceUrl");
const saveServiceButton = document.getElementById("saveService");
const testHealthButton = document.getElementById("testHealth");
const serviceStatusEl = document.getElementById("serviceStatus");
const copyDebugButton = document.getElementById("copyDebug");
const clearDataButton = document.getElementById("clearData");

let uiState = UiStates.IDLE;
let serviceOk = false;
let onPolymarket = false;
let contentReady = null;
let lastErrorLabel = null;
let currentSlug = null;
let activeTabSlug = null;

function dashIfEmpty(value) {
  if (value === null || value === undefined) return "-";
  if (typeof value === "string") return value.trim() === "" ? "-" : value;
  return String(value);
}

function formatUpdated(timestamp) {
  if (!timestamp) return "-";
  try {
    return new Date(timestamp).toLocaleString();
  } catch {
    return "-";
  }
}

function formatHistoryTime(timestampUtc) {
  if (!timestampUtc || typeof timestampUtc !== "string") return "-";
  try {
    return new Date(timestampUtc).toLocaleString([], {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "-";
  }
}

function shortSlug(slug) {
  if (typeof slug !== "string") return "-";
  const clean = slug.trim();
  if (!clean) return "-";
  return clean.length > 30 ? `${clean.slice(0, 27)}...` : clean;
}

function isAllowedServiceUrl(value) {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:") return false;
    return parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost";
  } catch {
    return false;
  }
}

function formatShortContext(value) {
  if (typeof value !== "string") return "-";
  const single = value.replace(/\s+/g, " ").trim();
  if (!single) return "-";
  return single.length > 120 ? `${single.slice(0, 117)}...` : single;
}

function formatPercentValue(value) {
  if (typeof value !== "number" || Number.isNaN(value)) return null;
  const clamped = Math.max(0, Math.min(100, value));
  const rounded = Math.round(clamped * 10) / 10;
  return Number.isInteger(rounded) ? `${rounded}%` : `${rounded.toFixed(1)}%`;
}

function setStatus(text, isError = false) {
  statusEl.textContent = text;
  statusEl.classList.toggle("error", isError);
  statusEl.classList.toggle("muted", !isError);
}

function applyUiState() {
  const ui = deriveUi(uiState, { serviceOk, onPolymarket, contentReady, errorLabel: lastErrorLabel });
  setStatus(ui.status, ui.isError);

  const controls = computeControls({
    state: uiState,
    serviceOk,
    onPolymarket,
    contentReady,
    errorLabel: lastErrorLabel,
  });
  runButton.disabled = controls.analyzeDisabled;
  cancelButton.classList.toggle("hidden", !controls.showCancel);
  retryButton.classList.toggle("hidden", !controls.showRetry);
}

function renderMeta(slug, updated) {
  currentSlug = slug || null;
  if (openFullReportButton) {
    openFullReportButton.disabled = !currentSlug;
  }
  const slugText = slug ? `Slug: ${slug}` : "Slug: -";
  const updatedText = updated ? `Updated: ${formatUpdated(updated)}` : "Updated: -";
  metaEl.textContent = `${slugText} | ${updatedText}`;
}

function renderError(lastAnalysis, lastErrorMessage, lastErrorHint) {
  successEl.classList.add("hidden");
  errorEl.classList.remove("hidden");
  errorMessageEl.textContent = dashIfEmpty(lastErrorMessage ?? lastAnalysis?.message ?? lastErrorHint ?? "Analysis failed.");
}

function renderSuccess(lastAnalysis) {
  errorEl.classList.add("hidden");
  successEl.classList.remove("hidden");

  const quickView = lastAnalysis?.quick_view ?? {};
  const yesRaw = quickView?.estimate_yes_pct ?? quickView?.estimate_yes;
  const yes = typeof yesRaw === "number" ? yesRaw : Number.parseFloat(yesRaw);
  const no = Number.isFinite(yes) ? 100 - yes : NaN;

  yesPctEl.textContent = dashIfEmpty(formatPercentValue(yes));
  noPctEl.textContent = dashIfEmpty(formatPercentValue(no));
  confidenceEl.textContent = dashIfEmpty(quickView?.confidence);
  contextLineEl.textContent = formatShortContext(quickView?.one_sentence_take ?? quickView?.summary);
}

function renderAnalysis(data) {
  renderMeta(data?.last_slug, data?.last_updated);
  const lastAnalysis = data?.last_analysis;
  const lastErrorMessage = data?.last_error_message;
  const lastErrorHint = data?.last_error_hint;

  if (!lastAnalysis) {
    successEl.classList.add("hidden");
    errorEl.classList.add("hidden");
    return;
  }

  if (lastAnalysis?.status === "error") {
    if (
      lastAnalysis?.error_code === "CONTENT_SCRIPT_UNAVAILABLE" &&
      onPolymarket &&
      contentReady === false
    ) {
      successEl.classList.add("hidden");
      errorEl.classList.add("hidden");
      return;
    }
    renderError(lastAnalysis, lastErrorMessage, lastErrorHint);
  } else {
    renderSuccess(lastAnalysis);
  }
}

function renderHistory(history) {
  const items = Array.isArray(history) ? history.slice(0, 3) : [];
  historyListEl.textContent = "";

  if (items.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.innerHTML =
      '<div class="empty-state-title">No history yet</div><div class="empty-state-copy">Run analysis on a market to populate this list.</div>';
    historyListEl.appendChild(empty);
    return;
  }

  for (const entry of items) {
    const row = document.createElement("div");
    row.className = "history-item";

    const slug = document.createElement("div");
    slug.className = "history-slug";
    slug.textContent = shortSlug(entry?.slug);

    const meta = document.createElement("div");
    meta.className = "history-meta";
    const confidence = typeof entry?.confidence === "string" ? entry.confidence : "-";
    meta.textContent = `${formatHistoryTime(entry?.timestamp_utc)} | ${confidence}`;

    const button = document.createElement("button");
    button.className = "secondary history-action";
    button.textContent = "Open full report";
    button.dataset.reportUrl = typeof entry?.report_url === "string" ? entry.report_url : "";
    button.dataset.slug = typeof entry?.slug === "string" ? entry.slug : "";
    button.disabled = !button.dataset.reportUrl && !button.dataset.slug;

    row.appendChild(slug);
    row.appendChild(meta);
    row.appendChild(button);
    historyListEl.appendChild(row);
  }
}

async function loadFromStorage() {
  const data = await chrome.storage.local.get([
    "last_analysis",
    "last_slug",
    "last_updated",
    "last_error_message",
    "last_error_hint",
    "service_url",
    "last_service_version",
    "analysis_history",
  ]);
  renderAnalysis(data);
  renderHistory(data?.analysis_history);
  if (data?.last_analysis?.status === "error" && data?.last_error_message) {
    lastErrorLabel = data.last_error_message;
  }
  if (data?.last_analysis?.status !== "error") {
    lastErrorLabel = null;
  }
  serviceUrlInput.value = (data?.service_url || DEFAULT_SERVICE_BASE).replace(/\/$/, "");
  serviceVersionEl.textContent = dashIfEmpty(data?.last_service_version);
  extensionVersionEl.textContent = dashIfEmpty(EXTENSION_VERSION);
}

function isPolymarketEventUrl(url) {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    if (!parsed.hostname.endsWith("polymarket.com")) return false;
    return parsed.pathname.startsWith("/event/");
  } catch {
    return false;
  }
}

function extractPolymarketSlug(url) {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (!parsed.hostname.endsWith("polymarket.com")) return null;
    const marker = "/event/";
    const idx = parsed.pathname.indexOf(marker);
    if (idx === -1) return null;
    const slug = parsed.pathname.slice(idx + marker.length).replace(/^\/+|\/+$/g, "");
    return slug || null;
  } catch {
    return null;
  }
}

function shortError(text) {
  if (!text) return "Offline";
  return text.length > 80 ? `${text.slice(0, 77)}...` : text;
}

function renderServiceStatus({ ok, error, payload }) {
  if (ok) {
    serviceEl.textContent = "Service: online";
    serviceEl.classList.remove("error");
    serviceHintEl.classList.add("hidden");
    serviceStatusEl.textContent = "Online";
    serviceStatusEl.classList.add("muted");
    if (payload?.service_version) {
      serviceVersionEl.textContent = dashIfEmpty(payload.service_version);
    }
    return;
  }

  const message = shortError(error ?? "Offline");
  serviceEl.textContent = "Service: offline";
  serviceEl.classList.add("error");
  serviceHintEl.classList.remove("hidden");
  serviceStatusEl.textContent = `Offline: ${message}`;
  serviceStatusEl.classList.remove("muted");
}

async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs && tabs.length > 0 ? tabs[0] : null;
}

async function healthCheckViaBackground() {
  const response = await chrome.runtime.sendMessage({ type: "HEALTH_CHECK" });
  if (!response?.ok) {
    return { ok: false, error: response?.error ?? "Health check failed." };
  }
  return { ok: true, payload: response.payload };
}

async function checkContentReadyViaBackground() {
  const response = await chrome.runtime.sendMessage({ type: "CHECK_CONTENT_SCRIPT" });
  if (!response?.ok) {
    return { ok: false, ready: false };
  }
  return { ok: true, ready: response?.ready === true };
}

async function runAnalysisViaBackground() {
  const response = await chrome.runtime.sendMessage({ type: "RUN_ANALYSIS" });
  if (!response?.ok) {
    if (response?.cancelled) {
      return response;
    }
    throw new Error(response?.error ?? "Background analysis failed.");
  }
  return response;
}

async function cancelAnalysisViaBackground() {
  const response = await chrome.runtime.sendMessage({ type: "CANCEL_ANALYSIS" });
  if (!response?.ok) {
    throw new Error(response?.error ?? "No active analysis.");
  }
  return response;
}

async function getServiceBase() {
  const data = await chrome.storage.local.get(["service_url"]);
  const raw = typeof data?.service_url === "string" ? data.service_url.trim() : "";
  if (!raw) return DEFAULT_SERVICE_BASE;
  return raw.replace(/\/$/, "");
}

async function openFullReport() {
  const slug = activeTabSlug || currentSlug;
  if (!slug) return;
  const base = await getServiceBase();
  const data = await chrome.storage.local.get(["last_analysis", "last_slug"]);
  const payload = data?.last_slug === slug ? data?.last_analysis : null;
  const hash = payload ? `#payload=${encodeURIComponent(JSON.stringify(payload))}` : "";
  const url = `${base}/report?slug=${encodeURIComponent(slug)}${hash}`;
  await chrome.tabs.create({ url });
}

async function openHistoryEntryReport(reportUrl, slug) {
  if (typeof reportUrl === "string" && reportUrl.trim()) {
    await chrome.tabs.create({ url: reportUrl.trim() });
    return;
  }
  if (!slug) return;
  const base = await getServiceBase();
  await chrome.tabs.create({ url: `${base}/report?slug=${encodeURIComponent(slug)}` });
}

async function openFullHistory() {
  const [base, data] = await Promise.all([
    getServiceBase(),
    chrome.storage.local.get(["analysis_history"]),
  ]);
  const history = Array.isArray(data?.analysis_history) ? data.analysis_history : [];
  const hash = `#history=${encodeURIComponent(JSON.stringify(history))}`;
  await chrome.tabs.create({ url: `${base}/history${hash}` });
}

async function runAnalysis() {
  if (uiState === UiStates.ANALYZING) {
    return;
  }

  uiState = transition(uiState, "ANALYZE_START");
  lastErrorLabel = null;
  applyUiState();

  try {
    const response = await runAnalysisViaBackground();
    if (response?.cancelled) {
      uiState = transition(uiState, "ANALYZE_ERROR");
      lastErrorLabel = "Cancelled";
    } else if (response?.resultStatus === "error") {
      uiState = transition(uiState, "ANALYZE_ERROR");
      lastErrorLabel = "Error";
    } else {
      uiState = transition(uiState, "ANALYZE_DONE");
    }
    await loadFromStorage();
    if (response?.cancelled) {
      lastErrorLabel = "Cancelled";
    }
  } catch {
    uiState = transition(uiState, "ANALYZE_ERROR");
    lastErrorLabel = "Error";
    await loadFromStorage();
  } finally {
    applyUiState();
  }
}

async function saveServiceUrl() {
  const raw = serviceUrlInput.value.trim();
  const url = raw.length > 0 ? raw.replace(/\/$/, "") : DEFAULT_SERVICE_BASE;
  if (!isAllowedServiceUrl(url)) {
    serviceStatusEl.textContent = "Use http://127.0.0.1:<port> or http://localhost:<port>";
    serviceStatusEl.classList.remove("muted");
    return;
  }
  await chrome.storage.local.set({ service_url: url });
  serviceUrlInput.value = url;
  await syncAvailability();
}

async function copyDebug() {
  let runtimeDebug = null;
  try {
    const response = await chrome.runtime.sendMessage({ type: "DEBUG_SNAPSHOT" });
    if (response?.ok) {
      runtimeDebug = response.snapshot ?? null;
    } else {
      runtimeDebug = { error: response?.error ?? "Failed to collect runtime debug snapshot." };
    }
  } catch (err) {
    runtimeDebug = { error: err?.message ?? String(err) };
  }

  const data = await chrome.storage.local.get([
    "last_analysis",
    "last_slug",
    "last_updated",
    "service_url",
    "last_service_version",
    "analysis_history",
  ]);
  const analysis = data?.last_analysis ?? {};
  const payload = {
    request_id: analysis.request_id ?? null,
    slug: data?.last_slug ?? null,
    status: analysis.status ?? null,
    timestamp_utc: analysis.timestamp_utc ?? null,
    last_updated: data?.last_updated ?? null,
    cache_expires_at_utc: analysis?.cache?.expires_at_utc ?? null,
    sources_count: Array.isArray(analysis?.sources) ? analysis.sources.length : 0,
    sources_missing: analysis?.sources_missing === true,
    service_url: (data?.service_url || DEFAULT_SERVICE_BASE).replace(/\/$/, ""),
    extension_version: EXTENSION_VERSION,
    service_version: data?.last_service_version ?? null,
    history_count: Array.isArray(data?.analysis_history) ? data.analysis_history.length : 0,
    runtime_debug: runtimeDebug,
  };
  const text = JSON.stringify(payload, null, 2);
  await navigator.clipboard.writeText(text);
  serviceStatusEl.textContent = "Copied debug info";
  serviceStatusEl.classList.add("muted");
}

async function clearData() {
  await chrome.storage.local.remove([
    "last_analysis",
    "last_slug",
    "last_updated",
    "last_error_message",
    "last_error_hint",
    "analysis_history",
  ]);
  lastErrorLabel = null;
  uiState = UiStates.IDLE;
  await loadFromStorage();
  await syncAvailability();
}

async function testHealth() {
  saveServiceButton.disabled = true;
  testHealthButton.disabled = true;
  uiState = transition(uiState, "CHECK_START");
  applyUiState();

  const health = await healthCheckViaBackground();
  renderServiceStatus(health);
  serviceOk = health.ok;
  uiState = transition(uiState, health.ok ? "CHECK_OK" : "CHECK_FAIL");
  applyUiState();

  saveServiceButton.disabled = false;
  testHealthButton.disabled = false;
}

runButton.addEventListener("click", runAnalysis);
cancelButton.addEventListener("click", async () => {
  if (uiState !== UiStates.ANALYZING) {
    return;
  }
  try {
    await cancelAnalysisViaBackground();
    uiState = transition(uiState, "ANALYZE_ERROR");
    lastErrorLabel = "Cancelled";
  } catch {
    uiState = transition(uiState, "ANALYZE_ERROR");
    lastErrorLabel = "Error";
  } finally {
    applyUiState();
  }
});
retryButton.addEventListener("click", runAnalysis);
saveServiceButton.addEventListener("click", saveServiceUrl);
testHealthButton.addEventListener("click", testHealth);
copyDebugButton.addEventListener("click", copyDebug);
clearDataButton.addEventListener("click", clearData);
openFullReportButton.addEventListener("click", openFullReport);
viewAllHistoryButton.addEventListener("click", openFullHistory);
historyListEl.addEventListener("click", async (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  if (!target.classList.contains("history-action")) return;
  await openHistoryEntryReport(target.dataset.reportUrl, target.dataset.slug);
});

async function syncAvailability() {
  uiState = transition(uiState, "CHECK_START");
  applyUiState();

  const [tab, health] = await Promise.all([getActiveTab(), healthCheckViaBackground()]);
  renderServiceStatus(health);

  serviceOk = health.ok;
  onPolymarket = Boolean(tab?.id && isPolymarketEventUrl(tab.url));
  activeTabSlug = onPolymarket ? extractPolymarketSlug(tab?.url) : null;
  contentReady = null;
  if (onPolymarket) {
    const content = await checkContentReadyViaBackground();
    contentReady = content.ready;
  }

  if (health?.payload?.service_version) {
    await chrome.storage.local.set({ last_service_version: health.payload.service_version });
    serviceVersionEl.textContent = dashIfEmpty(health.payload.service_version);
  }

  await loadFromStorage();
  uiState = transition(uiState, health.ok ? "CHECK_OK" : "CHECK_FAIL");
  applyUiState();
}

loadFromStorage();
syncAvailability();





