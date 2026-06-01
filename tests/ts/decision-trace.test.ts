import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { AppDatabase } from "../../src/storage/database.js";
import { MemoryStore } from "../../src/storage/memoryStore.js";
import { DecisionTraceStore } from "../../src/radio/decisionTraceStore.js";
import type { DecisionTrace } from "../../src/radio/radioBrainTypes.js";

function trace(): DecisionTrace {
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
  };
}

test("decision trace round-trips through sqlite", () => {
  const db = new AppDatabase(path.join(os.tmpdir(), `freqme-trace-${Date.now()}.db`));
  const store = new MemoryStore(db);
  const traces = new DecisionTraceStore(store);

  traces.save(trace());
  const latest = traces.latestForSession("42", 7);

  assert.equal(latest?.id, "trace-1");
  assert.equal(latest?.selectedTrack.name, "Says");
  assert.equal(latest?.fallbackLevel, "episode_primary");
});
