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

const estimateEl = document.getElementById("estimate");
const rangeEl = document.getElementById("range");
const confidenceEl = document.getElementById("confidence");
const takeEl = document.getElementById("take");
const driversProEl = document.getElementById("driversPro");
const driversConEl = document.getElementById("driversCon");
const cacheHitEl = document.getElementById("cacheHit");
const cacheExpiresEl = document.getElementById("cacheExpires");
const requestIdEl = document.getElementById("requestId");

const errorStepEl = document.getElementById("errorStep");
const errorCodeEl = document.getElementById("errorCode");
const errorMessageEl = document.getElementById("errorMessage");
const errorHintEl = document.getElementById("errorHint");
const errorRequestIdEl = document.getElementById("errorRequestId");

const serviceUrlInput = document.getElementById("serviceUrl");
const saveServiceButton = document.getElementById("saveService");
const testHealthButton = document.getElementById("testHealth");
const serviceStatusEl = document.getElementById("serviceStatus");
const copyDebugButton = document.getElementById("copyDebug");
const clearDataButton = document.getElementById("clearData");

let uiState = UiStates.IDLE;
let serviceOk = false;
let onPolymarket = false;
let lastErrorLabel = null;

function dashIfEmpty(value) {
  if (value === null || value === undefined) return "—";
  if (typeof value === "string") return value.trim() === "" ? "—" : value;
  return String(value);
}

function formatUpdated(timestamp) {
  if (!timestamp) return "—";
  try {
    return new Date(timestamp).toLocaleString();
  } catch {
    return "—";
  }
}

function formatLines(value, maxLines = 2) {
  if (!value) return "—";
  if (Array.isArray(value)) {
    const lines = value.filter(Boolean).slice(0, maxLines);
    return lines.length ? lines.join("\n") : "—";
  }
  if (typeof value === "string") {
    const lines = value
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(0, maxLines);
    return lines.length ? lines.join("\n") : "—";
  }
  return "—";
}

function setStatus(text, isError = false) {
  statusEl.textContent = text;
  statusEl.classList.toggle("error", isError);
  statusEl.classList.toggle("muted", !isError);
}

function applyUiState() {
  const ui = deriveUi(uiState, { serviceOk, onPolymarket, errorLabel: lastErrorLabel });
  setStatus(ui.status, ui.isError);

  const controls = computeControls({
    state: uiState,
    serviceOk,
    onPolymarket,
    errorLabel: lastErrorLabel,
  });
  runButton.disabled = controls.analyzeDisabled;
  cancelButton.classList.toggle("hidden", !controls.showCancel);
  retryButton.classList.toggle("hidden", !controls.showRetry);
}

function renderMeta(slug, updated) {
  const slugText = slug ? `Slug: ${slug}` : "Slug: —";
  const updatedText = updated ? `Updated: ${formatUpdated(updated)}` : "Updated: —";
  metaEl.textContent = `${slugText} · ${updatedText}`;
}

function renderError(lastAnalysis, lastErrorMessage, lastErrorHint) {
  successEl.classList.add("hidden");
  errorEl.classList.remove("hidden");

  errorRequestIdEl.textContent = dashIfEmpty(lastAnalysis?.request_id);
  errorStepEl.textContent = dashIfEmpty(lastAnalysis?.step);
  errorCodeEl.textContent = dashIfEmpty(lastAnalysis?.error_code);
  errorMessageEl.textContent = dashIfEmpty(lastErrorMessage ?? lastAnalysis?.message ?? "Analysis failed.");
  errorHintEl.textContent = dashIfEmpty(lastErrorHint ?? "Try again or restart the service.");
}

function renderSuccess(lastAnalysis) {
  errorEl.classList.add("hidden");
  successEl.classList.remove("hidden");

  const quickView = lastAnalysis?.quick_view ?? {};
  const cache = lastAnalysis?.cache ?? {};

  requestIdEl.textContent = dashIfEmpty(lastAnalysis?.request_id);
  estimateEl.textContent = dashIfEmpty(quickView?.estimate_yes_pct ?? quickView?.estimate_yes);
  rangeEl.textContent = dashIfEmpty(quickView?.range_yes_pct ?? quickView?.range_yes);
  confidenceEl.textContent = dashIfEmpty(quickView?.confidence);
  takeEl.textContent = dashIfEmpty(quickView?.one_sentence_take ?? quickView?.summary);
  driversProEl.textContent = formatLines(quickView?.top_drivers_pro ?? quickView?.drivers_pro);
  driversConEl.textContent = formatLines(quickView?.top_drivers_con ?? quickView?.drivers_con);
  cacheHitEl.textContent = dashIfEmpty(cache?.hit);
  cacheExpiresEl.textContent = dashIfEmpty(cache?.expires_at_utc);
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
    renderError(lastAnalysis, lastErrorMessage, lastErrorHint);
  } else {
    renderSuccess(lastAnalysis);
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
  ]);
  renderAnalysis(data);
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
  } catch (err) {
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
  await chrome.storage.local.set({ service_url: url });
  serviceUrlInput.value = url;
  await syncAvailability();
}

async function copyDebug() {
  const data = await chrome.storage.local.get([
    "last_analysis",
    "last_slug",
    "last_updated",
    "service_url",
    "last_service_version",
  ]);
  const analysis = data?.last_analysis ?? {};
  const payload = {
    request_id: analysis.request_id ?? null,
    slug: data?.last_slug ?? null,
    status: analysis.status ?? null,
    timestamp_utc: analysis.timestamp_utc ?? null,
    last_updated: data?.last_updated ?? null,
    cache_expires_at_utc: analysis?.cache?.expires_at_utc ?? null,
    service_url: (data?.service_url || DEFAULT_SERVICE_BASE).replace(/\/$/, ""),
    extension_version: EXTENSION_VERSION,
    service_version: data?.last_service_version ?? null,
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
  } catch (err) {
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

async function syncAvailability() {
  uiState = transition(uiState, "CHECK_START");
  applyUiState();

  const [tab, health] = await Promise.all([getActiveTab(), healthCheckViaBackground()]);
  renderServiceStatus(health);

  serviceOk = health.ok;
  onPolymarket = Boolean(tab?.id && isPolymarketEventUrl(tab.url));

  if (health?.payload?.service_version) {
    await chrome.storage.local.set({ last_service_version: health.payload.service_version });
    serviceVersionEl.textContent = dashIfEmpty(health.payload.service_version);
  }

  uiState = transition(uiState, health.ok ? "CHECK_OK" : "CHECK_FAIL");
  applyUiState();
}

loadFromStorage();
syncAvailability();
