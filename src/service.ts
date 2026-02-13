import "dotenv/config";
import http from "node:http";
import { analyzeMarket } from "./analyzer.js";

const SCHEMA_VERSION = "1.0";
const SERVICE_VERSION = "8.0.0";

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
        font: 14px/1.5 "Sora", "Segoe UI", system-ui, sans-serif;
        color: var(--ink);
        background: var(--bg);
      }
      .wrap {
        max-width: 920px;
        margin: 16px auto;
        padding: 0 12px 20px;
      }
      .card {
        background: var(--panel);
        border: 1px solid var(--line);
        border-radius: 12px;
        padding: 12px;
        margin-bottom: 10px;
        box-shadow: 0 1px 0 rgba(32, 29, 24, 0.04);
      }
      h1 { font-size: 19px; margin: 0 0 6px; }
      h2 { font-size: 15px; margin: 0 0 8px; }
      .muted { color: var(--muted); }
      .grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
        gap: 8px;
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
      .actions {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
      }
      .btn {
        border: 1px solid var(--line);
        border-radius: 8px;
        background: #f8f6f2;
        color: var(--ink);
        font-size: 12px;
        font-weight: 600;
        padding: 8px 10px;
        cursor: pointer;
      }
      .export-status {
        margin-top: 8px;
        font-size: 12px;
        color: var(--muted);
      }
      .hidden { display: none; }
      .empty-state {
        border: 1px dashed var(--line);
        border-radius: 10px;
        padding: 10px;
        color: var(--muted);
        background: #fbfaf7;
      }
      .empty-state strong {
        display: block;
        color: var(--ink);
        margin-bottom: 2px;
      }
      @media (max-width: 720px) {
        body { font-size: 13px; }
        .wrap { padding: 0 10px 16px; }
        .card { padding: 10px; }
        .v { font-size: 14px; }
      }
    </style>
  </head>
  <body>
    <div class="wrap">
      <div class="card">
        <h1>Polymarket Full Report</h1>
        <div class="muted">Slug: <code id="slug">${safeSlug}</code></div>
      </div>

      <div class="card">
        <h2>Export</h2>
        <div class="actions">
          <button id="copyJson" class="btn">Copy JSON</button>
          <button id="copySummary" class="btn">Copy short summary</button>
          <button id="downloadJson" class="btn">Download JSON</button>
        </div>
        <div id="exportStatus" class="export-status">Ready</div>
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
      let currentPayload = null;

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
        currentPayload = payload;
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
          keyFacts.innerHTML = '<div class="empty-state"><strong>No key facts yet</strong>Run analysis on a market with richer source evidence.</div>';
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
          sourcesEl.innerHTML = '<div class="empty-state"><strong>No sources captured</strong>The analyzer response did not include source records for this run.</div>';
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

      function shortSummary(payload) {
        const quick = payload?.quick_view ?? {};
        const yes = text(quick?.estimate_yes_pct);
        const no = quick?.estimate_yes_pct === null || quick?.estimate_yes_pct === undefined
          ? "—"
          : text(100 - Number(quick?.estimate_yes_pct));
        const confidence = text(quick?.confidence);
        const context = text(quick?.one_sentence_take ?? quick?.summary);
        const requestId = text(payload?.request_id);
        return [
          "Market: " + text(slug),
          "YES: " + yes + " | NO: " + no + " | Confidence: " + confidence,
          "Context: " + context,
          "Request ID: " + requestId,
          "Timestamp UTC: " + text(payload?.timestamp_utc),
        ].join("\\n");
      }

      async function copyText(value, okMessage) {
        const statusEl = document.getElementById("exportStatus");
        try {
          await navigator.clipboard.writeText(value);
          statusEl.textContent = okMessage;
        } catch (err) {
          statusEl.textContent = "Copy failed: " + (err?.message || String(err));
        }
      }

      function downloadPayload(payload) {
        const statusEl = document.getElementById("exportStatus");
        try {
          const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
          const url = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = url;
          a.download = (slug || "report") + ".json";
          a.click();
          URL.revokeObjectURL(url);
          statusEl.textContent = "Downloaded JSON";
        } catch (err) {
          statusEl.textContent = "Download failed: " + (err?.message || String(err));
        }
      }

      function wireExportActions() {
        const copyJsonBtn = document.getElementById("copyJson");
        const copySummaryBtn = document.getElementById("copySummary");
        const downloadJsonBtn = document.getElementById("downloadJson");

        copyJsonBtn.addEventListener("click", async () => {
          if (!currentPayload) return;
          await copyText(JSON.stringify(currentPayload, null, 2), "Copied JSON");
        });

        copySummaryBtn.addEventListener("click", async () => {
          if (!currentPayload) return;
          await copyText(shortSummary(currentPayload), "Copied short summary");
        });

        downloadJsonBtn.addEventListener("click", () => {
          if (!currentPayload) return;
          downloadPayload(currentPayload);
        });
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

      wireExportActions();
      run();
    </script>
  </body>
</html>`;
}

function parseHistoryParam(raw: string | null): Array<Record<string, unknown>> {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as Array<Record<string, unknown>>) : [];
  } catch {
    return [];
  }
}

function renderHistoryPage(initialHistory: Array<Record<string, unknown>>): string {
  const safeInitialHistory = JSON.stringify(initialHistory);
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Polymarket Analysis History</title>
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
        font: 14px/1.5 "Sora", "Segoe UI", system-ui, sans-serif;
        color: var(--ink);
        background: var(--bg);
      }
      .wrap {
        max-width: 920px;
        margin: 16px auto;
        padding: 0 12px 20px;
      }
      .card {
        background: var(--panel);
        border: 1px solid var(--line);
        border-radius: 12px;
        padding: 12px;
        margin-bottom: 10px;
        box-shadow: 0 1px 0 rgba(32, 29, 24, 0.04);
      }
      h1 { font-size: 19px; margin: 0 0 6px; }
      .muted { color: var(--muted); }
      .table-wrap {
        overflow-x: auto;
        border: 1px solid var(--line);
        border-radius: 10px;
      }
      table {
        width: 100%;
        border-collapse: collapse;
        min-width: 900px;
        background: #fff;
      }
      th, td {
        border-bottom: 1px solid var(--line);
        text-align: left;
        padding: 9px 8px;
        vertical-align: top;
      }
      th {
        font-size: 12px;
        color: var(--muted);
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      a { color: var(--accent); }
      code { background: #f1eee8; border-radius: 6px; padding: 2px 6px; }
      .empty {
        border: 1px dashed var(--line);
        border-radius: 10px;
        padding: 10px;
        color: var(--muted);
        background: #fbfaf7;
      }
      .empty strong {
        display: block;
        color: var(--ink);
        margin-bottom: 2px;
      }
      .filters {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
        gap: 8px;
        margin-bottom: 10px;
      }
      .filters input, .filters select {
        width: 100%;
        border: 1px solid var(--line);
        border-radius: 8px;
        padding: 8px 10px;
        font-size: 12px;
      }
      @media (max-width: 720px) {
        body { font-size: 13px; }
        .wrap { padding: 0 10px 16px; }
        .card { padding: 10px; }
      }
    </style>
  </head>
  <body>
    <div class="wrap">
      <div class="card">
        <h1>Polymarket Analysis History</h1>
        <div class="muted">Loaded from extension history payload (up to 20 most recent entries).</div>
      </div>
      <div class="card">
        <div class="filters">
          <input id="slugFilter" type="text" placeholder="Filter by slug" />
          <select id="confidenceFilter">
            <option value="all">All confidence</option>
            <option value="high">High</option>
            <option value="medium">Medium</option>
            <option value="low">Low</option>
          </select>
          <select id="timeFilter">
            <option value="all">All time</option>
            <option value="24h">Last 24h</option>
            <option value="7d">Last 7d</option>
            <option value="30d">Last 30d</option>
          </select>
        </div>
        <div id="empty" class="empty"><strong>No history yet</strong>Run analysis in the extension popup to start tracking results.</div>
        <div id="tableWrap" class="table-wrap" hidden>
          <table id="table">
            <thead>
              <tr>
                <th>Slug</th>
                <th>Timestamp (UTC)</th>
                <th>YES %</th>
                <th>NO %</th>
                <th>Confidence</th>
                <th>Request ID</th>
                <th>Cache Expires</th>
                <th>Service URL</th>
                <th>Evidence Mode</th>
                <th>Report</th>
              </tr>
            </thead>
            <tbody id="tbody"></tbody>
          </table>
        </div>
      </div>
    </div>

    <script>
      const initialHistory = ${safeInitialHistory};

      function text(v) {
        if (v === null || v === undefined) return "—";
        const s = String(v).trim();
        return s ? s : "—";
      }

      function parseHistoryFromHash() {
        if (!location.hash) return [];
        const raw = location.hash.startsWith("#") ? location.hash.slice(1) : location.hash;
        const params = new URLSearchParams(raw);
        const encoded = params.get("history");
        if (!encoded) return [];
        try {
          const parsed = JSON.parse(encoded);
          return Array.isArray(parsed) ? parsed : [];
        } catch {
          return [];
        }
      }

      function parseTimeRangeMs(value) {
        if (value === "24h") return 24 * 60 * 60 * 1000;
        if (value === "7d") return 7 * 24 * 60 * 60 * 1000;
        if (value === "30d") return 30 * 24 * 60 * 60 * 1000;
        return null;
      }

      function applyFilters(history) {
        const slugNeedle = String(document.getElementById("slugFilter").value || "").trim().toLowerCase();
        const confidence = document.getElementById("confidenceFilter").value;
        const timeRange = document.getElementById("timeFilter").value;
        const windowMs = parseTimeRangeMs(timeRange);
        const now = Date.now();

        return history.filter((item) => {
          const slug = String(item?.slug || "").toLowerCase();
          if (slugNeedle && !slug.includes(slugNeedle)) return false;

          const conf = String(item?.confidence || "").toLowerCase();
          if (confidence !== "all" && conf !== confidence) return false;

          if (windowMs !== null) {
            const ts = Date.parse(String(item?.timestamp_utc || ""));
            if (Number.isNaN(ts)) return false;
            if (now - ts > windowMs) return false;
          }

          return true;
        });
      }

      function resolveHistory() {
        const fromHash = parseHistoryFromHash();
        if (fromHash.length > 0) return fromHash.slice(0, 20);
        return Array.isArray(initialHistory) ? initialHistory.slice(0, 20) : [];
      }

      function renderRows(history) {
        const emptyEl = document.getElementById("empty");
        const tableWrapEl = document.getElementById("tableWrap");
        const tableEl = document.getElementById("table");
        const tbody = document.getElementById("tbody");
        tbody.textContent = "";

        if (history.length === 0) {
          emptyEl.innerHTML = "<strong>No matching rows</strong>Try widening your filters or run analysis on another market.";
          emptyEl.hidden = false;
          tableWrapEl.hidden = true;
          tableEl.hidden = true;
          return;
        }

        emptyEl.hidden = true;
        tableWrapEl.hidden = false;
        tableEl.hidden = false;

        for (const item of history) {
          const tr = document.createElement("tr");

          const slug = document.createElement("td");
          const slugCode = document.createElement("code");
          slugCode.textContent = text(item?.slug);
          slug.appendChild(slugCode);
          tr.appendChild(slug);

          const ts = document.createElement("td");
          ts.textContent = text(item?.timestamp_utc);
          tr.appendChild(ts);

          const yes = document.createElement("td");
          yes.textContent = text(item?.yes_percent);
          tr.appendChild(yes);

          const no = document.createElement("td");
          no.textContent = text(item?.no_percent);
          tr.appendChild(no);

          const conf = document.createElement("td");
          conf.textContent = text(item?.confidence);
          tr.appendChild(conf);

          const req = document.createElement("td");
          req.textContent = text(item?.request_id);
          tr.appendChild(req);

          const cache = document.createElement("td");
          cache.textContent = text(item?.cache_expires_at_utc);
          tr.appendChild(cache);

          const service = document.createElement("td");
          service.textContent = text(item?.service_url);
          tr.appendChild(service);

          const mode = document.createElement("td");
          mode.textContent = text(item?.evidence_mode);
          tr.appendChild(mode);

          const report = document.createElement("td");
          const rowSlug = typeof item?.slug === "string" ? item.slug.trim() : "";
          if (rowSlug) {
            const a = document.createElement("a");
            a.href = "/report?slug=" + encodeURIComponent(rowSlug);
            a.target = "_blank";
            a.rel = "noopener noreferrer";
            a.textContent = "Open";
            report.appendChild(a);
          } else {
            report.textContent = "—";
          }
          tr.appendChild(report);

          tbody.appendChild(tr);
        }
      }

      function render() {
        const history = resolveHistory();
        const filtered = applyFilters(history);
        renderRows(filtered);
      }

      function wireFilters() {
        document.getElementById("slugFilter").addEventListener("input", render);
        document.getElementById("confidenceFilter").addEventListener("change", render);
        document.getElementById("timeFilter").addEventListener("change", render);
      }

      wireFilters();
      render();
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
  if (url.pathname === "/history") {
    const raw = url.searchParams.get("history");
    const initialHistory = parseHistoryParam(raw);
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(renderHistoryPage(initialHistory));
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
