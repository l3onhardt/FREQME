import { config } from "../config.js";
import type { MemoryStore } from "../storage/memoryStore.js";

interface ChatOptions {
  maxTokens?: number;
  system?: string;
  responseFormat?: Record<string, unknown>;
  timeoutMs?: number;
}

const rejectionMarkers = ["request was rejected", "considered high risk", "content policy", "safety policy"];

function isProviderRejection(text: string): boolean {
  const lowered = text.trim().toLowerCase();
  return rejectionMarkers.some((marker) => lowered.includes(marker));
}

function providerOrder(budgetOk: boolean): string[] {
  const primary = config.llmProvider;
  const fallback = config.llmFallbackProvider;
  if (fallback === primary) return [primary];
  return budgetOk ? [primary, fallback] : [fallback, primary];
}

function anthropicMessages(messages: Array<{ role: string; content: string }>): {
  system?: string;
  messages: Array<{ role: string; content: string }>;
} {
  const system = messages
    .filter((message) => message.role === "system")
    .map((message) => message.content)
    .join("\n\n");
  return {
    ...(system ? { system } : {}),
    messages: messages
      .filter((message) => message.role !== "system")
      .map((message) => ({
        role: message.role === "assistant" ? "assistant" : "user",
        content: message.content,
      })),
  };
}

export class LLMRouter {
  constructor(private readonly store: MemoryStore) {}

  async chat(userMessage: string, options: ChatOptions = {}): Promise<string> {
    const maxTokens = options.maxTokens ?? 300;
    const system =
      options.system ||
      "你是 FREQME 的私人电台主播。输出要简短、具体、像真实电台主持人，不要提系统、算法、推荐或画像。";
    const messages = [
      { role: "system", content: system },
      { role: "user", content: userMessage },
    ];
    const budgetOk = this.store.checkTokenBudget();
    let lastError: unknown = null;
    const timeoutMs = options.timeoutMs ?? 15000;

    for (const provider of providerOrder(budgetOk)) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await this.callProvider(provider, messages, maxTokens, options.responseFormat, controller.signal);
        if (!response || isProviderRejection(response)) {
          lastError = new Error(`${provider} rejected generation`);
          continue;
        }
        this.store.addTokens(maxTokens);
        return response;
      } catch (error) {
        lastError = error;
      } finally {
        clearTimeout(timer);
      }
    }

    throw new Error(`all LLM providers failed: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
  }

  private async callProvider(
    provider: string,
    messages: Array<{ role: string; content: string }>,
    maxTokens: number,
    responseFormat?: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<string> {
    if (provider === "anthropic") {
      const apiKey = config.llmFallbackApiKey;
      if (!apiKey) throw new Error("missing Anthropic API key");
      const response = await fetch(`${config.llmFallbackApiBase.replace(/\/$/, "")}/messages`, {
        method: "POST",
        signal,
        headers: {
          "api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: config.llmFallbackModel,
          max_tokens: maxTokens,
          ...anthropicMessages(messages),
        }),
      });
      if (!response.ok) throw new Error(`anthropic HTTP ${response.status}`);
      const data = (await response.json()) as { content?: Array<{ text?: string }> };
      return data.content?.[0]?.text || "";
    }

    if (provider === "openai") {
      const apiKey = provider === config.llmFallbackProvider ? config.llmFallbackApiKey : config.llmApiKey;
      if (!apiKey) throw new Error("missing OpenAI API key");
      const response = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        signal,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: provider === config.llmFallbackProvider ? config.llmFallbackModel : config.llmModel,
          messages,
          max_tokens: maxTokens,
          ...(responseFormat ? { response_format: responseFormat } : {}),
        }),
      });
      if (!response.ok) throw new Error(`openai HTTP ${response.status}`);
      const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }>; usage?: { total_tokens?: number } };
      if (data.usage?.total_tokens) this.store.addTokens(data.usage.total_tokens);
      return data.choices?.[0]?.message?.content || "";
    }

    if (provider === "gemini") {
      const apiKey = provider === config.llmFallbackProvider ? config.llmFallbackApiKey : config.llmApiKey;
      const model = provider === config.llmFallbackProvider ? config.llmFallbackModel : config.llmModel;
      if (!apiKey) throw new Error("missing Gemini API key");
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${apiKey}`,
        {
          method: "POST",
          signal,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            contents: [{ parts: messages.map((message) => ({ text: message.content })) }],
            generationConfig: { maxOutputTokens: maxTokens },
          }),
        },
      );
      if (!response.ok) throw new Error(`gemini HTTP ${response.status}`);
      const data = (await response.json()) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
      return data.candidates?.[0]?.content?.parts?.[0]?.text || "";
    }

    const apiKey = config.llmApiKey || config.mimoApiKey;
    if (!apiKey) throw new Error("missing MiMo API key");
    const response = await fetch(`${config.llmApiBase.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      signal,
      headers: {
        "api-key": apiKey,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: config.llmModel,
        messages,
        max_tokens: maxTokens,
        ...(responseFormat ? { response_format: responseFormat } : {}),
      }),
    });
    if (!response.ok) throw new Error(`mimo HTTP ${response.status}`);
    const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }>; usage?: { total_tokens?: number } };
    if (data.usage?.total_tokens) this.store.addTokens(data.usage.total_tokens);
    return data.choices?.[0]?.message?.content || "";
  }
}
