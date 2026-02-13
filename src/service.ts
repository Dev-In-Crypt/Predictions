import "dotenv/config";
import http from "node:http";
import { analyzeMarket } from "./analyzer.js";

const SCHEMA_VERSION = "1.0";
const SERVICE_VERSION = "1.0.0";

function buildServiceError(message: string, errorCode = "BAD_REQUEST") {
  const timestamp = new Date().toISOString();
  return {
    status: "error",
    step: "overall",
    error_code: errorCode,
    message,
    retryable: false,
    schema_version: SCHEMA_VERSION,
    timestamp_utc: timestamp,
    resolved_via: "event_index",
    cache: { hit: false, ttl_sec: 0, expires_at_utc: timestamp },
  };
}

const HOST = "127.0.0.1";
const PORT = Number.parseInt(process.env.ANALYZER_PORT ?? "8787", 10);
const startedAt = Date.now();

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");
}

function renderReportPage(slug: string): string {
  const safeSlug = escapeHtml(slug);
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Polymarket Full Report</title>
    <style>
      :root {
        color-scheme: light;
        --bg: #f6f4f0;
        --panel: #ffffff;
        --ink: #201d18;
        --muted: #6c655a;
        --line: #e2ddd4;
        --accent: #0f6d5e;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        font: 14px/1.4 "Segoe UI", system-ui, sans-serif;
        color: var(--ink);
        background: var(--bg);
      }
      .wrap {
        max-width: 1040px;
        margin: 24px auto;
        padding: 0 16px 24px;
      }
      .card {
        background: var(--panel);
        border: 1px solid var(--line);
        border-radius: 12px;
        padding: 14px;
        margin-bottom: 14px;
      }
      h1 { font-size: 20px; margin: 0 0 8px; }
      h2 { font-size: 16px; margin: 0 0 8px; }
      .muted { color: var(--muted); }
      .grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
        gap: 10px;
      }
      .kv {
        border: 1px solid var(--line);
        border-radius: 10px;
        padding: 8px 10px;
      }
      .k { font-size: 12px; color: var(--muted); text-transform: uppercase; }
      .v { font-size: 15px; font-weight: 600; }
      ul { margin: 8px 0 0; padding-left: 18px; }
      li { margin: 4px 0; }
      a { color: var(--accent); }
      code { background: #f1eee8; border-radius: 6px; padding: 2px 6px; }
      .source {
        border: 1px solid var(--line);
        border-radius: 10px;
        padding: 10px;
        margin-bottom: 8px;
      }
      .support {
        margin-top: 6px;
        font-size: 13px;
        color: var(--muted);
      }
      .error {
        color: #b3261e;
        font-weight: 600;
      }
      .hidden { display: none; }
    </style>
  </head>
  <body>
    <div class="wrap">
      <div class="card">
        <h1>Polymarket Full Report</h1>
        <div class="muted">Slug: <code id="slug">${safeSlug}</code></div>
      </div>

      <div id="error" class="card error hidden"></div>

      <div id="content" class="hidden">
        <div class="card">
          <h2>Market Snapshot & Metadata</h2>
          <div id="snapshot" class="grid"></div>
        </div>

        <div class="card">
          <h2>Pro Arguments</h2>
          <ul id="proArgs"></ul>
        </div>

        <div class="card">
          <h2>Con Arguments</h2>
          <ul id="conArgs"></ul>
        </div>

        <div class="card">
          <h2>Key Facts With Support Mapping</h2>
          <div id="keyFacts"></div>
        </div>

        <div class="card">
          <h2>Sources</h2>
          <div id="sources"></div>
        </div>
      </div>
    </div>

    <script>
      const slug = ${JSON.stringify(slug)};

      function asArray(value) {
        return Array.isArray(value) ? value : [];
      }

      function text(v) {
        if (v === null || v === undefined) return "—";
        const s = String(v).trim();
        return s ? s : "—";
      }

      function addList(id, values) {
        const el = document.getElementById(id);
        const arr = asArray(values).filter((v) => typeof v === "string" && v.trim());
        if (arr.length === 0) {
          const li = document.createElement("li");
          li.textContent = "—";
          el.appendChild(li);
          return;
        }
        for (const item of arr) {
          const li = document.createElement("li");
          li.textContent = item;
          el.appendChild(li);
        }
      }

      function addSnapshotItem(container, key, value) {
        const box = document.createElement("div");
        box.className = "kv";
        const k = document.createElement("div");
        k.className = "k";
        k.textContent = key;
        const v = document.createElement("div");
        v.className = "v";
        v.textContent = text(value);
        box.appendChild(k);
        box.appendChild(v);
        container.appendChild(box);
      }

      function render(payload) {
        const quick = payload?.quick_view ?? {};
        const full = payload?.full_report ?? {};
        const sources = asArray(payload?.sources);
        const renderedSourcesCount = sources.length;
        const sourceById = new Map();
        for (const source of sources) {
          if (typeof source?.source_id === "string" && source.source_id.trim()) {
            sourceById.set(source.source_id.trim(), source);
          }
        }

        const snapshot = document.getElementById("snapshot");
        addSnapshotItem(snapshot, "Estimate YES %", quick?.estimate_yes_pct);
        addSnapshotItem(snapshot, "Market YES %", quick?.market_yes_pct);
        addSnapshotItem(snapshot, "Delta vs Market", quick?.delta_vs_market_pp);
        addSnapshotItem(snapshot, "Confidence", quick?.confidence);
        addSnapshotItem(snapshot, "Range YES %", JSON.stringify(quick?.range_yes_pct ?? []));
        addSnapshotItem(snapshot, "One sentence", quick?.one_sentence_take ?? quick?.summary);
        addSnapshotItem(snapshot, "Request ID", payload?.request_id);
        addSnapshotItem(snapshot, "Schema", payload?.schema_version);
        addSnapshotItem(snapshot, "Timestamp", payload?.timestamp_utc);
        addSnapshotItem(snapshot, "Resolved via", payload?.resolved_via);
        addSnapshotItem(snapshot, "Cache hit", payload?.cache?.hit);
        addSnapshotItem(snapshot, "Cache expires", payload?.cache?.expires_at_utc);
        addSnapshotItem(snapshot, "Sources used", renderedSourcesCount);
        addSnapshotItem(snapshot, "Sources missing", payload?.sources_missing);

        addList("proArgs", quick?.top_drivers?.pro);
        addList("conArgs", quick?.top_drivers?.con);

        const keyFacts = document.getElementById("keyFacts");
        const facts = asArray(full?.key_facts);
        if (facts.length === 0) {
          keyFacts.textContent = "No key facts.";
        } else {
          for (const fact of facts) {
            const block = document.createElement("div");
            block.className = "source";
            const claim = document.createElement("div");
            claim.innerHTML = "<strong>Claim:</strong> " + text(fact?.claim);
            block.appendChild(claim);

            const meta = document.createElement("div");
            meta.className = "muted";
            meta.textContent = "Stance: " + text(fact?.stance) + " | Confidence: " + text(fact?.confidence);
            block.appendChild(meta);

            const supportWrap = document.createElement("div");
            supportWrap.className = "support";
            supportWrap.textContent = "Support: ";
            const ids = asArray(fact?.support_ids);
            if (ids.length === 0) {
              supportWrap.append("none");
            } else {
              ids.forEach((id, idx) => {
                const source = sourceById.get(String(id));
                if (source?.url) {
                  const a = document.createElement("a");
                  a.href = source.url;
                  a.target = "_blank";
                  a.rel = "noopener noreferrer";
                  a.textContent = source.title || source.url;
                  supportWrap.appendChild(a);
                } else {
                  supportWrap.append(String(id));
                }
                if (idx < ids.length - 1) supportWrap.append(" | ");
              });
            }
            block.appendChild(supportWrap);
            keyFacts.appendChild(block);
          }
        }

        const sourcesEl = document.getElementById("sources");
        if (sources.length === 0) {
          sourcesEl.textContent = "No sources.";
        } else {
          for (const source of sources) {
            const item = document.createElement("div");
            item.className = "source";

            const title = document.createElement("div");
            const link = document.createElement("a");
            link.href = source?.url || "#";
            link.target = "_blank";
            link.rel = "noopener noreferrer";
            link.textContent = source?.title || source?.url || "Source";
            title.appendChild(link);
            item.appendChild(title);

            const meta = document.createElement("div");
            meta.className = "muted";
            meta.textContent =
              "id: " + text(source?.source_id) +
              " | tier: " + text(source?.tier) +
              " | domain: " + text(source?.domain) +
              " | published: " + text(source?.published_date ?? source?.captured_at_utc ?? source?.retrieved_at_utc);
            item.appendChild(meta);

            const snippet = source?.snippet || source?.description || source?.resolution_criteria;
            if (snippet) {
              const body = document.createElement("div");
              body.textContent = snippet;
              item.appendChild(body);
            }
            sourcesEl.appendChild(item);
          }
        }
      }

      function parsePayloadFromHash() {
        if (!location.hash) return null;
        const raw = location.hash.startsWith("#") ? location.hash.slice(1) : location.hash;
        const params = new URLSearchParams(raw);
        const payloadRaw = params.get("payload");
        if (!payloadRaw) return null;
        try {
          const parsed = JSON.parse(payloadRaw);
          return parsed && typeof parsed === "object" ? parsed : null;
        } catch {
          return null;
        }
      }

      async function run() {
        const errorEl = document.getElementById("error");
        const contentEl = document.getElementById("content");
        if (!slug) {
          errorEl.textContent = "Missing slug.";
          errorEl.classList.remove("hidden");
          return;
        }
        const hashPayload = parsePayloadFromHash();
        if (hashPayload && hashPayload.status !== "error") {
          render(hashPayload);
          contentEl.classList.remove("hidden");
          return;
        }
        try {
          const res = await fetch("/analyze?slug=" + encodeURIComponent(slug));
          const payload = await res.json();
          if (!payload || payload.status === "error") {
            throw new Error(payload?.message || "Analysis failed.");
          }
          render(payload);
          contentEl.classList.remove("hidden");
        } catch (err) {
          errorEl.textContent = "Failed to load report: " + (err?.message || String(err));
          errorEl.classList.remove("hidden");
        }
      }

      run();
    </script>
  </body>
</html>`;
}

async function readJsonBody(req: http.IncomingMessage): Promise<{ ok: true; value: Record<string, unknown> } | { ok: false }> {
  if (req.method !== "POST") return { ok: false };
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  if (chunks.length === 0) return { ok: false };
  const raw = Buffer.concat(chunks).toString("utf-8").trim();
  if (!raw) return { ok: false };
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return { ok: true, value: {} };
    return { ok: true, value: parsed as Record<string, unknown> };
  } catch {
    return { ok: true, value: { sources: "__malformed__" } };
  }
}

const server = http.createServer(async (req, res) => {
  if (!req.url) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify(buildServiceError("Missing URL.")));
    return;
  }

  const requestId = `req_${Date.now()}_${Math.random().toString(16).slice(2, 10)}`;
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  if (url.pathname === "/health") {
    // /health contract (stable):
    // {
    //   ok: true,
    //   status: "ok",
    //   service_version: "1.0.0",
    //   time_utc: ISO-8601 UTC string,
    //   uptime_sec: integer seconds since process start
    // }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        ok: true,
        status: "ok",
        service_version: SERVICE_VERSION,
        time_utc: new Date().toISOString(),
        uptime_sec: Math.floor((Date.now() - startedAt) / 1000),
      })
    );
    return;
  }
  if (url.pathname === "/report") {
    const slug = url.searchParams.get("slug")?.trim() ?? "";
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(renderReportPage(slug));
    return;
  }
  if (url.pathname !== "/analyze") {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ...buildServiceError("Not found.", "NOT_FOUND"), request_id: requestId }));
    return;
  }

  const slug = url.searchParams.get("slug")?.trim() ?? "";
  const marketIndexRaw = url.searchParams.get("market_index");
  const marketIndex =
    marketIndexRaw && marketIndexRaw.trim().length > 0 ? Number.parseInt(marketIndexRaw, 10) : undefined;
  const body = await readJsonBody(req);
  const sourcesInput = body.ok ? body.value.sources : undefined;

  if (!slug) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ...buildServiceError("Missing slug."), request_id: requestId }));
    return;
  }

  const result = await analyzeMarket({ eventSlug: slug, marketIndex, sources: sourcesInput });
  res.writeHead(200, { "Content-Type": "application/json" });
  if (result.status === "success") {
    res.end(JSON.stringify({ ...result.payload, request_id: requestId }));
  } else {
    res.end(JSON.stringify({ ...result.error, request_id: requestId }));
  }
});

server.listen(PORT, HOST, () => {
  process.stdout.write(`analyzer service listening on http://${HOST}:${PORT}\n`);
});
