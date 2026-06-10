import assert from "node:assert/strict";
import test from "node:test";

import { RadioAgentService } from "../../src/radio-agent/radioAgentService.js";
import type { OpeningTrackPick } from "../../src/radio-agent/openingTrack.js";
import type { RadioAgentHandleResult, RadioAgentPreparedTrack, RadioAgentProgramWindow } from "../../src/radio-agent/types.js";
import type { SelectionReason, Track } from "../../src/types.js";

test("service starts a session with an opening track before background planning", async () => {
  const calls: string[] = [];
  const openingTrack: Track = { id: "liked-1", name: "Pink + White", artist: "Frank Ocean" };
  const preparedTrack = prepared(openingTrack);
  let releaseBackgroundPlanning: (() => void) | null = null;
  const backgroundPlanningStarted = new Promise<void>((resolve) => {
    releaseBackgroundPlanning = resolve;
  });
  let backgroundPlanningFinished = false;
  const service = new RadioAgentService({
    chooseOpeningTrack: () => {
      calls.push("choose-opening");
      return {
        track: openingTrack,
        reason: { type: "radio_agent_opening_liked", sourceRank: 3 },
      } satisfies OpeningTrackPick;
    },
    prepareTrack: async (track) => {
      calls.push(`prepare:${track.id}`);
      return preparedTrack;
    },
    startBackgroundPlanning: async () => {
      calls.push("background-started");
      await backgroundPlanningStarted;
      backgroundPlanningFinished = true;
    },
  });

  const result = await service.startSession({
    uid: "42",
    sessionId: 7,
    recentPlayableTracks: [],
    profileAnchorTracks: [],
    likedTracks: [openingTrack],
    fallbackTracks: [],
    avoidTrackIds: new Set(),
  });

  assert.equal(result.opening?.track.id, "liked-1");
  assert.equal(result.backgroundStarted, true);
  assert.equal(backgroundPlanningFinished, false);
  assert.deepEqual(calls, ["choose-opening", "prepare:liked-1", "background-started"]);

  releaseBackgroundPlanning?.();
});

test("service marks an unprepared opening candidate so the next attempt can advance", async () => {
  const attempts: string[] = [];
  const failedTrack: Track = { id: "bad-url", name: "Bad URL", artist: "A" };
  const nextTrack: Track = { id: "good-url", name: "Good URL", artist: "B" };
  const avoidTrackIds = new Set<string>();
  const service = new RadioAgentService({
    chooseOpeningTrack: ({ avoidTrackIds }) => {
      const track = avoidTrackIds.has(failedTrack.id) ? nextTrack : failedTrack;
      attempts.push(track.id);
      return {
        track,
        reason: { type: "radio_agent_opening_recent", sourceRank: 1 },
      } satisfies OpeningTrackPick;
    },
    prepareTrack: async (track) => (track.id === failedTrack.id ? null : prepared(track)),
  });

  const first = await service.startSession({
    uid: "42",
    sessionId: 7,
    recentPlayableTracks: [failedTrack, nextTrack],
    profileAnchorTracks: [],
    likedTracks: [],
    fallbackTracks: [],
    avoidTrackIds,
  });
  const second = await service.startSession({
    uid: "42",
    sessionId: 7,
    recentPlayableTracks: [failedTrack, nextTrack],
    profileAnchorTracks: [],
    likedTracks: [],
    fallbackTracks: [],
    avoidTrackIds,
  });

  assert.equal(first.opening, undefined);
  assert.equal(first.fallbackReason, "opening_track_prepare_failed");
  assert.equal(second.opening?.track.id, "good-url");
  assert.deepEqual(attempts, ["bad-url", "good-url"]);
});

