import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { AppDatabase } from "../../src/storage/database.js";
import { MemoryStore } from "../../src/storage/memoryStore.js";
import { DecisionTraceStore } from "../../src/radio/decisionTraceStore.js";
import type { DecisionTrace } from "../../src/radio/radioBrainTypes.js";

let dbCounter = 0;

function trace(overrides: Partial<DecisionTrace> = {}): DecisionTrace {
  return {
    id: "trace-1",
    uid: "42",
    sessionId: 7,
    episodeId: "episode-1",
    intentType: "music_direction_request",
    profileQuality: { level: "usable", score: 0.6, reasons: [] },
    environment: { scene: "夜晚", localTimeBlock: "night", summary: "夜晚" },
    selectedTrack: { id: "song-1", name: "Says", artist: "Nils Frahm" },
    reason: "安静、无人声，适合专注。",
    rejectedCandidates: ["loud-1"],
    verificationAttempts: ["Nils Frahm Says"],
    fallbackLevel: "episode_primary",
    latencyMs: { planning: 1200, verification: 500 },
    hostText: "这首用来把工作流压稳。",
    createdAt: "2026-06-01T00:00:00.000Z",
    ...overrides,
  };
}

function traces(): DecisionTraceStore {
  const db = new AppDatabase(path.join(os.tmpdir(), `freqme-trace-${Date.now()}-${dbCounter++}.db`));
  const store = new MemoryStore(db);
  return new DecisionTraceStore(store);
}

test("decision trace round-trips through sqlite", () => {
  const traceStore = traces();

  traceStore.save(trace());
  const latest = traceStore.latestForSession("42", 7);

  assert.equal(latest?.id, "trace-1");
  assert.equal(latest?.selectedTrack.name, "Says");
  assert.equal(latest?.fallbackLevel, "episode_primary");
});

test("latest trace uses insertion order when timestamps match", () => {
  const traceStore = traces();
  const createdAt = "2026-06-01T00:00:00.000Z";

  traceStore.save(trace({ id: "trace-old", createdAt }));
  traceStore.save(trace({
    id: "trace-new",
    createdAt,
    selectedTrack: { id: "song-2", name: "Near Light", artist: "Olafur Arnalds" },
  }));

  const latest = traceStore.latestForSession("42", 7);

  assert.equal(latest?.id, "trace-new");
  assert.equal(latest?.selectedTrack.name, "Near Light");
});

test("anonymous traces do not mix with identified user traces", () => {
  const traceStore = traces();

  traceStore.save(trace({ id: "anonymous", uid: null }));
  traceStore.save(trace({ id: "identified", uid: "42" }));

  assert.equal(traceStore.latestForSession(null, 7)?.id, "anonymous");
  assert.equal(traceStore.latestForSession("42", 7)?.id, "identified");
});

test("sessionless traces do not mix with session traces", () => {
  const traceStore = traces();

  traceStore.save(trace({ id: "sessionless", sessionId: null }));
  traceStore.save(trace({ id: "session-7", sessionId: 7 }));

  assert.equal(traceStore.latestForSession("42", null)?.id, "sessionless");
  assert.equal(traceStore.latestForSession("42", 7)?.id, "session-7");
});

test("different users and sessions do not mix", () => {
  const traceStore = traces();

  traceStore.save(trace({ id: "user-42-session-7", uid: "42", sessionId: 7 }));
  traceStore.save(trace({ id: "user-99-session-7", uid: "99", sessionId: 7 }));
  traceStore.save(trace({ id: "user-42-session-8", uid: "42", sessionId: 8 }));

  assert.equal(traceStore.latestForSession("42", 7)?.id, "user-42-session-7");
  assert.equal(traceStore.latestForSession("99", 7)?.id, "user-99-session-7");
  assert.equal(traceStore.latestForSession("42", 8)?.id, "user-42-session-8");
});
