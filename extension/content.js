function extractPolymarketSlug(urlString) {
  try {
    const url = new URL(urlString);
    const marker = "/event/";
    const idx = url.pathname.indexOf(marker);
    if (idx === -1) return null;
    let slug = url.pathname.slice(idx + marker.length);
    slug = slug.replace(/^\/+|\/+$/g, "");
    return slug || null;
  } catch {
    return null;
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "GET_POLYMARKET_SLUG") return;
  const slug = extractPolymarketSlug(window.location.href);
  sendResponse({ slug });
});
