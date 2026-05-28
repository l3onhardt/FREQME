export function compactText(value: unknown, maxLength = 240): string {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

export function normalizeMatchText(value: unknown): string {
  return String(value ?? "")
    .toLocaleLowerCase()
    .normalize("NFKC")
    .replace(/[\W_]+/gu, "");
}

export function dedupe(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const item = compactText(value);
    if (!item || seen.has(item)) continue;
    seen.add(item);
    result.push(item);
  }
  return result;
}

export function safeJsonParse<T>(text: string, fallback: T): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

export function extractJsonObject(text: string): Record<string, unknown> {
  const raw = String(text || "").trim();
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    // Continue with fenced or embedded JSON extraction.
  }
  const fenced = raw.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/i);
  const candidate = fenced?.[1] || raw.match(/\{[\s\S]*\}/)?.[0];
  if (!candidate) return {};
  try {
    const parsed = JSON.parse(candidate);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export function asStringList(value: unknown, limit = 12): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => compactText(item, 160)).filter(Boolean).slice(0, limit);
}

export function hasCjk(value: string): boolean {
  return /[\u4e00-\u9fff]/u.test(value);
}

