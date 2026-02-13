import fs from "node:fs";
import { spawnSync } from "node:child_process";

const manifestRaw = fs.readFileSync("extension/manifest.json", "utf-8");
const manifest = JSON.parse(manifestRaw);
const version = typeof manifest?.version === "string" ? manifest.version.trim() : "0.0.0";

if (!version) {
  throw new Error("Manifest version is missing.");
}

fs.mkdirSync("artifacts", { recursive: true });
const zipPath = `artifacts/polymarket-analyzer-v${version}.zip`;
if (fs.existsSync(zipPath)) {
  fs.rmSync(zipPath);
}

const compressCommand =
  "Compress-Archive -Path extension\\* -DestinationPath " +
  `'${zipPath.replaceAll("'", "''")}' -CompressionLevel Optimal`;

const result = spawnSync("powershell", ["-NoProfile", "-Command", compressCommand], {
  stdio: "inherit",
});

if (result.status !== 0) {
  throw new Error(`Packaging failed with exit code ${result.status ?? -1}`);
}

process.stdout.write(`Created ${zipPath}\n`);
