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
  store.saveArtifact("42", "user_profile.md", "# User Profile\nSZA", "taste-distiller/v2-compact");
  store.saveArtifact("42", "station_now.md", "# Station Now\nlate_night", "station-context/v1");
  store.saveArtifact("42", "program_contract.md", "# Program Contract\nlate-night R&B", "program-contract/v1");
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
  assert.equal((receivedSnapshot?.memoryFacts as RadioAgentMemory[] | undefined)?.[0]?.key, "artist:SZA");
  assert.equal((receivedSnapshot?.currentTrack as Record<string, unknown> | null)?.name, "Good Days");
  assert.equal((receivedSnapshot?.currentTrack as Record<string, unknown> | null)?.raw, undefined);
  assert.equal(((receivedSnapshot?.readyQueue as Record<string, unknown>[] | undefined)?.[0] ?? {}).raw, undefined);
  assert.equal(((receivedSnapshot?.recentEvents as RadioAgentEvent[] | undefined)?.[0]?.payload ?? {}).raw_json, undefined);
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

test("active mode records program windows but still never controls playback", async () => {
  const store = runtimeStore();
  const runtime = new RadioAgentRuntime({
    mode: "active",
    store,
    programDirector: { plan: async () => programWindow({ source: "deterministic_fallback" }) },
    now: () => "2026-06-03T01:02:03.000Z",
  });

  const result = await runtime.handle({ type: "queue_low", uid: "42", sessionId: 9 });

  assert.equal(result.controlsPlayback, false);
  assert.equal(result.programWindow?.source, "deterministic_fallback");
  assert.ok(store.decisions.some((decision) => decision.decisionType === "program_window"));
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
