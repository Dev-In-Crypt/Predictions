const runButton = document.getElementById("run");
const statusEl = document.getElementById("status");
const metaEl = document.getElementById("meta");
const successEl = document.getElementById("success");
const errorEl = document.getElementById("error");

const estimateEl = document.getElementById("estimate");
const rangeEl = document.getElementById("range");
const confidenceEl = document.getElementById("confidence");
const takeEl = document.getElementById("take");
const driversProEl = document.getElementById("driversPro");
const driversConEl = document.getElementById("driversCon");
const cacheHitEl = document.getElementById("cacheHit");
const cacheExpiresEl = document.getElementById("cacheExpires");

const errorStepEl = document.getElementById("errorStep");
const errorCodeEl = document.getElementById("errorCode");
const errorMessageEl = document.getElementById("errorMessage");

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

function renderMeta(slug, updated) {
  const slugText = slug ? `Slug: ${slug}` : "Slug: —";
  const updatedText = updated ? `Updated: ${formatUpdated(updated)}` : "Updated: —";
  metaEl.textContent = `${slugText} · ${updatedText}`;
}

function renderError(lastAnalysis) {
  successEl.classList.add("hidden");
  errorEl.classList.remove("hidden");
  errorStepEl.textContent = dashIfEmpty(lastAnalysis?.step);
  errorCodeEl.textContent = dashIfEmpty(lastAnalysis?.error_code);
  errorMessageEl.textContent = dashIfEmpty(lastAnalysis?.message);
}

function renderSuccess(lastAnalysis) {
  errorEl.classList.add("hidden");
  successEl.classList.remove("hidden");

  const quickView = lastAnalysis?.quick_view ?? {};
  const cache = lastAnalysis?.cache ?? {};

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

  if (!lastAnalysis) {
    successEl.classList.add("hidden");
    errorEl.classList.add("hidden");
    return;
  }

  if (lastAnalysis?.status === "error") {
    renderError(lastAnalysis);
  } else {
    renderSuccess(lastAnalysis);
  }
}

async function loadFromStorage() {
  const data = await chrome.storage.local.get([
    "last_analysis",
    "last_slug",
    "last_updated",
  ]);
  renderAnalysis(data);
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

async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs && tabs.length > 0 ? tabs[0] : null;
}

async function requestSlug(tabId) {
  const response = await chrome.tabs.sendMessage(tabId, { type: "GET_POLYMARKET_SLUG" });
  return response?.slug;
}

async function analyzeSlug(slug) {
  const url = `http://127.0.0.1:8787/analyze?slug=${encodeURIComponent(slug)}`;
  const res = await fetch(url);
  return await res.json();
}

async function runAnalysisViaBackground() {
  const response = await chrome.runtime.sendMessage({ type: "RUN_ANALYSIS" });
  if (!response?.ok) {
    throw new Error(response?.error ?? "Background analysis failed.");
  }
  return response;
}

async function runAnalysis() {
  runButton.disabled = true;
  setStatus("Running…");

  try {
    const tab = await getActiveTab();
    if (!tab?.id) {
      throw new Error("No active tab found.");
    }

    const slug = await requestSlug(tab.id);
    if (!slug) {
      throw new Error("No Polymarket slug found.");
    }

    let result;
    try {
      result = await analyzeSlug(slug);
    } catch (err) {
      result = null;
    }

    if (!result) {
      await runAnalysisViaBackground();
    } else {
      await chrome.storage.local.set({
        last_analysis: result,
        last_slug: slug,
        last_updated: Date.now(),
      });
    }

    setStatus("Done");
    await loadFromStorage();
  } catch (err) {
    setStatus("Error", true);
    const message = err?.message ?? "Analysis failed.";
    errorStepEl.textContent = "client";
    errorCodeEl.textContent = "popup_error";
    errorMessageEl.textContent = message;
    successEl.classList.add("hidden");
    errorEl.classList.remove("hidden");
  } finally {
    runButton.disabled = false;
  }
}

runButton.addEventListener("click", runAnalysis);

async function syncAvailability() {
  const tab = await getActiveTab();
  if (!tab?.id || !isPolymarketEventUrl(tab.url)) {
    runButton.disabled = true;
    setStatus("Open a Polymarket event page", true);
    return;
  }

  runButton.disabled = false;
  setStatus("Ready");
}

loadFromStorage();
syncAvailability();
