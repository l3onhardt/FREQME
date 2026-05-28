import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { AppDatabase } from "../../src/storage/database.js";
import { MemoryStore } from "../../src/storage/memoryStore.js";
import { TTSService } from "../../src/services/ttsService.js";

test("memory stores session feedback without turning one skip into permanent dislike", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "freqme-test-"));
  const db = new AppDatabase(path.join(dir, "test.db"));
  const store = new MemoryStore(db);

  store.logPlaybackEvent("skipped", { uid: "42", songId: "song-a" });
  assert.equal(store.wasTrackRecentlyFailed("song-a", "42"), false);

  store.logPlaybackEvent("url_failed", { uid: "42", songId: "song-b" });
  assert.equal(store.wasTrackRecentlyFailed("song-b", "42"), true);
});

test("tts failure returns a stable hash and does not throw", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "freqme-test-"));
  const db = new AppDatabase(path.join(dir, "test.db"));
  const store = new MemoryStore(db);
  const tts = new TTSService(store);

  const result = await tts.synthesize("电台继续播。", "日常", "warm_female", {});
  assert.match(result.hash, /^[a-f0-9]{32}$/);
  assert.equal(typeof result.ok, "boolean");
});

