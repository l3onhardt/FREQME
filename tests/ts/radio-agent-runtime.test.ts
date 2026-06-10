import assert from "node:assert/strict";
import test from "node:test";

import { RadioAgentRuntime } from "../../src/radio-agent/radioAgentRuntime.js";
import type {
  RadioAgentEvent,
  RadioAgentMemory,
  RadioAgentProgramWindow,
  RadioShadowDecision,
} from "../../src/radio-agent/types.js";

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
  assert.ok(artifact?.sourceVersion.startsWith("taste-distiller/v3-memory-merge"));
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
  assert.ok(contract?.content.includes("SZA"));
  assert.doesNotMatch(contract?.content ?? "", /Listener has|library evidence|Playlist titles repeatedly/i);
});

test("runtime folds completed listening back into durable agent profile context", async () => {
  const store = runtimeStore();
  const runtime = new RadioAgentRuntime({ mode: "assisted", store, now: () => "2026-06-03T01:02:03.000Z" });

  await runtime.handle({
    type: "session_restored",
    uid: "42",
    sessionId: 9,
    payload: { timezoneName: "Asia/Hong_Kong", localTimeBlock: "daytime" },
  });
  await runtime.handle({
    type: "track_completed",
    uid: "42",
    sessionId: 9,
    track: { id: "anyma-1", name: "Pictures Of You", artist: "Anyma" },
    readyQueue: [{ id: "next-1", name: "Queued", artist: "Queued Artist" }],
  });
  await runtime.handle({
    type: "track_completed",
    uid: "42",
    sessionId: 9,
    currentTrack: { id: "anyma-2", name: "Eternity", artist: "Anyma" },
    readyQueue: [{ id: "next-2", name: "Queued Again", artist: "Queued Artist" }],
  });

  const memory = store.memoryRows.find((item) => item.key === "session_artist:Anyma");
  assert.ok(memory);
  assert.equal(memory?.kind, "taste_hypothesis");
  assert.equal(memory?.evidenceCount, 2);
  assert.equal(memory?.evidenceRefs.length, 2);
  assert.ok(memory?.evidenceRefs.every((ref) => /^event:\d+$/.test(ref)));

  const profile = store.artifact("42", "user_profile.md");
  const contract = store.artifact("42", "program_contract.md");
  assert.match(profile?.content ?? "", /Anyma/);
  assert.match(contract?.content ?? "", /Anyma/);
  assert.match(profile?.sourceVersion ?? "", /sessionEvidence=0/);
});

test("runtime treats duplicate completed events for the same track as one listening signal", async () => {
  const store = runtimeStore();
  const runtime = new RadioAgentRuntime({ mode: "assisted", store, now: () => "2026-06-03T01:02:03.000Z" });

  await runtime.handle({
    type: "track_completed",
    uid: "42",
    sessionId: 9,
    track: { id: "sza-1", name: "Good Days", artist: "SZA" },
    readyQueue: [],
  });
  await runtime.handle({
    type: "track_completed",
    uid: "42",
    sessionId: 9,
    track: { id: "sza-1", name: "Good Days", artist: "SZA" },
    readyQueue: [],
  });

  assert.equal(store.events.filter((event) => event.type === "track_completed").length, 2);
  assert.equal(store.memoryRows.some((item) => item.key === "session_artist:SZA"), false);

  const reflection = store.artifact("42", "session_reflection.md");
  assert.equal((reflection?.content.match(/Good Days - SZA/g) || []).length, 1);
  assert.doesNotMatch(reflection?.content ?? "", /session_artist:SZA/);
});

test("runtime merges existing session hypotheses with new confirmations into durable taste facts", async () => {
  const store = runtimeStore();
  store.memoryRows.push({
    uid: "42",
    key: "session_artist:Frank Ocean",
    kind: "taste_hypothesis",
    value: "Recent completed listening repeatedly returned to Frank Ocean.",
    confidence: 0.72,
    evidenceCount: 2,
    evidenceRefs: ["event:10", "event:11"],
    updatedAt: "2026-06-02T23:00:00.000Z",
  });
  const runtime = new RadioAgentRuntime({ mode: "assisted", store, now: () => "2026-06-03T02:05:00.000Z" });

  await runtime.handle({
    type: "user_text",
    uid: "42",
    sessionId: 10,
    text: "play more Frank Ocean",
  });
  await runtime.handle({
    type: "track_completed",
    uid: "42",
    sessionId: 10,
    track: { id: "frank-3", name: "Ivy", artist: "Frank Ocean" },
    readyQueue: [{ id: "next-1", name: "Queued", artist: "Queued Artist" }],
  });

  const memory = store.memoryRows.find((item) => item.key === "artist:Frank Ocean");
  assert.ok(memory);
  assert.equal(memory?.kind, "taste_fact");
  assert.ok((memory?.evidenceRefs || []).includes("event:10"));
  assert.ok((memory?.evidenceRefs || []).some((ref) => /^event:\d+$/.test(ref) && ref !== "event:10" && ref !== "event:11"));

  const profile = store.artifact("42", "user_profile.md");
  assert.match(profile?.content ?? "", /durable preference anchor/);
  assert.match(profile?.sourceVersion ?? "", /taste-distiller\/v3-memory-merge/);
});

