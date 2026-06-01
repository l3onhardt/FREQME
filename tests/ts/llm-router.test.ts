import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { config } from "../../src/config.js";
import { LLMRouter } from "../../src/services/llmRouter.js";
import { AppDatabase } from "../../src/storage/database.js";
import { MemoryStore } from "../../src/storage/memoryStore.js";

test("anthropic-compatible fallback uses configured endpoint and api-key auth", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "freqme-test-"));
  const store = new MemoryStore(new AppDatabase(path.join(dir, "test.db")));
  const router = new LLMRouter(store);
  const previousConfig = {
    provider: config.llmProvider,
    fallbackProvider: config.llmFallbackProvider,
    fallbackKey: config.llmFallbackApiKey,
    fallbackModel: config.llmFallbackModel,
    fallbackBase: (config as any).llmFallbackApiBase,
  };
  const previousFetch = globalThis.fetch;
  let requestUrl = "";
  let requestHeaders: Record<string, string> = {};
  let requestBody: any = null;

  config.llmProvider = "anthropic";
  config.llmFallbackProvider = "anthropic";
  config.llmFallbackApiKey = "test-mimo-key";
  config.llmFallbackModel = "claude-sonnet-4-6";
  (config as any).llmFallbackApiBase = "https://token-plan-sgp.xiaomimimo.com/anthropic/v1";
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    requestUrl = String(url);
    requestHeaders = init?.headers as Record<string, string>;
    requestBody = JSON.parse(String(init?.body || "{}"));
    return {
      ok: true,
      json: async () => ({ content: [{ text: "ok" }] }),
    } as Response;
  }) as typeof fetch;

  try {
    const result = await router.chat("hello", { system: "system prompt", maxTokens: 12 });

    assert.equal(result, "ok");
    assert.equal(requestUrl, "https://token-plan-sgp.xiaomimimo.com/anthropic/v1/messages");
    assert.equal(requestHeaders["api-key"], "test-mimo-key");
    assert.equal(requestBody.system, "system prompt");
    assert.deepEqual(requestBody.messages, [{ role: "user", content: "hello" }]);
  } finally {
    globalThis.fetch = previousFetch;
    config.llmProvider = previousConfig.provider;
    config.llmFallbackProvider = previousConfig.fallbackProvider;
    config.llmFallbackApiKey = previousConfig.fallbackKey;
    config.llmFallbackModel = previousConfig.fallbackModel;
    (config as any).llmFallbackApiBase = previousConfig.fallbackBase;
  }
});
