import assert from "node:assert/strict";
import test from "node:test";

import { RadioAgentRuntime } from "../../src/radio-agent/radioAgentRuntime.js";
import type { RadioAgentEvent, RadioAgentMemory, RadioShadowDecision } from "../../src/radio-agent/types.js";

function runtimeStore(overrides: Record<string, unknown> = {}) {
  const events: RadioAgentEvent[] = [];
  const memoryRows: RadioAgentMemory[] = [];
  const artifacts = new Map<string, { content: string; sourceVersion: string; updatedAt: string }>();
  const decisions: RadioShadowDecision[] = [];
  const store = {
    events,
    memoryRows,
    artifacts,
    decisions,
    appendEvent: (event: RadioAgentEvent) => {
      const persisted = { ...event, id: events.length + 1 };
      events.push(persisted);
      return persisted.id;
    },
    recentEvents: (uid: string | null, sessionId: number | null, limit: number) =>
      events
        .filter((event) => (uid == null ? event.uid == null : event.uid === uid))
        .filter((event) => (sessionId == null ? event.sessionId == null : event.sessionId === sessionId))
        .slice(-limit)
        .reverse(),
    upsertMemory: (memory: RadioAgentMemory) => {
      const existing = memoryRows.findIndex((item) => item.uid === memory.uid && item.key === memory.key);
      if (existing >= 0) memoryRows[existing] = memory;
      else memoryRows.push(memory);
    },
    memories: (uid: string, kind: string, limit: number) =>
      memoryRows.filter((memory) => memory.uid === uid && memory.kind === kind).slice(0, limit),
    saveArtifact: (uid: string, artifactKey: string, content: string, sourceVersion: string) => {
      artifacts.set(`${uid}:${artifactKey}`, { content, sourceVersion, updatedAt: "2026-06-03T01:02:03.000Z" });
    },
    artifact: (uid: string, artifactKey: string) => {
      const artifact = artifacts.get(`${uid}:${artifactKey}`);
      return artifact ? { uid, artifactKey, ...artifact } : null;
    },
    saveShadowDecision: (decision: RadioShadowDecision) => {
      decisions.push(decision);
    },
    latestShadowDecisions: (uid: string | null, sessionId: number | null, limit: number) =>
      decisions
        .filter((decision) => (uid == null ? decision.uid == null : decision.uid === uid))
        .filter((decision) => (sessionId == null ? decision.sessionId == null : decision.sessionId === sessionId))
        .slice(-limit)
        .reverse(),
    playlists: () => [],
    libraryTracks: () => [],
    ...overrides,
  };
  return store;
}

test("shadow runtime persists login event and schedules library scan", async () => {
  const events: string[] = [];
  const decisions: string[] = [];
  const store = {
    appendEvent: (event: { type: string }) => {
      events.push(event.type);
      return events.length;
    },
    recentEvents: () => [],
    upsertMemory: () => undefined,
    memories: () => [],
    saveArtifact: () => undefined,
    artifact: () => null,
    saveShadowDecision: (decision: { decisionType: string }) => {
      decisions.push(decision.decisionType);
    },
    latestShadowDecisions: () => [],
  };
  const census = { scan: async () => ({ playlistsScanned: 0, tracksScanned: 0, failures: [] }) };

  const runtime = new RadioAgentRuntime({ mode: "shadow", store, census, now: () => "2026-06-03T01:02:03.000Z" });
  const result = await runtime.handle({ type: "login_completed", uid: "42", sessionId: 1 });

  assert.equal(result.controlsPlayback, false);
  assert.deepEqual(events.slice(0, 2), ["login_completed", "library_scan_requested"]);
  assert.ok(events.includes("library_scan_completed"));
  assert.ok(decisions.includes("host"));
});

test("shadow runtime handles library scan failure without taking playback control", async () => {
  const events: string[] = [];
  const store = {
    appendEvent: (event: { type: string }) => {
      events.push(event.type);
      return events.length;
    },
    recentEvents: () => [],
    upsertMemory: () => undefined,
    memories: () => [],
    saveArtifact: () => undefined,
    artifact: () => null,
    saveShadowDecision: () => undefined,
    latestShadowDecisions: () => [],
  };
  const census = { scan: async () => { throw new Error("network down"); } };

  const runtime = new RadioAgentRuntime({ mode: "shadow", store, census, now: () => "2026-06-03T01:02:03.000Z" });
  const result = await runtime.handle({ type: "login_completed", uid: "42", sessionId: 1 });
  await runtime.flushBackgroundWork();

  assert.equal(result.controlsPlayback, false);
  assert.ok(events.includes("radio_agent_library_scan_failed"));
});