test("service turns explicit listener direction into a program window and host acknowledgement", async () => {
  const calls: string[] = [];
  const jazzTrack: Track = { id: "jazz-1", name: "Blue in Green", artist: "Miles Davis" };
  const programWindow = radioWindow({
    stationBrief: "Quiet jazz for reading.",
    mainDirection: "quiet jazz for reading",
    candidateTasks: [{ query: "Miles Davis Blue in Green", reason: "Quiet jazz reading anchor.", style: "jazz", negativeConstraints: [] }],
  });
  const service = new RadioAgentService({
    chooseOpeningTrack: () => null,
    prepareTrack: async () => null,
    handleRadioAgentEvent: async (event) => {
      calls.push(`agent:${event.type}:${event.text}`);
      return {
        controlsPlayback: false,
        event: { uid: "42", sessionId: 7, type: "user_text", priority: "hot", payload: {}, createdAt: "2026-06-11T00:00:00.000Z" },
        hostDecision: {
          shouldSpeak: true,
          event: "request_ack",
          reason: "listener changed direction",
          text: "好，接下来收进安静一点的 jazz。",
        },
        programWindow,
      } satisfies RadioAgentHandleResult;
    },
    prepareProgramWindow: async (window) => {
      calls.push(`executor:${window.mainDirection}`);
      return prepared(jazzTrack, { type: "radio_agent_program", text: "Quiet jazz reading anchor." });
    },
    clearReadyQueue: () => {
      calls.push("clear");
    },
    hostTextForDelivery: ({ eventType, decision }) => {
      calls.push(`host:${eventType}`);
      return decision?.text || "";
    },
  });

  const result = await service.handleUserText({
    uid: "42",
    sessionId: 7,
    text: "play quiet jazz for reading",
    currentTrack: null,
    readyQueue: [],
    shouldClearQueue: true,
  });

  assert.equal(result.preparedTrack?.track.id, "jazz-1");
  assert.equal(result.programWindow?.mainDirection, "quiet jazz for reading");
  assert.equal(result.hostText, "好，接下来收进安静一点的 jazz。");
  assert.equal(result.shouldClearQueue, true);
  assert.deepEqual(calls, [
    "agent:user_text:play quiet jazz for reading",
    "clear",
    "executor:quiet jazz for reading",
    "host:user_text",
  ]);
});

test("service can execute an explicit direction through the queue adapter", async () => {
  const calls: string[] = [];
  const programWindow = radioWindow({
    id: "window-jazz",
    stationBrief: "Quiet jazz for reading.",
    mainDirection: "quiet jazz for reading",
  });
  const service = new RadioAgentService({
    chooseOpeningTrack: () => null,
    prepareTrack: async () => null,
    handleRadioAgentEvent: async (event) => {
      calls.push(`agent:${event.type}`);
      return {
        controlsPlayback: false,
        event: { uid: "42", sessionId: 7, type: "user_text", priority: "hot", payload: {}, createdAt: "2026-06-11T00:00:00.000Z" },
        hostDecision: {
          shouldSpeak: true,
          event: "request_ack",
          reason: "listener changed direction",
          text: "好，接下来收进安静一点的 jazz。",
        },
        programWindow,
      } satisfies RadioAgentHandleResult;
    },
    prepareProgramWindow: async () => {
      throw new Error("queue adapter should own program execution when available");
    },
    queueProgramWindow: async (window) => {
      calls.push(`queue:${window.id}`);
      return true;
    },
    clearReadyQueue: () => {
      calls.push("clear");
    },
    hostTextForDelivery: ({ eventType, decision }) => {
      calls.push(`host:${eventType}`);
      return decision?.text || "";
    },
  });

  const result = await service.handleUserText({
    uid: "42",
    sessionId: 7,
    text: "play quiet jazz for reading",
    currentTrack: null,
    readyQueue: [],
    shouldClearQueue: true,
  });

  assert.equal(result.programWindow?.id, "window-jazz");
  assert.equal(result.preparedTrack, undefined);
  assert.equal(result.programQueued, true);
  assert.equal(result.hostText, "好，接下来收进安静一点的 jazz。");
  assert.deepEqual(calls, ["agent:user_text", "clear", "queue:window-jazz", "host:user_text"]);
});

