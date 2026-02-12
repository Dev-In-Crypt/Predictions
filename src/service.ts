import "dotenv/config";
import http from "node:http";
import { analyzeMarket } from "./analyzer.js";

const SCHEMA_VERSION = "1.0";

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

const server = http.createServer(async (req, res) => {
  if (!req.url) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify(buildServiceError("Missing URL.")));
    return;
  }

  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  if (url.pathname !== "/analyze") {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify(buildServiceError("Not found.", "NOT_FOUND")));
    return;
  }

  const slug = url.searchParams.get("slug")?.trim() ?? "";
  const marketIndexRaw = url.searchParams.get("market_index");
  const marketIndex =
    marketIndexRaw && marketIndexRaw.trim().length > 0 ? Number.parseInt(marketIndexRaw, 10) : undefined;

  if (!slug) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(buildServiceError("Missing slug.")));
    return;
  }

  const result = await analyzeMarket({ eventSlug: slug, marketIndex });
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(result.status === "success" ? result.payload : result.error));
});

server.listen(PORT, HOST, () => {
  process.stdout.write(`analyzer service listening on http://${HOST}:${PORT}\n`);
});