test("runtime does not start duplicate library scans while one is already running", async () => {
  const events: string[] = [];
  let scans = 0;
  let resolveScan: (() => void) | null = null;
  const store = {
    appendEvent: (event: { type: string }) => {
      events.push(event.type);
      return events.length;
    },
    recentEvents: () => [],
    upsertMemory: () => undefined,
    memories: () => [],
    saveArtifact: () => undefined,
    artifact: () => null,
    saveShadowDecision: () => undefined,
    latestShadowDecisions: () => [],
  };
  const census = {
    scan: async () => {
      scans += 1;
      await new Promise<void>((resolve) => {
        resolveScan = resolve;
      });
      return { playlistsScanned: 1, tracksScanned: 1, failures: [] };
    },
  };

  const runtime = new RadioAgentRuntime({ mode: "shadow", store, census, now: () => "2026-06-03T01:02:03.000Z" });
  await runtime.handle({ type: "login_completed", uid: "42", sessionId: 1 });
  await runtime.handle({ type: "login_completed", uid: "42", sessionId: 1 });

  assert.equal(scans, 1);
  assert.equal(events.filter((event) => event === "library_scan_requested").length, 1);
  resolveScan?.();
  await runtime.flushBackgroundWork();
  assert.equal(events.filter((event) => event === "library_scan_completed").length, 1);
});

test("runtime skips full library scan when a recent completed scan is fresh", async () => {
  const events: string[] = [];
  let scans = 0;
  const store = {
    appendEvent: (event: { type: string }) => {
      events.push(event.type);
      return events.length;
    },
    recentEvents: () => [
      {
        uid: "42",
        sessionId: null,
        type: "library_scan_completed",
        priority: "warm",
        payload: { result: { playlistsScanned: 50, tracksScanned: 6458, failures: [] } },
        createdAt: "2026-06-03T00:30:00.000Z",
      },
    ],
    upsertMemory: () => undefined,
    memories: () => [],
    saveArtifact: () => undefined,
    artifact: () => null,
    saveShadowDecision: () => undefined,
    latestShadowDecisions: () => [],
  };
  const census = {
    scan: async () => {
      scans += 1;
      return { playlistsScanned: 1, tracksScanned: 1, failures: [] };
    },
  };

  const runtime = new RadioAgentRuntime({ mode: "shadow", store, census, now: () => "2026-06-03T01:02:03.000Z" });
  await runtime.handle({ type: "login_completed", uid: "42" });
  await runtime.flushBackgroundWork();

  assert.equal(scans, 0);
  assert.equal(events.filter((event) => event === "library_scan_requested").length, 0);
});

test("runtime backfills a missing profile from a fresh existing library scan", async () => {
  let scans = 0;
  const store = runtimeStore({
    recentEvents: (uid: string | null, sessionId: number | null, limit: number) =>
      [
        {
          uid,
          sessionId,
          type: "library_scan_completed",
          priority: "warm",
          payload: { result: { playlistsScanned: 2, tracksScanned: 3, failures: [] } },
          createdAt: "2026-06-03T00:30:00.000Z",
        },
      ].slice(0, limit),
    playlists: () => [
      { uid: "42", playlistId: "p1", name: "late night rnb", raw: {}, scannedAt: "" },
      { uid: "42", playlistId: "p2", name: "soft night", raw: {}, scannedAt: "" },
    ],
    libraryTracks: () => [
      { uid: "42", playlistId: "p1", songId: "1", songName: "A", artist: "SZA", album: "", source: {}, scannedAt: "" },
      { uid: "42", playlistId: "p1", songId: "2", songName: "B", artist: "SZA", album: "", source: {}, scannedAt: "" },
    ],
  });
  const census = {
    scan: async () => {
      scans += 1;
      return { playlistsScanned: 1, tracksScanned: 1, failures: [] };
    },
  };

  const runtime = new RadioAgentRuntime({ mode: "shadow", store, census, now: () => "2026-06-03T01:02:03.000Z" });
  await runtime.handle({ type: "login_completed", uid: "42" });
  await runtime.flushBackgroundWork();

  assert.equal(scans, 0);
  assert.ok(store.artifact("42", "user_profile.md")?.content.includes("SZA"));
  assert.ok(store.memoryRows.some((memory) => memory.key === "artist:SZA"));
});

