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

function textOrEmpty(node) {
  if (!node || !node.textContent) return "";
  return node.textContent.trim();
}

function findLabelValue(label) {
  const lower = label.toLowerCase();
  const nodes = Array.from(document.querySelectorAll("h1,h2,h3,h4,h5,div,span,p,section"));
  for (const node of nodes) {
    const text = textOrEmpty(node);
    if (text && text.toLowerCase() === lower) {
      const next = node.nextElementSibling;
      const nextText = textOrEmpty(next);
      if (nextText) return nextText;
    }
  }
  return "";
}

function extractPageSource() {
  const url = window.location.href;
  const title =
    textOrEmpty(document.querySelector("h1")) ||
    document.title ||
    "";
  const description =
    document.querySelector('meta[name="description"]')?.getAttribute("content")?.trim() ||
    findLabelValue("Description") ||
    "";
  const resolutionCriteria =
    findLabelValue("Resolution criteria") ||
    findLabelValue("Resolution Criteria") ||
    "";

  const slug = extractPolymarketSlug(url);
  const parts = [];
  if (description) parts.push(`Description: ${description}`);
  if (resolutionCriteria) parts.push(`Resolution criteria: ${resolutionCriteria}`);

  return {
    slug,
    url,
    title: title || undefined,
    snippet: parts.length > 0 ? parts.join("\n") : undefined,
    description: description || undefined,
    resolution_criteria: resolutionCriteria || undefined,
    captured_at_utc: new Date().toISOString(),
  };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "PING_CONTENT_SCRIPT") {
    sendResponse({ ok: true });
    return;
  }
  if (message?.type === "GET_POLYMARKET_SLUG") {
    const slug = extractPolymarketSlug(window.location.href);
    sendResponse({ slug });
    return;
  }
  if (message?.type === "GET_PAGE_SOURCE") {
    sendResponse({ source: extractPageSource() });
    return;
  }
});