test("runtime writes session reflection artifact from completed and skipped playback", async () => {
  const store = runtimeStore();
  const runtime = new RadioAgentRuntime({ mode: "assisted", store, now: () => "2026-06-03T01:02:03.000Z" });

  await runtime.handle({
    type: "track_completed",
    uid: "42",
    sessionId: 9,
    track: { id: "anyma-1", name: "Pictures Of You", artist: "Anyma" },
    readyQueue: [{ id: "next-1", name: "Queued", artist: "Queued Artist" }],
  });
  await runtime.handle({
    type: "track_completed",
    uid: "42",
    sessionId: 9,
    track: { id: "anyma-2", name: "Eternity", artist: "Anyma" },
    readyQueue: [{ id: "next-2", name: "Queued Again", artist: "Queued Artist" }],
  });
  await runtime.handle({
    type: "track_skipped",
    uid: "42",
    sessionId: 9,
    track: { id: "bad-1", name: "Too Much", artist: "A" },
  });

  const reflection = store.artifact("42", "session_reflection.md");
  assert.match(reflection?.content ?? "", /# Session Reflection/);
  assert.match(reflection?.content ?? "", /Pictures Of You - Anyma/);
  assert.match(reflection?.content ?? "", /Eternity - Anyma/);
  assert.match(reflection?.content ?? "", /Too Much - A/);
  assert.match(reflection?.content ?? "", /session_artist:Anyma/);
  assert.match(reflection?.content ?? "", /single skip/i);
});

test("runtime records explicit listener text in the profile without promoting it to a stable fact", async () => {
  const store = runtimeStore();
  const runtime = new RadioAgentRuntime({ mode: "assisted", store, now: () => "2026-06-03T01:02:03.000Z" });

  await runtime.handle({
    type: "user_text",
    uid: "42",
    sessionId: 9,
    text: "more Anyma and less classical tonight",
  });

  const profile = store.artifact("42", "user_profile.md");
  assert.match(profile?.content ?? "", /Recent Session Evidence/);
  assert.match(profile?.content ?? "", /more Anyma and less classical tonight/);
  assert.equal(store.memoryRows.some((memory) => memory.kind === "taste_fact" && /Anyma|classical/i.test(memory.value)), false);
  assert.ok(store.memoryRows.some((memory) => memory.kind === "session_evidence" && memory.key === "explicit:user_text"));
});

test("runtime turns explicit negative artist feedback into session-only avoids", async () => {
  const store = runtimeStore();
  const runtime = new RadioAgentRuntime({ mode: "assisted", store, now: () => "2026-06-03T01:02:03.000Z" });

  await runtime.handle({
    type: "user_text",
    uid: "42",
    sessionId: 9,
    text: "不要Frank Ocean，less SZA tonight",
  });

  const reflection = store.artifact("42", "session_reflection.md");
  const session = store.artifact("42", "listener_session.md");
  assert.match(reflection?.content ?? "", /Temporary Avoids/);
  assert.match(reflection?.content ?? "", /## Temporary Avoids[\s\S]*- Frank Ocean/);
  assert.match(reflection?.content ?? "", /## Temporary Avoids[\s\S]*- SZA/);
  assert.match(session?.content ?? "", /Rejected Moves/);
  assert.match(session?.content ?? "", /## Rejected Moves[\s\S]*- Frank Ocean/);
  assert.match(session?.content ?? "", /## Rejected Moves[\s\S]*- SZA/);
  assert.equal(store.memoryRows.some((memory) => memory.kind === "taste_fact" && /Frank Ocean|SZA/.test(memory.value)), false);
});

test("runtime keeps an explicit R&B request in the program contract across later playback refreshes", async () => {
  const store = runtimeStore({
    memories: (uid: string, kind: string, limit: number) =>
      [
        {
          uid,
          key: "artist:Anyma",
          kind,
          value: "Listener has repeated library evidence for Anyma.",
          confidence: 0.91,
          evidenceCount: 6,
          evidenceRefs: ["track:anyma-1"],
          updatedAt: "2026-06-03T01:00:00.000Z",
        },
      ].slice(0, limit),
  });
  const runtime = new RadioAgentRuntime({ mode: "assisted", store, now: () => "2026-06-03T01:02:03.000Z" });

  await runtime.handle({
    type: "session_restored",
    uid: "42",
    sessionId: 9,
    payload: { timezoneName: "Asia/Hong_Kong", localTimeBlock: "daytime" },
  });
  await runtime.handle({
    type: "user_text",
    uid: "42",
    sessionId: 9,
    text: "play some rnb",
    currentTrack: { id: "old-1", name: "Says", artist: "Nils Frahm" },
  });
  await runtime.handle({
    type: "playback_started",
    uid: "42",
    sessionId: 9,
    track: { id: "edm-1", name: "Breakaway", artist: "Martin Garrix" },
  });

  const contract = store.artifact("42", "program_contract.md");
  assert.match(contract?.content ?? "", /R&B/i);
  assert.doesNotMatch(contract?.content ?? "", /station_goal:.*Anyma/i);
  assert.doesNotMatch(contract?.content ?? "", /Use adjacent electronic or ambient/i);
});

test("runtime keeps explicit positive artist requests in the current station contract", async () => {
  const store = runtimeStore({
    memories: (uid: string, kind: string, limit: number) =>
      [
        {
          uid,
          key: "artist:Anyma",
          kind,
          value: "Listener has repeated library evidence for Anyma.",
          confidence: 0.91,
          evidenceCount: 6,
          evidenceRefs: ["track:anyma-1"],
          updatedAt: "2026-06-03T01:00:00.000Z",
        },
      ].slice(0, limit),
  });
  const runtime = new RadioAgentRuntime({ mode: "assisted", store, now: () => "2026-06-03T01:02:03.000Z" });

  await runtime.handle({
    type: "user_text",
    uid: "42",
    sessionId: 9,
    text: "more Frank Ocean tonight",
  });
  await runtime.handle({
    type: "playback_started",
    uid: "42",
    sessionId: 9,
    track: { id: "old-1", name: "Pictures Of You", artist: "Anyma" },
  });

  const session = store.artifact("42", "listener_session.md");
  const contract = store.artifact("42", "program_contract.md");
  assert.match(session?.content ?? "", /active_request: Frank Ocean/i);
  assert.match(session?.content ?? "", /accepted_direction: Keep this session close to Frank Ocean/i);
  assert.match(session?.content ?? "", /Stay close to Frank Ocean until the listener asks to move elsewhere/i);
  assert.match(contract?.content ?? "", /station_goal: Keep the current radio session centered on Frank Ocean/i);
  assert.match(contract?.content ?? "", /Use Frank Ocean as the primary session anchor/i);
  assert.doesNotMatch(contract?.content ?? "", /station_goal:.*Anyma/i);
});

test("runtime lets the newest explicit artist request replace an older R&B session contract", async () => {
  const store = runtimeStore();
  const runtime = new RadioAgentRuntime({ mode: "assisted", store, now: () => "2026-06-03T01:02:03.000Z" });

  await runtime.handle({
    type: "user_text",
    uid: "42",
    sessionId: 9,
    text: "play some rnb",
  });
  await runtime.handle({
    type: "user_text",
    uid: "42",
    sessionId: 9,
    text: "actually more Frank Ocean tonight",
  });
  await runtime.handle({
    type: "playback_started",
    uid: "42",
    sessionId: 9,
    track: { id: "s1", name: "Snooze", artist: "SZA" },
  });

  const session = store.artifact("42", "listener_session.md");
  const contract = store.artifact("42", "program_contract.md");
  assert.match(session?.content ?? "", /active_request: Frank Ocean/i);
  assert.match(contract?.content ?? "", /station_goal: Keep the current radio session centered on Frank Ocean/i);
  assert.doesNotMatch(contract?.content ?? "", /station_goal: Keep the current radio session centered on R&B/i);
});

test("runtime lets the newest negative artist correction replace an older artist session contract", async () => {
  const store = runtimeStore();
  const runtime = new RadioAgentRuntime({ mode: "assisted", store, now: () => "2026-06-03T01:02:03.000Z" });

  await runtime.handle({
    type: "user_text",
    uid: "42",
    sessionId: 9,
    text: "more Frank Ocean tonight",
  });
  await runtime.handle({
    type: "user_text",
    uid: "42",
    sessionId: 9,
    text: "less Frank Ocean tonight",
  });
  await runtime.handle({
    type: "playback_started",
    uid: "42",
    sessionId: 9,
    track: { id: "s1", name: "Pink + White", artist: "Frank Ocean" },
  });

  const session = store.artifact("42", "listener_session.md");
  const contract = store.artifact("42", "program_contract.md");
  assert.match(session?.content ?? "", /active_request: Avoid Frank Ocean/i);
  assert.match(session?.content ?? "", /## Rejected Moves[\s\S]*- Frank Ocean/);
  assert.match(contract?.content ?? "", /station_goal: Move the current radio session away from Frank Ocean/i);
  assert.match(contract?.content ?? "", /Do not play Frank Ocean unless the listener asks for it again/i);
  assert.doesNotMatch(contract?.content ?? "", /station_goal: Keep the current radio session centered on Frank Ocean/i);
});

test("runtime writes current listener session memory for explicit R&B boundaries", async () => {
  const store = runtimeStore({
    memories: (uid: string, kind: string, limit: number) =>
      [
        {
          uid,
          key: "artist:Anyma",
          kind,
          value: "Listener has repeated library evidence for Anyma.",
          confidence: 0.91,
          evidenceCount: 6,
          evidenceRefs: ["track:anyma-1"],
          updatedAt: "2026-06-03T01:00:00.000Z",
        },
      ].slice(0, limit),
  });
  const runtime = new RadioAgentRuntime({ mode: "assisted", store, now: () => "2026-06-03T01:02:03.000Z" });

  await runtime.handle({
    type: "user_text",
    uid: "42",
    sessionId: 9,
    text: "放点 rnb，不要电子，不要古典",
  });
  await runtime.handle({
    type: "playback_started",
    uid: "42",
    sessionId: 9,
    track: { id: "old-1", name: "Says", artist: "Nils Frahm" },
  });

  const session = store.artifact("42", "listener_session.md");
  assert.match(session?.content ?? "", /active_request: R&B/i);
  assert.match(session?.content ?? "", /electronic|电子/i);
  assert.match(session?.content ?? "", /classical|古典/i);
  assert.match(session?.content ?? "", /Stay in R&B until the listener asks to move elsewhere/i);
  assert.doesNotMatch(session?.content ?? "", /active_request:.*Anyma/i);
});

test("runtime restores the previous active station contract after session restart", async () => {
  const store = runtimeStore({
    memories: () => [],
  });
  store.saveArtifact(
    "42",
    "listener_session.md",
    [
      "# Listener Session",
      "",
      "updated: 2026-06-03T00:55:00.000Z",
      "active_request: R&B",
      "accepted_direction: Keep the current session centered on R&B vocals.",
      "next_promise: Stay in R&B until the listener asks to move elsewhere.",
      "",
      "## Rejected Moves",
      "- generic electronic",
      "",
      "## Recent Corrections",
      "- User said: play some rnb",
      "",
      "## Open Hypotheses",
      "- The listener wants the current session to stay in R&B.",
      "",
      "## DJ Stance",
      "- Keep vocals and groove forward.",
    ].join("\n"),
    "listener-session/v1 session=9",
  );
  store.saveArtifact(
    "42",
    "program_contract.md",
    [
      "# Program Contract",
      "",
      "station_goal: Keep the current radio session centered on R&B until the listener asks to move elsewhere.",
      "",
      "## Allowed Moves",
      "- Prefer verified R&B, alt-R&B, neo-soul, and soft vocal tracks.",
      "",
      "## Blocked Moves",
      "- Do not fall back to EDM, classical, ambient piano, or old profile anchors unless they clearly support the R&B request.",
    ].join("\n"),
    "program-contract/v1 session=9",
  );
  const runtime = new RadioAgentRuntime({ mode: "assisted", store, now: () => "2026-06-03T01:02:03.000Z" });

  await runtime.handle({
    type: "session_restored",
    uid: "42",
    sessionId: 10,
    payload: { timezoneName: "Asia/Hong_Kong", localTimeBlock: "late_night" },
  });

  const session = store.artifact("42", "listener_session.md");
  const contract = store.artifact("42", "program_contract.md");
  assert.match(session?.content ?? "", /active_request: R&B/i);
  assert.match(session?.content ?? "", /Stay in R&B until the listener asks to move elsewhere/i);
  assert.doesNotMatch(session?.content ?? "", /active_request: none/i);
  assert.match(contract?.content ?? "", /station_goal: Keep the current radio session centered on R&B/i);
  assert.doesNotMatch(contract?.content ?? "", /Build a coherent late_night radio session/i);
});

test("runtime plans an agent-owned program window on queue low", async () => {
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
          evidenceRefs: ["track:s1"],
          updatedAt: "2026-06-03T01:02:03.000Z",
        },
      ].slice(0, limit),
  });
  store.saveArtifact("42", "user_profile.md", "# User Profile\nSZA", "taste-distiller/v3-memory-merge");
  store.saveArtifact("42", "station_now.md", "# Station Now\nlate_night", "station-context/v1");
  store.saveArtifact("42", "program_contract.md", "# Program Contract\nlate-night R&B", "program-contract/v1");
  store.saveArtifact("42", "listener_session.md", "# Listener Session\nactive_request: R&B\nnext_promise: stay inside R&B", "listener-session/v1");
  store.saveArtifact("42", "session_reflection.md", "# Session Reflection\n## Session Signals\n- session_artist:SZA", "session-reflection/v1");
  let receivedSnapshot: Record<string, unknown> | null = null;
  const programDirector = {
    plan: async (snapshot: Record<string, unknown>) => {
      receivedSnapshot = snapshot;
      return programWindow({
        candidateTasks: [{ query: "SZA Good Days", reason: "Known anchor.", style: "R&B", negativeConstraints: [] }],
        source: "model",
      });
    },
  };

  const runtime = new RadioAgentRuntime({
    mode: "assisted",
    store,
    programDirector,
    now: () => "2026-06-03T01:02:03.000Z",
  });
  const result = await runtime.handle({
    type: "queue_low",
    uid: "42",
    sessionId: 9,
    currentTrack: { id: "s1", name: "Good Days", artist: "SZA", raw: { secret: true } },
    readyQueue: [{ id: "s2", name: "Pink + White", artist: "Frank Ocean", raw: { secret: true } }],
    payload: {
      raw_json: { secret: true },
      track: { id: "s1", name: "Good Days", artist: "SZA", raw: { secret: true } },
    },
  });

  assert.equal(result.controlsPlayback, false);
  assert.equal(result.programWindow?.candidateTasks[0]?.query, "SZA Good Days");
  assert.ok(store.decisions.some((decision) => decision.decisionType === "program_window"));
  assert.equal(receivedSnapshot?.uid, "42");
  assert.equal(receivedSnapshot?.sessionId, 9);
  assert.equal(receivedSnapshot?.eventType, "queue_low");
  assert.match(String(receivedSnapshot?.profile), /SZA/);
  assert.match(String(receivedSnapshot?.now), /late_night/);
  assert.match(String(receivedSnapshot?.contract), /late-night R&B/);
  assert.match(String(receivedSnapshot?.session), /active_request: R&B/);
  assert.match(String(receivedSnapshot?.reflection), /session_artist:SZA/);
  assert.equal((receivedSnapshot?.memoryFacts as RadioAgentMemory[] | undefined)?.[0]?.key, "artist:SZA");
  assert.equal((receivedSnapshot?.currentTrack as Record<string, unknown> | null)?.name, "Good Days");
  assert.equal((receivedSnapshot?.currentTrack as Record<string, unknown> | null)?.raw, undefined);
  assert.equal(((receivedSnapshot?.readyQueue as Record<string, unknown>[] | undefined)?.[0] ?? {}).raw, undefined);
  assert.equal(((receivedSnapshot?.recentEvents as RadioAgentEvent[] | undefined)?.[0]?.payload ?? {}).raw_json, undefined);
});

test("runtime writes an agent journal after planning a program window", async () => {
  const store = runtimeStore({
    memories: (uid: string, kind: string, limit: number) =>
      [
        {
          uid,
          key: "artist:Frank Ocean",
          kind,
          value: "Listener explicitly asked for more Frank Ocean and completed repeated Frank Ocean listening.",
          confidence: 0.9,
          evidenceCount: 4,
          evidenceRefs: ["event:10"],
          updatedAt: "2026-06-03T01:02:03.000Z",
        },
      ].slice(0, limit),
  });
  store.saveArtifact("42", "program_contract.md", "# Program Contract\nstation_goal: late-night R&B\navoid: generic electronic", "program-contract/v1");
  store.saveArtifact(
    "42",
    "session_reflection.md",
    "# Session Reflection\n\n## Session Signals\n- session_artist:Frank Ocean: Recent completed listening repeatedly returned to Frank Ocean.\n\n## Temporary Avoids\n- generic electronic",
    "session-reflection/v1",
  );
  const runtime = new RadioAgentRuntime({
    mode: "assisted",
    store,
    programDirector: {
      plan: async () =>
        programWindow({
          mainDirection: "Stay close to Frank Ocean and keep late-night R&B coherent.",
          candidateTasks: [
            {
              query: "Frank Ocean Nights",
              reason: "Known durable R&B anchor.",
              style: "late-night R&B",
              negativeConstraints: ["generic electronic"],
            },
          ],
          hostIntent: {
            shouldSpeak: true,
            event: "return_to_contract",
            reason: "queue recovery",
            text: "我先顺着 Frank Ocean 的方向接一首，把电台稳住。",
          },
        }),
    },
    now: () => "2026-06-03T01:02:03.000Z",
  });

  await runtime.handle({
    type: "queue_low",
    uid: "42",
    sessionId: 9,
    currentTrack: { id: "frank-1", name: "Nights", artist: "Frank Ocean" },
    readyQueue: [],
  });

  const journal = store.artifact("42", "agent_journal.md");
  assert.match(journal?.content ?? "", /# Agent Journal/);
  assert.match(journal?.content ?? "", /queue_low/);
  assert.match(journal?.content ?? "", /Frank Ocean/);
  assert.match(journal?.content ?? "", /generic electronic/);
  assert.doesNotMatch(journal?.content ?? "", /prompt|JSON|tool call|shadow decision|model trace/i);
  assert.match(journal?.sourceVersion ?? "", /agent-journal\/v1/);
  assert.ok(runtime.status("42", 9).artifacts["agent_journal.md"]);
});

test("runtime status exposes safe agent journal and repair summaries", () => {
  const store = runtimeStore();
  store.saveArtifact(
    "42",
    "program_contract.md",
    [
      "# Program Contract",
      "",
      "station_goal: Keep the current radio session centered on R&B until the listener asks to move elsewhere.",
      "",
      "## Allowed Moves",
      "- Prefer verified R&B, alt-R&B, neo-soul, and soft vocal tracks.",
      "",
      "## Blocked Moves",
      "- Do not fall back to EDM, classical, ambient piano, or old profile anchors unless they clearly support the R&B request.",
      "- do not expose prompt or JSON trace",
    ].join("\n"),
    "program-contract/v1",
  );
  store.saveArtifact(
    "42",
    "agent_journal.md",
    [
      "# Agent Journal",
      "",
      "updated: 2026-06-03T01:02:03.000Z",
      "event: queue_low",
      "",
      "## Observation",
      "- Queue is low while Nick Drake is playing.",
      "",
      "## Interpretation",
      "- Keep the room intimate and acoustic.",
      "",
      "## Action",
      "- Next search direction: Nick Drake Pink Moon. Keep it acoustic.",
      "",
      "## Guardrails",
      "- avoid high-energy EDM",
      "- do not expose prompt or JSON trace",
      "",
      "## Next Check",
      "- Watch the next skip or completion.",
    ].join("\n"),
    "agent-journal/v1",
  );
  store.saveArtifact(
    "42",
    "agent_repair.md",
    [
      "# Agent Repair",
      "",
      "updated: 2026-06-03T01:02:03.000Z",
      "event: queue_low",
      "",
      "## Issue",
      "- Planned search violated the active station guardrails.",
      "",
      "## Evidence",
      "- Martin Garrix festival drops",
      "",
      "## Correction",
      "- Remove candidates that touch high-energy EDM.",
      "",
      "## Guardrails",
      "- avoid high-energy EDM",
      "",
      "## Next Attempt",
      "- Nick Drake Pink Moon",
    ].join("\n"),
    "agent-repair/v1",
  );
  const runtime = new RadioAgentRuntime({
    mode: "assisted",
    store,
    now: () => "2026-06-03T01:02:03.000Z",
  });

  const status = runtime.status("42", 9);

  assert.match(status.explainability?.journal?.observation ?? "", /Queue is low/);
  assert.match(status.explainability?.journal?.action ?? "", /Nick Drake Pink Moon/);
  assert.match(status.explainability?.repair?.issue ?? "", /guardrails/);
  assert.match(status.explainability?.repair?.nextAttempt ?? "", /Nick Drake Pink Moon/);
  assert.match(status.explainability?.contract?.stationGoal ?? "", /R&B/);
  assert.match(status.explainability?.contract?.allowedMoves?.[0] ?? "", /neo-soul/);
  assert.match(status.explainability?.contract?.blockedMoves?.[0] ?? "", /EDM/);
  assert.doesNotMatch(JSON.stringify(status.explainability), /prompt|JSON trace/i);
});

test("runtime status exposes whether assisted agent planning is fully available", () => {
  const store = runtimeStore();
  const runtime = new RadioAgentRuntime({
    mode: "assisted",
    store,
    readiness: {
      planner: "degraded",
      speech: "degraded",
      reason: "LLM and TTS are not configured; assisted agent is using deterministic fallback.",
    },
    now: () => "2026-06-03T01:02:03.000Z",
  });

  const status = runtime.status("42", 9);

  assert.equal(status.readiness.mode, "assisted");
  assert.equal(status.readiness.planner, "degraded");
  assert.equal(status.readiness.speech, "degraded");
  assert.match(status.readiness.summary, /assisted/i);
  assert.match(status.readiness.summary, /fallback/i);
  assert.doesNotMatch(JSON.stringify(status.readiness), /tp-|api[_-]?key|secret/i);
});

test("runtime self-repairs off-contract program windows before assisted execution", async () => {
  const store = runtimeStore();
  store.saveArtifact("42", "program_contract.md", "# Program Contract\nstation_goal: late-night R&B\navoid: generic electronic, classical chamber music", "program-contract/v1");
  store.saveArtifact(
    "42",
    "session_reflection.md",
    "# Session Reflection\n\n## Session Signals\n- session_artist:Frank Ocean: Recent completed listening repeatedly returned to Frank Ocean.\n\n## Temporary Avoids\n- generic electronic\n- classical chamber music",
    "session-reflection/v1",
  );
  const runtime = new RadioAgentRuntime({
    mode: "assisted",
    store,
    programDirector: {
      plan: async () =>
        programWindow({
          stationBrief: "late-night R&B",
          mainDirection: "Keep late-night R&B coherent.",
          candidateTasks: [
            {
              query: "Nils Frahm Says",
              reason: "Ambient piano bridge.",
              style: "ambient piano",
              negativeConstraints: [],
            },
            {
              query: "Debussy String Quartet",
              reason: "Classical chamber texture.",
              style: "classical",
              negativeConstraints: [],
            },
          ],
          disallowed: ["generic electronic", "classical chamber music"],
        }),
    },
    now: () => "2026-06-03T01:02:03.000Z",
  });

  const result = await runtime.handle({
    type: "queue_low",
    uid: "42",
    sessionId: 9,
    currentTrack: { id: "frank-1", name: "Nights", artist: "Frank Ocean" },
    readyQueue: [],
  });

  assert.match(result.programWindow?.candidateTasks[0]?.query ?? "", /Frank Ocean|SZA|Daniel Caesar|H\.E\.R\.|Brent Faiyaz/i);
  assert.doesNotMatch(result.programWindow?.candidateTasks.map((task) => task.query).join(" ") ?? "", /Nils Frahm|Debussy/i);
  assert.ok(store.decisions.some((decision) => decision.decisionType === "program_repair"));
  const repair = store.artifact("42", "agent_repair.md");
  assert.match(repair?.content ?? "", /# Agent Repair/);
  assert.match(repair?.content ?? "", /Nils Frahm/);
  assert.match(repair?.content ?? "", /late-night R&B|Frank Ocean|SZA/i);
  assert.match(repair?.sourceVersion ?? "", /agent-repair\/v1/);
  assert.ok(runtime.status("42", 9).artifacts["agent_repair.md"]);
});

test("runtime self-repairs generic avoid violations outside R&B contracts", async () => {
  const store = runtimeStore();
  store.saveArtifact(
    "42",
    "program_contract.md",
    "# Program Contract\nstation_goal: quiet late-night folk\navoid: high-energy EDM, festival drops",
    "program-contract/v1",
  );
  const runtime = new RadioAgentRuntime({
    mode: "assisted",
    store,
    programDirector: {
      plan: async () =>
        programWindow({
          stationBrief: "quiet late-night folk",
          mainDirection: "Keep the room intimate and acoustic.",
          candidateTasks: [
            {
              query: "Martin Garrix festival drops",
              reason: "High-energy festival lift.",
              style: "high-energy EDM",
              negativeConstraints: [],
            },
            {
              query: "Nick Drake Pink Moon",
              reason: "Quiet acoustic continuation.",
              style: "late-night folk",
              negativeConstraints: ["high-energy EDM"],
            },
          ],
          disallowed: ["high-energy EDM", "festival drops"],
          returnRequirement: "Stay acoustic and intimate.",
          traceBasis: {
            profile: "Nick Drake",
            now: "late_night",
            contract: "quiet late-night folk; avoid high-energy EDM and festival drops",
            eventType: "queue_low",
          },
        }),
    },
    now: () => "2026-06-03T01:02:03.000Z",
  });

  const result = await runtime.handle({
    type: "queue_low",
    uid: "42",
    sessionId: 9,
    currentTrack: { id: "folk-1", name: "Pink Moon", artist: "Nick Drake" },
    readyQueue: [],
  });

  assert.deepEqual(result.programWindow?.candidateTasks.map((task) => task.query), ["Nick Drake Pink Moon"]);
  assert.ok(store.decisions.some((decision) => decision.decisionType === "program_repair"));
  const repair = store.artifact("42", "agent_repair.md");
  assert.match(repair?.content ?? "", /high-energy EDM|festival drops/i);
  assert.match(repair?.content ?? "", /Martin Garrix festival drops/);
  assert.match(repair?.content ?? "", /Nick Drake Pink Moon/);
});

test("runtime records executor failure feedback as an agent repair", async () => {
  const store = runtimeStore();
  const runtime = new RadioAgentRuntime({
    mode: "assisted",
    store,
    now: () => "2026-06-03T01:02:03.000Z",
  });

  await runtime.handle({
    type: "program_repair_needed",
    uid: "42",
    sessionId: 9,
    reason: "program_executor_no_track",
    attemptedQueries: ["SZA Good Days", "Frank Ocean Pink + White"],
    programWindow: programWindow({
      id: "window-1",
      stationBrief: "late-night R&B",
      mainDirection: "Keep late-night R&B coherent.",
      candidateTasks: [
        { query: "SZA Good Days", reason: "Known anchor.", style: "R&B", negativeConstraints: [] },
      ],
    }),
  });

  assert.ok(store.events.some((event) => event.type === "program_repair_needed"));
  assert.ok(store.decisions.some((decision) => decision.decisionType === "execution_repair"));
  const repair = store.artifact("42", "agent_repair.md");
  assert.match(repair?.content ?? "", /# Agent Repair/);
  assert.match(repair?.content ?? "", /program_executor_no_track/);
  assert.match(repair?.content ?? "", /SZA Good Days/);
  assert.match(repair?.content ?? "", /Frank Ocean Pink \+ White/);
  assert.match(repair?.sourceVersion ?? "", /agent-repair\/v1/);
});

test("runtime replans immediately after program execution repair", async () => {
  const store = runtimeStore();
  const snapshots: Array<{ eventType?: string; repair?: string }> = [];
  const runtime = new RadioAgentRuntime({
    mode: "assisted",
    store,
    programDirector: {
      plan: async (snapshot: { eventType?: string; repair?: string }) => {
        snapshots.push(snapshot);
        return programWindow({
          id: "window-repaired",
          stationBrief: "late-night R&B recovery",
          mainDirection: "Return to late-night R&B.",
          candidateTasks: [
            {
              query: "Daniel Caesar Get You",
              reason: "Concrete R&B recovery after the failed query.",
              style: "R&B",
              negativeConstraints: [],
            },
          ],
        });
      },
    },
    now: () => "2026-06-03T01:02:03.000Z",
  });

  const result = await runtime.handle({
    type: "program_repair_needed",
    uid: "42",
    sessionId: 9,
    reason: "program_executor_no_track",
    attemptedQueries: ["SZA Good Days"],
    programWindow: programWindow({
      id: "window-1",
      stationBrief: "late-night R&B",
      mainDirection: "Keep late-night R&B coherent.",
      candidateTasks: [
        { query: "SZA Good Days", reason: "Known anchor.", style: "R&B", negativeConstraints: [] },
      ],
    }),
  });

  assert.equal(result.programWindow?.id, "window-repaired");
  assert.equal(snapshots[0]?.eventType, "program_repair_needed");
  assert.match(snapshots[0]?.repair ?? "", /SZA Good Days/);
  assert.match(snapshots[0]?.repair ?? "", /program_executor_no_track/);
});

test("runtime records playback recovery failure as agent repair evidence", async () => {
  const store = runtimeStore();
  const runtime = new RadioAgentRuntime({
    mode: "assisted",
    store,
    now: () => "2026-06-03T01:02:03.000Z",
  });

  await runtime.handle({
    type: "playback_recovery_needed",
    uid: "42",
    sessionId: 9,
    reason: "queue_empty_after_all_recovery",
    currentTrack: { id: "s1", name: "Good Days", artist: "SZA" },
    readyQueue: [],
  });

  assert.ok(store.events.some((event) => event.type === "playback_recovery_needed"));
  assert.ok(store.decisions.some((decision) => decision.decisionType === "execution_repair"));
  const repair = store.artifact("42", "agent_repair.md");
  assert.match(repair?.content ?? "", /# Agent Repair/);
  assert.match(repair?.content ?? "", /queue_empty_after_all_recovery/);
  assert.match(repair?.content ?? "", /Good Days - SZA/);
  assert.match(repair?.content ?? "", /concrete, playable song/i);
  assert.match(repair?.sourceVersion ?? "", /agent-repair\/v1/);
});

test("runtime includes latest agent repair artifact in the next planning snapshot", async () => {
  const store = runtimeStore();
  store.saveArtifact(
    "42",
    "agent_repair.md",
    "# Agent Repair\n\n## Evidence\n- SZA Good Days\n- Frank Ocean Pink + White\n\n## Next Attempt\n- Replan with safer concrete R&B songs.",
    "agent-repair/v1",
  );
  let receivedSnapshot: Record<string, unknown> | null = null;
  const runtime = new RadioAgentRuntime({
    mode: "assisted",
    store,
    programDirector: {
      plan: async (snapshot: Record<string, unknown>) => {
        receivedSnapshot = snapshot;
        return programWindow();
      },
    },
    now: () => "2026-06-03T01:02:03.000Z",
  });

  await runtime.handle({ type: "queue_low", uid: "42", sessionId: 9 });

  assert.match(String(receivedSnapshot?.repair), /SZA Good Days/);
  assert.match(String(receivedSnapshot?.repair), /Frank Ocean Pink \+ White/);
});

test("shadow mode records program windows but still never controls playback", async () => {
  const store = runtimeStore();
  const programDirector = {
    plan: async () =>
      programWindow({
        source: "deterministic_fallback",
      }),
  };

  const runtime = new RadioAgentRuntime({
    mode: "shadow",
    store,
    programDirector,
    now: () => "2026-06-03T01:02:03.000Z",
  });
  const result = await runtime.handle({ type: "queue_low", uid: "42", sessionId: 9 });

  assert.equal(result.controlsPlayback, false);
  assert.equal(result.programWindow?.source, "deterministic_fallback");
  assert.ok(store.decisions.some((decision) => decision.decisionType === "program_window"));
});

test("runtime plans on completed tracks only when the ready queue is under pressure", async () => {
  const store = runtimeStore();
  const plannedEventTypes: string[] = [];
  const programDirector = {
    plan: async (snapshot: { eventType: string }) => {
      plannedEventTypes.push(snapshot.eventType);
      return programWindow();
    },
  };
  const runtime = new RadioAgentRuntime({
    mode: "assisted",
    store,
    programDirector,
    now: () => "2026-06-03T01:02:03.000Z",
  });

  const queueLowResult = await runtime.handle({
    type: "track_completed",
    uid: "42",
    sessionId: 9,
    queueLow: true,
    currentTrack: { id: "s1", name: "Good Days", artist: "SZA" },
    readyQueue: [{ id: "s2", name: "Pink + White", artist: "Frank Ocean" }],
  });
  const emptyQueueResult = await runtime.handle({
    type: "track_completed",
    uid: "42",
    sessionId: 9,
    currentTrack: { id: "s1", name: "Good Days", artist: "SZA" },
    readyQueue: [],
  });
  const healthyQueueResult = await runtime.handle({
    type: "track_completed",
    uid: "42",
    sessionId: 9,
    currentTrack: { id: "s1", name: "Good Days", artist: "SZA" },
    readyQueue: [{ id: "s2", name: "Pink + White", artist: "Frank Ocean" }],
  });

  assert.equal(queueLowResult.programWindow?.id, "window-1");
  assert.equal(emptyQueueResult.programWindow?.id, "window-1");
  assert.equal(healthyQueueResult.programWindow, undefined);
  assert.deepEqual(plannedEventTypes, ["track_completed", "track_completed"]);
});

test("runtime keeps host decisions when no program director is configured", async () => {
  const store = runtimeStore();
  const runtime = new RadioAgentRuntime({
    mode: "assisted",
    store,
    now: () => "2026-06-03T01:02:03.000Z",
  });

  const result = await runtime.handle({ type: "queue_low", uid: "42", sessionId: 9 });

  assert.equal(result.controlsPlayback, false);
  assert.equal(result.programWindow, undefined);
  assert.ok(result.hostDecision);
  assert.ok(store.decisions.some((decision) => decision.decisionType === "host"));
});

test("runtime records assisted program track execution without replanning", async () => {
  const store = runtimeStore();
  let planCalls = 0;
  const runtime = new RadioAgentRuntime({
    mode: "assisted",
    store,
    programDirector: {
      plan: async () => {
        planCalls += 1;
        return programWindow();
      },
    },
    now: () => "2026-06-03T01:02:03.000Z",
  });

  const result = await runtime.handle({
    type: "program_track_queued",
    uid: "42",
    sessionId: 9,
    track: { id: "s1", name: "Good Days", artist: "SZA" },
    programWindowId: "window-1",
    traceId: "trace-1",
    selectionReason: "Known anchor.",
    hostText: "Keeping this close.",
  });

  assert.equal(result.controlsPlayback, false);
  assert.equal(result.programWindow, undefined);
  assert.equal(planCalls, 0);
  assert.ok(store.events.some((event) => event.type === "program_track_queued"));
  assert.equal(runtime.status("42", 9).recentEvents[0]?.type, "program_track_queued");

  const journal = store.artifact("42", "agent_journal.md");
  assert.match(journal?.content ?? "", /program_track_queued/);
  assert.match(journal?.content ?? "", /Good Days - SZA/);
  assert.match(journal?.content ?? "", /Known anchor/);
  assert.match(journal?.content ?? "", /decision id 1/);
  assert.match(journal?.content ?? "", /Watch whether the queued track plays, completes, or gets skipped/i);
  assert.doesNotMatch(journal?.content ?? "", /prompt|JSON|tool call|shadow decision|model trace|\btrace\b/i);
});

test("active mode controls playback when it produces an agent program window", async () => {
  const store = runtimeStore();
  const runtime = new RadioAgentRuntime({
    mode: "active",
    store,
    programDirector: { plan: async () => programWindow({ source: "deterministic_fallback" }) },
    now: () => "2026-06-03T01:02:03.000Z",
  });

  const result = await runtime.handle({ type: "queue_low", uid: "42", sessionId: 9 });

  assert.equal(result.controlsPlayback, true);
  assert.equal(result.programWindow?.source, "deterministic_fallback");
  assert.ok(store.decisions.some((decision) => decision.decisionType === "program_window"));
});

test("active mode does not claim playback control without an executable program window", async () => {
  const store = runtimeStore();
  const runtime = new RadioAgentRuntime({
    mode: "active",
    store,
    now: () => "2026-06-03T01:02:03.000Z",
  });

  const result = await runtime.handle({ type: "queue_low", uid: "42", sessionId: 9 });

  assert.equal(result.controlsPlayback, false);
  assert.equal(result.programWindow, undefined);
});

test("runtime status reports playback ownership in active mode", () => {
  const store = runtimeStore();
  const runtime = new RadioAgentRuntime({
    mode: "active",
    store,
    now: () => "2026-06-03T01:02:03.000Z",
  });

  const status = runtime.status("42", 9);

  assert.equal(status.controlsPlayback, true);
});

test("runtime keeps host decisions when program director planning fails", async () => {
  const store = runtimeStore();
  const runtime = new RadioAgentRuntime({
    mode: "assisted",
    store,
    programDirector: {
      plan: async () => {
        throw new Error("planner down");
      },
    },
    now: () => "2026-06-03T01:02:03.000Z",
  });

  const result = await runtime.handle({ type: "queue_low", uid: "42", sessionId: 9 });

  assert.equal(result.controlsPlayback, false);
  assert.equal(result.programWindow, undefined);
  assert.ok(result.hostDecision);
  assert.equal(store.decisions.some((decision) => decision.decisionType === "program_window"), false);
  assert.ok(store.decisions.some((decision) => decision.decisionType === "host"));
});

function programWindow(overrides: Partial<RadioAgentProgramWindow> = {}): RadioAgentProgramWindow {
  return {
    id: "window-1",
    uid: "42",
    sessionId: 9,
    stationBrief: "Keep late-night R&B coherent.",
    mainDirection: "late-night R&B",
    allowedAdjacent: ["alt-R&B"],
    bridgeBudget: 1,
    disallowed: ["classical chamber music"],
    returnRequirement: "Return to vocal R&B.",
    candidateTasks: [{ query: "SZA Good Days", reason: "Known anchor.", style: "R&B", negativeConstraints: [] }],
    hostIntent: { shouldSpeak: false, event: "silent", reason: "ordinary continuation", text: "" },
    traceBasis: { profile: "SZA", now: "late_night", contract: "late-night R&B", eventType: "queue_low" },
    source: "model",
    createdAt: "2026-06-03T01:02:03.000Z",
    ...overrides,
  };
}