test("service continues from the active contract when a track ends and queue is empty", async () => {
  const calls: string[] = [];
  const programWindow = radioWindow({
    id: "window-continuation",
    stationBrief: "Keep quiet jazz moving.",
    mainDirection: "quiet jazz for reading",
    traceBasis: { profile: "", now: "", contract: "quiet jazz for reading", eventType: "queue_low" },
  });
  const service = new RadioAgentService({
    chooseOpeningTrack: () => null,
    prepareTrack: async () => null,
    handleRadioAgentEvent: async (event) => {
      calls.push(`agent:${event.type}`);
      return {
        controlsPlayback: false,
        event: { uid: "42", sessionId: 7, type: "queue_low", priority: "warm", payload: {}, createdAt: "2026-06-11T00:00:00.000Z" },
        hostDecision: {
          shouldSpeak: false,
          event: "silent",
          reason: "ordinary continuation",
        },
        programWindow,
      } satisfies RadioAgentHandleResult;
    },
    queueProgramWindow: async (window) => {
      calls.push(`queue:${window.id}`);
      return true;
    },
    hostTextForDelivery: ({ eventType }) => {
      calls.push(`host:${eventType}`);
      return "";
    },
  });

  const result = await service.handleTrackEnded({
    uid: "42",
    sessionId: 7,
    previousEvent: "played",
    currentTrack: { id: "current", name: "Blue in Green", artist: "Miles Davis" },
    readyQueue: [],
  });

  assert.equal(result.action, "queued_program");
  assert.equal(result.programWindow?.id, "window-continuation");
  assert.equal(result.programQueued, true);
  assert.equal(result.fallbackReason, undefined);
  assert.deepEqual(calls, ["agent:queue_low", "queue:window-continuation", "host:queue_low"]);
});

test("service returns an explicit fallback when track end continuation cannot queue a program", async () => {
  const calls: string[] = [];
  const service = new RadioAgentService({
    chooseOpeningTrack: () => null,
    prepareTrack: async () => null,
    handleRadioAgentEvent: async (event) => {
      calls.push(`agent:${event.type}`);
      return {
        controlsPlayback: false,
        event: { uid: "42", sessionId: 7, type: "queue_low", priority: "warm", payload: {}, createdAt: "2026-06-11T00:00:00.000Z" },
        hostDecision: {
          shouldSpeak: true,
          event: "recovery",
          reason: "no playable continuation",
          text: "我先找一首稳的接上。",
        },
      } satisfies RadioAgentHandleResult;
    },
    hostTextForDelivery: ({ eventType, decision }) => {
      calls.push(`host:${eventType}`);
      return decision?.text || "";
    },
  });

  const result = await service.handleTrackEnded({
    uid: "42",
    sessionId: 7,
    previousEvent: "played",
    currentTrack: { id: "current", name: "Blue in Green", artist: "Miles Davis" },
    readyQueue: [],
  });

  assert.equal(result.action, "legacy_fallback");
  assert.equal(result.programQueued, false);
  assert.equal(result.fallbackReason, "program_window_missing");
  assert.equal(result.hostText, "我先找一首稳的接上。");
  assert.deepEqual(calls, ["agent:queue_low", "host:queue_low"]);
});

function prepared(
  track: Track,
  selectionReason: SelectionReason = { type: "radio_agent_opening_liked", text: "Started from a liked track." },
): RadioAgentPreparedTrack {
  return {
    track,
    url: `/audio/${track.id}`,
    segueText: "",
    selectionReason,
    decisionTrace: {
      id: "trace-1",
      trackId: track.id,
      source: "radio_agent",
      reason: selectionReason.text,
      createdAt: "2026-06-11T00:00:00.000Z",
    },
  };
}

function radioWindow(overrides: Partial<RadioAgentProgramWindow>): RadioAgentProgramWindow {
  return {
    id: "window-1",
    uid: "42",
    sessionId: 7,
    stationBrief: "Station brief.",
    mainDirection: "quiet jazz",
    allowedAdjacent: [],
    bridgeBudget: 0,
    disallowed: [],
    returnRequirement: "Stay on the requested direction.",
    candidateTasks: [],
    hostIntent: { shouldSpeak: true, event: "request_ack", reason: "listener direction", text: "好。" },
    traceBasis: { profile: "", now: "", contract: "", eventType: "user_text" },
    source: "model",
    createdAt: "2026-06-11T00:00:00.000Z",
    ...overrides,
  };
}
