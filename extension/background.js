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

chrome.action.onClicked.addListener(async () => {
  const tab = await getActiveTab();
  if (!tab?.id) {
    console.warn("No active tab found.");
    return;
  }

  let slug;
  try {
    const response = await requestSlug(tab.id);
    slug = response?.slug;
  } catch (err) {
    console.warn("Failed to contact content script.", err);
    return;
  }

  if (!slug) {
    console.warn("No Polymarket slug found on this page.");
    return;
  }

  try {
    const result = await analyzeSlug(slug);
    console.log("Analyzer result:", result);
    await chrome.storage.local.set({
      last_analysis: result,
      last_slug: slug,
      last_updated: Date.now(),
    });
    await notifyResult(slug, result);
  } catch (err) {
    console.error("Analyzer request failed.", err);
    await notifyResult(slug, { status: "error", message: "Analyzer request failed." });
  }
});
