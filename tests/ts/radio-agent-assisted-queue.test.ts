import assert from "node:assert/strict";
import test from "node:test";

import { tryQueueRadioAgentAssistedTrack } from "../../src/radio-agent/assistedQueue.js";
import type { RadioAgentProgramWindow } from "../../src/radio-agent/types.js";
import type { Track } from "../../src/types.js";

const track: Track = { id: "s1", name: "Good Days", artist: "SZA" };

const window: RadioAgentProgramWindow = {
  id: "window-1",
  uid: "42",
  sessionId: 9,
  stationBrief: "Keep late-night R&B coherent.",
  mainDirection: "late-night R&B",
  allowedAdjacent: ["alt-R&B"],
  bridgeBudget: 1,
  disallowed: ["classical chamber music"],
  returnRequirement: "Return to vocal R&B.",
  candidateTasks: [
    { query: "SZA Good Days", reason: "Known taste anchor.", style: "R&B", negativeConstraints: [] },
  ],
  hostIntent: { shouldSpeak: true, event: "return_to_contract", reason: "set lane", text: "Keeping this close." },
  traceBasis: { profile: "SZA", now: "late_night", contract: "late-night R&B", eventType: "queue_low" },
  source: "model",
  createdAt: "2026-06-03T01:02:03.000Z",
};

function preparedTrack() {
  return {
    track,
    url: "/audio/s1",
    selectionReason: { type: "radio_agent_program", text: "Known taste anchor.", traceId: "trace-1" },
    segueText: "Keeping this close.",
    decisionTrace: {
      id: "trace-1",
      uid: "42",
      sessionId: 9,
      episodeId: "window-1",
      intentType: "autoplay",
      profileQuality: { level: "strong", score: 0.8, reasons: ["profile"] },
      environment: { scene: "late night", localTimeBlock: "late_night", summary: "late night" },
      selectedTrack: track,
      reason: "Known taste anchor.",
      rejectedCandidates: [],
      verificationAttempts: ["SZA Good Days"],
      fallbackLevel: "episode_primary",
      latencyMs: { radioAgent: 0 },
      hostText: "Keeping this close.",
      createdAt: "2026-06-03T01:02:03.000Z",
    },
  };
}

function assistedDeps(overrides: Record<string, unknown> = {}) {
  const calls: string[] = [];
  const fallbackReasons: string[] = [];
  const deps = {
    mode: "assisted",
    uid: "42",
    sessionId: 9,
    currentTrack: null,
    readyQueue: [],
    radioAgent: {
      handle: async () => {
        calls.push("agent");
        return {
          controlsPlayback: false,
          event: { uid: "42", sessionId: 9, type: "queue_low", priority: "warm", payload: {}, createdAt: "" },
          programWindow: window,
        };
      },
    },
    executor: {
      prepareFirstPlayable: async () => {
        calls.push("executor");
        return preparedTrack();
      },
    },
    traceStore: {
      save: () => {
        calls.push("trace");
      },
    },
    queue: {
      addReady: (_track: Track, _url: string, _reason: unknown, options: { segueText?: string; ttsHash?: string }) => {
        calls.push(`queue:${options.ttsHash || ""}`);
      },
    },
    synthesize: async () => {
      calls.push("tts");
      return "tts-hash";
    },
    logFallback: (reason: string) => {
      fallbackReasons.push(reason);
    },
    ...overrides,
  };

  return { deps, calls, fallbackReasons };
}

test("assisted queue does not run in shadow mode", async () => {
  const { deps, calls, fallbackReasons } = assistedDeps({ mode: "shadow" });

  const queued = await tryQueueRadioAgentAssistedTrack(deps as any);

  assert.equal(queued, false);
  assert.deepEqual(calls, []);
  assert.deepEqual(fallbackReasons, []);
});

test("assisted queue saves trace before queueing and survives TTS failure", async () => {
  const { deps, calls, fallbackReasons } = assistedDeps({
    synthesize: async () => {
      calls.push("tts");
      throw new Error("tts down");
    },
  });

  const queued = await tryQueueRadioAgentAssistedTrack(deps as any);

  assert.equal(queued, true);
  assert.deepEqual(calls, ["agent", "executor", "trace", "tts", "queue:"]);
  assert.deepEqual(fallbackReasons, []);
});

test("assisted queue logs and falls back when no program window is available", async () => {
  const { deps, fallbackReasons } = assistedDeps({
    radioAgent: {
      handle: async () => ({ controlsPlayback: false, event: { uid: "42", type: "queue_low", priority: "warm", payload: {}, createdAt: "" } }),
    },
  });

  const queued = await tryQueueRadioAgentAssistedTrack(deps as any);

  assert.equal(queued, false);
  assert.deepEqual(fallbackReasons, ["program_window_missing"]);
});

test("assisted queue logs and falls back when no playable track verifies", async () => {
  const reported: Record<string, unknown>[] = [];
  const { deps, fallbackReasons } = assistedDeps({
    radioAgent: {
      handle: async (input: Record<string, unknown>) => {
        reported.push(input);
        return {
          controlsPlayback: false,
          event: { uid: "42", sessionId: 9, type: "queue_low", priority: "warm", payload: {}, createdAt: "" },
          programWindow: window,
        };
      },
    },
    executor: { prepareFirstPlayable: async () => null },
  });

  const queued = await tryQueueRadioAgentAssistedTrack(deps as any);

  assert.equal(queued, false);
  assert.deepEqual(fallbackReasons, ["program_executor_no_track"]);
  assert.equal(reported[1]?.type, "program_repair_needed");
  assert.equal(reported[1]?.reason, "program_executor_no_track");
  assert.equal((reported[1]?.programWindow as RadioAgentProgramWindow | undefined)?.id, "window-1");
  assert.deepEqual(reported[1]?.attemptedQueries, ["SZA Good Days"]);
});

test("assisted queue logs and falls back before queueing when trace save fails", async () => {
  const { deps, calls, fallbackReasons } = assistedDeps({
    traceStore: {
      save: () => {
        calls.push("trace");
        throw new Error("db down");
      },
    },
  });

  const queued = await tryQueueRadioAgentAssistedTrack(deps as any);

  assert.equal(queued, false);
  assert.deepEqual(calls, ["agent", "executor", "trace"]);
  assert.deepEqual(fallbackReasons, ["trace_save_failed"]);
});

test("assisted queue logs and falls back when runtime throws", async () => {
  const { deps, fallbackReasons } = assistedDeps({
    radioAgent: { handle: async () => { throw new Error("runtime down"); } },
  });

  const queued = await tryQueueRadioAgentAssistedTrack(deps as any);

  assert.equal(queued, false);
  assert.deepEqual(fallbackReasons, ["assisted_queue_failed"]);
});

test("assisted queue logs and falls back when executor throws", async () => {
  const { deps, fallbackReasons } = assistedDeps({
    executor: { prepareFirstPlayable: async () => { throw new Error("executor down"); } },
  });

  const queued = await tryQueueRadioAgentAssistedTrack(deps as any);

  assert.equal(queued, false);
  assert.deepEqual(fallbackReasons, ["assisted_queue_failed"]);
});
