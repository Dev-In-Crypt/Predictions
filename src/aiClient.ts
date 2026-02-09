import { extractJsonObject, safeJsonParse, stripMarkdownCodeFences } from "./utils.js";

export interface PredictionResult {
  probability: number;
  explanation: string;
  model: string;
  rawText: string;
}

interface OpenAIResponse {
  output?: Array<{
    type: string;
    content?: Array<{ type: string; text?: string }>;
  }>;
  output_text?: string;
  model?: string;
}

const ALLOWED_CONFIDENCE = new Set(["low", "medium", "high"]);
const ALLOWED_RECENCY = new Set(["fresh", "mixed", "stale", "unknown"]);
const ALLOWED_SEVERITY = new Set(["low", "medium", "high"]);
const ALLOWED_STANCE = new Set(["pro_yes", "pro_no", "neutral"]);

function extractText(response: OpenAIResponse): string | null {
  if (typeof response.output_text === "string") return response.output_text;
  if (!Array.isArray(response.output)) return null;
  for (const item of response.output) {
    if (!item?.content) continue;
    for (const content of item.content) {
      if (content?.type === "output_text" && typeof content.text === "string") {
        return content.text;
      }
    }
  }
  return null;
}

function normalizeProbability(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

type ValidationResult = { ok: true } | { ok: false; reason: string };

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

function validateReport(payload: Record<string, unknown>): ValidationResult {
  const quick = payload.quick_view as Record<string, unknown> | undefined;
  const full = payload.full_report as Record<string, unknown> | undefined;
  if (!quick || !full) return { ok: false, reason: "missing quick_view or full_report" };

  const confidence = quick.confidence;
  if (typeof confidence !== "string" || !ALLOWED_CONFIDENCE.has(confidence)) {
    return { ok: false, reason: "invalid quick_view.confidence" };
  }

  const topDrivers = quick.top_drivers as Record<string, unknown> | undefined;
  if (!topDrivers) return { ok: false, reason: "missing quick_view.top_drivers" };
  const pro = topDrivers.pro;
  const con = topDrivers.con;
  if (!isStringArray(pro) || !isStringArray(con) || pro.length < 2 || con.length < 2) {
    return { ok: false, reason: "top_drivers must have 2+ items each" };
  }

  const evidenceSummary = full.evidence_summary as Record<string, unknown> | undefined;
  if (!evidenceSummary) return { ok: false, reason: "missing full_report.evidence_summary" };
  const recency = evidenceSummary.recency;
  if (typeof recency !== "string" || !ALLOWED_RECENCY.has(recency)) {
    return { ok: false, reason: "invalid evidence_summary.recency" };
  }

  const keyFacts = full.key_facts;
  if (!Array.isArray(keyFacts)) return { ok: false, reason: "key_facts must be array" };
  for (const item of keyFacts) {
    const obj = item as Record<string, unknown>;
    const stance = obj?.stance;
    if (typeof stance !== "string" || !ALLOWED_STANCE.has(stance)) {
      return { ok: false, reason: "invalid key_facts.stance" };
    }
    const sources = obj?.sources;
    if (!isStringArray(sources) || sources.length < 1) {
      return { ok: false, reason: "key_facts.sources must have 1+ urls" };
    }
  }

  const risks = full.risks;
  if (!Array.isArray(risks)) return { ok: false, reason: "risks must be array" };
  for (const item of risks) {
    const obj = item as Record<string, unknown>;
    const severity = obj?.severity;
    if (typeof severity !== "string" || !ALLOWED_SEVERITY.has(severity)) {
      return { ok: false, reason: "invalid risks.severity" };
    }
  }

  return { ok: true };
}

export async function requestPrediction(
  params: {
    apiKey: string;
    model?: string;
    baseUrl?: string;
    provider?: "openai" | "openrouter";
    prompt: string;
    responseFormat?: "json_object" | "none";
    maxRetries?: number;
  },
): Promise<PredictionResult> {
  const model = params.model ?? "gpt-4o-mini";
  const provider = params.provider ?? "openai";
  const baseUrl =
    params.baseUrl ?? (provider === "openrouter" ? "https://openrouter.ai" : "https://api.openai.com");
  const responseFormat = params.responseFormat ?? (provider === "openrouter" ? "none" : "json_object");
  const maxRetries = params.maxRetries ?? 1;

  async function callModel(prompt: string): Promise<{ rawText: string; modelName: string }> {
    const endpoint = provider === "openrouter" ? "/api/v1/chat/completions" : "/v1/responses";
    const bodyPayload =
      provider === "openrouter"
        ? {
            model,
            messages: [{ role: "user", content: prompt }],
            temperature: 0.2,
            ...(responseFormat === "json_object" ? { response_format: { type: "json_object" } } : {}),
          }
        : {
            model,
            input: [{ role: "user", content: prompt }],
            temperature: 0.2,
            text: { format: { type: "json_object" } },
          };

    const headers: Record<string, string> = {
      "Authorization": `Bearer ${params.apiKey}`,
      "Content-Type": "application/json",
    };

    if (provider === "openrouter") {
      headers["HTTP-Referer"] = "https://localhost";
      headers["X-Title"] = "Polymarket Market Analysis MVP";
    }

    const res = await fetch(`${baseUrl}${endpoint}`, {
      method: "POST",
      headers,
      body: JSON.stringify(bodyPayload),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`AI API error (${res.status}): ${text}`);
    }

    const data = (await res.json()) as OpenAIResponse & {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const rawText =
      provider === "openrouter"
        ? data.choices?.[0]?.message?.content ?? null
        : extractText(data);
    if (!rawText) throw new Error("AI API returned no text output.");
    return { rawText, modelName: data.model ?? model };
  }

  const correction =
    "Return strict JSON only, no markdown, follow the schema exactly. Ensure required arrays and enums are valid.";
  let attempt = 0;
  let lastRaw = "";
  let lastModel = model;
  let lastReason = "";
  while (attempt <= maxRetries) {
    const prompt = attempt === 0 ? params.prompt : `${params.prompt}\n\n${correction}`;
    const { rawText, modelName } = await callModel(prompt);
    lastRaw = rawText;
    lastModel = modelName;

    const sanitized = stripMarkdownCodeFences(rawText);
    let parsed = safeJsonParse<Record<string, unknown>>(sanitized);
    if (!parsed) {
      const extracted = extractJsonObject(sanitized);
      if (extracted) {
        parsed = safeJsonParse<Record<string, unknown>>(extracted);
      }
    }
    if (!parsed) {
      lastReason = "invalid JSON";
      attempt += 1;
      continue;
    }

    const validation = validateReport(parsed);
    if (!validation.ok) {
      lastReason = validation.reason;
      attempt += 1;
      continue;
    }

    return {
      probability: 0,
      explanation: "Structured report returned.",
      model: modelName,
      rawText: sanitized,
    };
  }

  throw new Error(`AI output failed validation (${lastReason}): ${lastRaw}`);
}
