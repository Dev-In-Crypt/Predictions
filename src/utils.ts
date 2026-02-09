export function readEnv(name: string, required = true): string | undefined {
  const value = process.env[name];
  if (required && (!value || value.trim().length === 0)) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export function safeJsonParse<T>(input: string): T | null {
  try {
    return JSON.parse(input) as T;
  } catch {
    return null;
  }
}

export function extractJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  return text.slice(start, end + 1);
}

export function stripMarkdownCodeFences(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith("```")) return text;
  const firstLineEnd = trimmed.indexOf("\n");
  if (firstLineEnd === -1) return text;
  const firstLine = trimmed.slice(0, firstLineEnd).trim();
  if (!firstLine.startsWith("```")) return text;
  const lastFenceIndex = trimmed.lastIndexOf("```");
  if (lastFenceIndex <= firstLineEnd) return text;
  const inner = trimmed.slice(firstLineEnd + 1, lastFenceIndex).trim();
  return inner;
}

export function toNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

export function normalizeStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => String(v));
  if (typeof value === "string") {
    const parsed = safeJsonParse<unknown[]>(value);
    if (parsed && Array.isArray(parsed)) return parsed.map((v) => String(v));
    const parts = value.split(/[|,]/).map((p) => p.trim()).filter(Boolean);
    return parts.length > 0 ? parts : [value];
  }
  if (value == null) return [];
  return [String(value)];
}

export function normalizeNumberArray(value: unknown): number[] {
  if (Array.isArray(value)) {
    return value.map((v) => toNumber(v)).filter((v): v is number => v !== null);
  }
  if (typeof value === "string") {
    const parsed = safeJsonParse<unknown[]>(value);
    if (parsed && Array.isArray(parsed)) {
      return parsed.map((v) => toNumber(v)).filter((v): v is number => v !== null);
    }
    const parts = value.split(/[|,]/).map((p) => p.trim()).filter(Boolean);
    return parts.map((p) => toNumber(p)).filter((v): v is number => v !== null);
  }
  const single = toNumber(value);
  return single === null ? [] : [single];
}

export function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

export function coerceString(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (value == null) return undefined;
  return String(value);
}
