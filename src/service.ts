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
  if (url.pathname !== "/analyze") {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ...buildServiceError("Not found.", "NOT_FOUND"), request_id: requestId }));
    return;
  }

  const slug = url.searchParams.get("slug")?.trim() ?? "";
  const marketIndexRaw = url.searchParams.get("market_index");
  const marketIndex =
    marketIndexRaw && marketIndexRaw.trim().length > 0 ? Number.parseInt(marketIndexRaw, 10) : undefined;

  if (!slug) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ...buildServiceError("Missing slug."), request_id: requestId }));
    return;
  }

  const result = await analyzeMarket({ eventSlug: slug, marketIndex });
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