test("runtime refreshes stale profile artifact versions from existing library evidence", async () => {
  const store = runtimeStore({
    recentEvents: (uid: string | null, sessionId: number | null, limit: number) =>
      [
        {
          uid,
          sessionId,
          type: "library_scan_completed",
          priority: "warm",
          payload: { result: { playlistsScanned: 2, tracksScanned: 3, failures: [] } },
          createdAt: "2026-06-03T00:30:00.000Z",
        },
      ].slice(0, limit),
    playlists: () => [{ uid: "42", playlistId: "p1", name: "late night rnb", raw: {}, scannedAt: "" }],
    libraryTracks: () => [
      { uid: "42", playlistId: "p1", songId: "1", songName: "A", artist: "SZA", album: "", source: {}, scannedAt: "" },
      { uid: "42", playlistId: "p1", songId: "2", songName: "B", artist: "SZA", album: "", source: {}, scannedAt: "" },
    ],
  });
  store.saveArtifact("42", "user_profile.md", "# huge old profile\n", "taste-distiller/v1 tracks=6458 playlists=50");

  const runtime = new RadioAgentRuntime({ mode: "shadow", store, now: () => "2026-06-03T01:02:03.000Z" });
  await runtime.handle({ type: "login_completed", uid: "42" });

  const artifact = store.artifact("42", "user_profile.md");
  assert.ok(artifact?.content.includes("SZA"));
  assert.ok(artifact?.sourceVersion.startsWith("taste-distiller/v2-compact"));
});

test("runtime writes skip session evidence as a shadow decision", async () => {
  const decisions: Array<{ decisionType: string; payload: Record<string, unknown> }> = [];
  const store = {
    appendEvent: () => 1,
    recentEvents: () => [],
    upsertMemory: () => undefined,
    memories: () => [],
    saveArtifact: () => undefined,
    artifact: () => null,
    saveShadowDecision: (decision: { decisionType: string; payload: Record<string, unknown> }) => {
      decisions.push(decision);
    },
    latestShadowDecisions: () => [],
  };

  const runtime = new RadioAgentRuntime({ mode: "shadow", store, now: () => "2026-06-03T01:02:03.000Z" });
  const result = await runtime.handle({
    type: "track_skipped",
    uid: "42",
    sessionId: 1,
    track: { id: "bad-1", name: "Bad", artist: "A" },
  });

  assert.equal(result.controlsPlayback, false);
  assert.ok(decisions.some((decision) => decision.decisionType === "session_evidence"));
});

test("runtime distills library scan results into durable profile artifacts", async () => {
  const store = runtimeStore({
    playlists: () => [
      { uid: "42", playlistId: "p1", name: "late night rnb", raw: {}, scannedAt: "" },
      { uid: "42", playlistId: "p2", name: "soft night", raw: {}, scannedAt: "" },
    ],
    libraryTracks: () => [
      { uid: "42", playlistId: "p1", songId: "1", songName: "A", artist: "SZA", album: "", source: {}, scannedAt: "" },
      { uid: "42", playlistId: "p1", songId: "2", songName: "B", artist: "SZA", album: "", source: {}, scannedAt: "" },
      { uid: "42", playlistId: "p2", songId: "3", songName: "C", artist: "Frank Ocean", album: "", source: {}, scannedAt: "" },
    ],
  });
  const census = { scan: async () => ({ playlistsScanned: 2, tracksScanned: 3, failures: [] }) };

  const runtime = new RadioAgentRuntime({ mode: "shadow", store, census, now: () => "2026-06-03T01:02:03.000Z" });
  await runtime.handle({ type: "login_completed", uid: "42" });
  await runtime.flushBackgroundWork();

  const profile = store.artifact("42", "user_profile.md");
  assert.ok(profile?.content.includes("Listener has repeated library evidence for SZA."));
  assert.ok(store.memoryRows.some((memory) => memory.kind === "taste_fact" && memory.key === "artist:SZA"));
  assert.ok(store.events.some((event) => event.type === "profile_artifacts_refreshed"));
});

test("runtime refreshes station context and program contract from playback events", async () => {
  const store = runtimeStore({
    memories: (uid: string, kind: string, limit: number) =>
      [
        {
          uid,
          key: "artist:SZA",
          kind,
          value: "Listener has repeated library evidence for SZA.",
          confidence: 0.84,
          evidenceCount: 4,
          evidenceRefs: ["track:1"],
          updatedAt: "2026-06-03T01:02:03.000Z",
        },
      ].slice(0, limit),
  });

  const runtime = new RadioAgentRuntime({ mode: "shadow", store, now: () => "2026-06-03T01:02:03.000Z" });
  await runtime.handle({
    type: "session_restored",
    uid: "42",
    sessionId: 9,
    payload: { timezoneName: "Asia/Hong_Kong", localTimeBlock: "late_night", scene: "深夜" },
  });
  await runtime.handle({
    type: "playback_started",
    uid: "42",
    sessionId: 9,
    track: { id: "s1", name: "Good Days", artist: "SZA" },
  });

  const stationNow = store.artifact("42", "station_now.md");
  const contract = store.artifact("42", "program_contract.md");
  assert.ok(stationNow?.content.includes("Asia/Hong_Kong"));
  assert.ok(stationNow?.content.includes("Good Days - SZA"));
  assert.ok(contract?.content.includes("Listener has repeated library evidence for SZA."));
});
