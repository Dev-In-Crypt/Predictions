async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs && tabs.length > 0 ? tabs[0] : null;
}

async function requestSlug(tabId) {
  return await chrome.tabs.sendMessage(tabId, { type: "GET_POLYMARKET_SLUG" });
}

async function analyzeSlug(slug) {
  const url = `http://127.0.0.1:8787/analyze?slug=${encodeURIComponent(slug)}`;
  const res = await fetch(url);
  return await res.json();
}

async function notifyResult(slug, result) {
  const isError = result?.status === "error";
  const title = isError ? "Analysis failed" : "Analysis ready";
  const confidence = result?.quick_view?.confidence;
  const message = isError
    ? result?.message ?? "Analyzer returned an error."
    : `${slug}${confidence ? ` (${confidence})` : ""}`;

  chrome.action.setBadgeText({ text: isError ? "ERR" : "OK" });
  chrome.action.setBadgeBackgroundColor({ color: isError ? "#B91C1C" : "#15803D" });
  chrome.action.setTitle({ title: `${title}: ${message}` });
  setTimeout(() => chrome.action.setBadgeText({ text: "" }), 2500);
}

async function runAnalysisForActiveTab() {
  const tab = await getActiveTab();
  if (!tab?.id) {
    throw new Error("No active tab found.");
  }

  let slug;
  try {
    const response = await requestSlug(tab.id);
    slug = response?.slug;
  } catch (err) {
    throw new Error("Failed to contact content script.");
  }

  if (!slug) {
    throw new Error("No Polymarket slug found on this page.");
  }

  try {
    const result = await analyzeSlug(slug);
    await chrome.storage.local.set({
      last_analysis: result,
      last_slug: slug,
      last_updated: Date.now(),
    });
    await notifyResult(slug, result);
    return { slug, result };
  } catch (err) {
    await notifyResult(slug, { status: "error", message: "Analyzer request failed." });
    throw err;
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== "RUN_ANALYSIS") {
    return;
  }

  (async () => {
    const data = await runAnalysisForActiveTab();
    return { ok: true, ...data };
  })()
    .then(sendResponse)
    .catch((err) => {
      console.error("Popup analysis failed.", err);
      sendResponse({ ok: false, error: err?.message ?? String(err) });
    });

  return true;
});
