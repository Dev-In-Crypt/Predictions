import "dotenv/config";
import { analyzeMarket } from "./analyzer.js";

function getArg(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  if (idx === -1) return undefined;
  return process.argv[idx + 1];
}

function outputError(err: unknown): void {
  process.stdout.write(`${JSON.stringify(err)}\n`);
}

function outputJson(obj: unknown): void {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

async function run(): Promise<void> {
  const slug = getArg("--slug");
  const id = getArg("--id");
  const eventSlug = getArg("--event");
  const marketIndexRaw = getArg("--market-index");
  const marketIndex = marketIndexRaw ? Number.parseInt(marketIndexRaw, 10) : undefined;
  const result = await analyzeMarket({
    slug: slug ?? undefined,
    id: id ?? undefined,
    eventSlug: eventSlug ?? undefined,
    marketIndex,
  });
  if (result.status === "success") {
    outputJson(result.payload);
  } else {
    outputError(result.error);
  }
}

run();
