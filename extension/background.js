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
  } catch (err) {
    console.error("Analyzer request failed.", err);
  }
});
