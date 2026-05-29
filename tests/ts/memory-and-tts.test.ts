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

test("failed audio proxy removes stale cached song url", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "freqme-test-"));
  const db = new AppDatabase(path.join(dir, "test.db"));
  const store = new MemoryStore(db);

  store.saveAudioResolution("song-b", "https://example.test/stale.mp3", "song_url", "audio/mpeg");
  assert.equal(store.getAudioResolution("song-b")?.url, "https://example.test/stale.mp3");

  store.deleteAudioResolution("song-b");
  store.logPlaybackEvent("playback_failed", { uid: "42", songId: "song-b", reason: "upstream 403" });

  assert.equal(store.getAudioResolution("song-b"), null);
  assert.equal(store.wasTrackRecentlyFailed("song-b", "42"), true);
});

test("audio resolution exposes cache age for expiry decisions", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "freqme-test-"));
  const db = new AppDatabase(path.join(dir, "test.db"));
  const store = new MemoryStore(db);

  store.saveAudioResolution("song-c", "https://example.test/fresh.mp3", "song_url", "audio/mpeg");

  assert.match(store.getAudioResolution("song-c")?.updatedAt || "", /^\d{4}-\d{2}-\d{2}/);
});

test("auth accounts keep separate cookies for account switching", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "freqme-test-"));
  const db = new AppDatabase(path.join(dir, "test.db"));
  const store = new MemoryStore(db);

  store.saveAuthAccount("42", { userId: 42, nickname: "First" }, "cookie-a");
  store.saveAuthAccount("99", { userId: 99, nickname: "Second" }, "cookie-b");
  store.saveAuthAccount("42", { userId: 42, nickname: "First Updated" });

  assert.equal(store.getAuthCookie("42"), "cookie-a");
  assert.equal(store.getAuthCookie("99"), "cookie-b");
  assert.deepEqual(
    store.listAuthAccounts().map((account) => account.uid).sort(),
    ["42", "99"],
  );
  assert.equal(store.getAuthAccount("42")?.nickname, "First Updated");
});

test("database upgrades auth_account with cookie column", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "freqme-test-"));
  const dbPath = path.join(dir, "test.db");
  const first = new AppDatabase(dbPath);
  first.db.exec("CREATE TABLE legacy_auth_account (uid TEXT PRIMARY KEY)");

  const second = new AppDatabase(dbPath);
  const columns = second.db.prepare("PRAGMA table_info(auth_account)").all() as Array<{ name?: string }>;

  assert.ok(columns.some((column) => column.name === "cookie"));
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
