import assert from "node:assert/strict";
import test from "node:test";

import { queueRadioAgentProgramWindow, tryQueueRadioAgentAssistedTrack } from "../../src/radio-agent/assistedQueue.js";
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

async function flushAsyncWork(rounds = 4): Promise<void> {
  for (let index = 0; index < rounds; index += 1) {
    await Promise.resolve();
  }
}

test("assisted queue does not run in shadow mode", async () => {
  const { deps, calls, fallbackReasons } = assistedDeps({ mode: "shadow" });

  const queued = await tryQueueRadioAgentAssistedTrack(deps as any);
  await flushAsyncWork();

  assert.equal(queued, false);
  assert.deepEqual(calls, []);
  assert.deepEqual(fallbackReasons, []);
});

test("assisted queue can execute an already planned user text program window", async () => {
  const reported: Record<string, unknown>[] = [];
  const { deps, calls, fallbackReasons } = assistedDeps({
    radioAgent: {
      handle: async (input: Record<string, unknown>) => {
        reported.push(input);
        return {
          controlsPlayback: false,
          event: { uid: "42", sessionId: 9, type: input.type as "program_track_queued", priority: "warm", payload: {}, createdAt: "" },
        };
      },
    },
  });

  const queued = await queueRadioAgentProgramWindow(deps as any, window);
  await flushAsyncWork();

  assert.equal(queued, true);
  assert.deepEqual(calls, ["executor", "trace", "tts", "queue:tts-hash"]);
  assert.deepEqual(fallbackReasons, []);
  assert.equal(reported[0]?.type, "program_track_queued");
  assert.equal(reported[0]?.programWindowId, "window-1");
  assert.deepEqual(reported[0]?.track, track);
});

test("assisted queue can execute a playback recovery program window", async () => {
  const reported: Record<string, unknown>[] = [];
  const recoveryWindow = {
    ...window,
    id: "recovery-window-1",
    traceBasis: { ...window.traceBasis, eventType: "playback_recovery_needed" as const },
    hostIntent: { shouldSpeak: true, event: "recovery" as const, reason: "queue exhausted", text: "I found a safe next track." },
  };
  const { deps, calls, fallbackReasons } = assistedDeps({
    radioAgent: {
      handle: async (input: Record<string, unknown>) => {
        reported.push(input);
        return {
          controlsPlayback: false,
          event: { uid: "42", sessionId: 9, type: input.type as "program_track_queued", priority: "warm", payload: {}, createdAt: "" },
        };
      },
    },
  });

  const queued = await queueRadioAgentProgramWindow(deps as any, recoveryWindow);
  await flushAsyncWork();

  assert.equal(queued, true);
  assert.deepEqual(calls, ["executor", "trace", "tts", "queue:tts-hash"]);
  assert.deepEqual(fallbackReasons, []);
  assert.equal(reported[0]?.type, "program_track_queued");
  assert.equal(reported[0]?.programWindowId, "recovery-window-1");
});

test("assisted queue saves trace before queueing and survives TTS failure", async () => {
  const reported: Record<string, unknown>[] = [];
  const { deps, calls, fallbackReasons } = assistedDeps({
    radioAgent: {
      handle: async (input: Record<string, unknown>) => {
        reported.push(input);
        return {
          controlsPlayback: false,
          event: { uid: "42", sessionId: 9, type: input.type as "queue_low", priority: "warm", payload: {}, createdAt: "" },
          programWindow: window,
        };
      },
    },
    synthesize: async () => {
      calls.push("tts");
      throw new Error("tts down");
    },
  });

  const queued = await tryQueueRadioAgentAssistedTrack(deps as any);
  await flushAsyncWork();

  assert.equal(queued, true);
  assert.deepEqual(calls, ["executor", "trace", "tts", "queue:"]);
  assert.deepEqual(fallbackReasons, []);
  assert.equal(reported[1]?.type, "program_track_queued");
  assert.deepEqual(reported[1]?.track, track);
  assert.equal(reported[1]?.programWindowId, "window-1");
  assert.equal(reported[1]?.traceId, "trace-1");
  assert.equal(reported[1]?.selectionReason, "Known taste anchor.");
  assert.equal(reported[1]?.hostText, "Keeping this close.");
});

test("assisted queue still succeeds when execution event reporting fails", async () => {
  const reported: Record<string, unknown>[] = [];
  const { deps, fallbackReasons } = assistedDeps({
    radioAgent: {
      handle: async (input: Record<string, unknown>) => {
        reported.push(input);
        if (input.type === "program_track_queued") throw new Error("event store down");
        return {
          controlsPlayback: false,
          event: { uid: "42", sessionId: 9, type: input.type as "queue_low", priority: "warm", payload: {}, createdAt: "" },
          programWindow: window,
        };
      },
    },
  });

  const queued = await tryQueueRadioAgentAssistedTrack(deps as any);

  assert.equal(queued, true);
  assert.equal(reported[1]?.type, "program_track_queued");
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

test("assisted queue reports actual verifier attempts when no playable track verifies", async () => {
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
    executor: {
      prepareFirstPlayable: async () => null,
      latestAttemptedQueries: () => ["SZA Good Days live", "SZA Good Days acoustic"],
    },
  });

  const queued = await tryQueueRadioAgentAssistedTrack(deps as any);

  assert.equal(queued, false);
  assert.deepEqual(fallbackReasons, ["program_executor_no_track"]);
  assert.equal(reported[1]?.type, "program_repair_needed");
  assert.deepEqual(reported[1]?.attemptedQueries, ["SZA Good Days live", "SZA Good Days acoustic", "SZA Good Days"]);
});

test("assisted queue retries once with agent repair before falling back", async () => {
  const reported: Record<string, unknown>[] = [];
  const { deps, calls, fallbackReasons } = assistedDeps({
    radioAgent: {
      handle: async (input: Record<string, unknown>) => {
        reported.push(input);
        return {
          controlsPlayback: false,
          event: { uid: "42", sessionId: 9, type: input.type as "queue_low", priority: "warm", payload: {}, createdAt: "" },
          programWindow: {
            ...window,
            id: input.type === "program_repair_needed" ? "window-repaired" : "window-1",
            candidateTasks:
              input.type === "program_repair_needed"
                ? [{ query: "Daniel Caesar Get You", reason: "Repaired concrete R&B candidate.", style: "R&B", negativeConstraints: [] }]
                : window.candidateTasks,
          },
        };
      },
    },
    executor: {
      prepareFirstPlayable: async (programWindow: RadioAgentProgramWindow) => {
        calls.push(`executor:${programWindow.id}`);
        if (programWindow.id === "window-1") return null;
        return {
          ...preparedTrack(),
          track: { id: "s2", name: "Get You", artist: "Daniel Caesar" },
          url: "/audio/s2",
          selectionReason: { type: "radio_agent_program", text: "Repaired concrete R&B candidate.", traceId: "trace-2" },
        };
      },
      latestAttemptedQueries: () => ["SZA Good Days"],
    },
  });

  const queued = await tryQueueRadioAgentAssistedTrack(deps as any);

  assert.equal(queued, true);
  assert.equal(reported[0]?.type, "queue_low");
  assert.equal(reported[1]?.type, "program_repair_needed");
  assert.deepEqual(reported[1]?.attemptedQueries, ["SZA Good Days"]);
  assert.deepEqual(calls, ["executor:window-1", "executor:window-repaired", "trace", "tts", "queue:tts-hash"]);
  assert.deepEqual(fallbackReasons, []);
});

test("assisted queue asks for repair when the prepared track is already current or ready", async () => {
  const reported: Record<string, unknown>[] = [];
  const { deps, calls, fallbackReasons } = assistedDeps({
    currentTrack: track,
    readyQueue: [{ id: "s2", name: "Pink + White", artist: "Frank Ocean" }],
    radioAgent: {
      handle: async (input: Record<string, unknown>) => {
        reported.push(input);
        return {
          controlsPlayback: false,
          event: { uid: "42", sessionId: 9, type: input.type as "queue_low", priority: "warm", payload: {}, createdAt: "" },
          programWindow: {
            ...window,
            id: input.type === "program_repair_needed" ? "window-repaired" : "window-1",
            candidateTasks:
              input.type === "program_repair_needed"
                ? [{ query: "Daniel Caesar Get You", reason: "Repaired non-duplicate R&B candidate.", style: "R&B", negativeConstraints: [] }]
                : window.candidateTasks,
          },
        };
      },
    },
    executor: {
      prepareFirstPlayable: async (programWindow: RadioAgentProgramWindow) => {
        calls.push(`executor:${programWindow.id}`);
        if (programWindow.id === "window-1") return preparedTrack();
        const repairedTrack = { id: "s3", name: "Get You", artist: "Daniel Caesar" };
        return {
          ...preparedTrack(),
          track: repairedTrack,
          url: "/audio/s3",
          selectionReason: { type: "radio_agent_program", text: "Repaired non-duplicate R&B candidate.", traceId: "trace-3" },
          decisionTrace: {
            ...preparedTrack().decisionTrace,
            id: "trace-3",
            selectedTrack: repairedTrack,
            verificationAttempts: ["Daniel Caesar Get You"],
          },
        };
      },
      latestAttemptedQueries: () => ["SZA Good Days"],
    },
  });

  const queued = await tryQueueRadioAgentAssistedTrack(deps as any);

  assert.equal(queued, true);
  assert.equal(reported[1]?.type, "program_repair_needed");
  assert.equal(reported[1]?.reason, "program_executor_duplicate_track");
  assert.deepEqual(reported[1]?.attemptedQueries, ["SZA Good Days"]);
  assert.deepEqual(calls, ["executor:window-1", "executor:window-repaired", "trace", "tts", "queue:tts-hash"]);
  assert.deepEqual(fallbackReasons, []);
});

test("assisted queue asks for repair when prepared track is a remix of recent playback", async () => {
  const reported: Record<string, unknown>[] = [];
  const remixTrack = { id: "pink-remix", name: "frank ocean - pinkpuss (pink + white remix)", artist: "LegoG" };
  const { deps, calls, fallbackReasons } = assistedDeps({
    recentTracks: [{ id: "pink-original", name: "Pink + White", artist: "Frank Ocean" }],
    radioAgent: {
      handle: async (input: Record<string, unknown>) => {
        reported.push(input);
        return {
          controlsPlayback: false,
          event: { uid: "42", sessionId: 9, type: input.type as "queue_low", priority: "warm", payload: {}, createdAt: "" },
          programWindow: input.type === "program_repair_needed"
            ? {
                ...window,
                id: "window-repaired",
                candidateTasks: [
                  { query: "Miguel Adorn", reason: "Repaired non-duplicate R&B candidate.", style: "R&B", negativeConstraints: [] },
                ],
              }
            : window,
        };
      },
    },
    executor: {
      prepareFirstPlayable: async (programWindow: RadioAgentProgramWindow) => {
        calls.push(`executor:${programWindow.id}`);
        if (programWindow.id === "window-1") {
          return {
            ...preparedTrack(),
            track: remixTrack,
            url: "/audio/pink-remix",
            selectionReason: { type: "radio_agent_program", text: "R&B remix candidate.", traceId: "trace-remix" },
            decisionTrace: {
              ...preparedTrack().decisionTrace,
              id: "trace-remix",
              selectedTrack: remixTrack,
              verificationAttempts: ["Frank Ocean Pink + White remix"],
            },
          };
        }
        const repairedTrack = { id: "miguel", name: "Adorn", artist: "Miguel" };
        return {
          ...preparedTrack(),
          track: repairedTrack,
          url: "/audio/miguel",
          selectionReason: { type: "radio_agent_program", text: "Repaired non-duplicate R&B candidate.", traceId: "trace-miguel" },
          decisionTrace: {
            ...preparedTrack().decisionTrace,
            id: "trace-miguel",
            selectedTrack: repairedTrack,
            verificationAttempts: ["Miguel Adorn"],
          },
        };
      },
      latestAttemptedQueries: () => ["Frank Ocean Pink + White remix"],
    },
  });

  const queued = await tryQueueRadioAgentAssistedTrack(deps as any);

  assert.equal(queued, true);
  assert.equal(reported[1]?.type, "program_repair_needed");
  assert.equal(reported[1]?.reason, "program_executor_duplicate_track");
  assert.deepEqual(reported[1]?.attemptedQueries, ["Frank Ocean Pink + White remix", "SZA Good Days"]);
  assert.deepEqual(calls, ["executor:window-1", "executor:window-repaired", "trace", "tts", "queue:tts-hash"]);
  assert.deepEqual(fallbackReasons, []);
});

test("assisted queue rechecks live playback state before queueing a prepared track", async () => {
  const reported: Record<string, unknown>[] = [];
  const liveReadyQueue: Track[] = [];
  const { deps, calls, fallbackReasons } = assistedDeps({
    getPlaybackSnapshot: () => ({
      currentTrack: null,
      readyQueue: liveReadyQueue,
    }),
    radioAgent: {
      handle: async (input: Record<string, unknown>) => {
        reported.push(input);
        return {
          controlsPlayback: false,
          event: { uid: "42", sessionId: 9, type: input.type as "queue_low", priority: "warm", payload: {}, createdAt: "" },
          programWindow: input.type === "queue_low" ? window : undefined,
        };
      },
    },
    executor: {
      prepareFirstPlayable: async () => {
        calls.push("executor");
        liveReadyQueue.push(track);
        return preparedTrack();
      },
      latestAttemptedQueries: () => ["SZA Good Days"],
    },
  });

  const queued = await tryQueueRadioAgentAssistedTrack(deps as any);

  assert.equal(queued, false);
  assert.equal(reported[1]?.type, "program_repair_needed");
  assert.equal(reported[1]?.reason, "program_executor_duplicate_track");
  assert.deepEqual(reported[1]?.readyQueue, [track]);
  assert.deepEqual(calls, ["executor"]);
  assert.deepEqual(fallbackReasons, ["program_executor_duplicate_track"]);
});

test("assisted queue logs and falls back before queueing when trace save fails", async () => {
  const reported: Record<string, unknown>[] = [];
  const { deps, calls, fallbackReasons } = assistedDeps({
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
    traceStore: {
      save: () => {
        calls.push("trace");
        throw new Error("db down");
      },
    },
  });

  const queued = await tryQueueRadioAgentAssistedTrack(deps as any);

  assert.equal(queued, false);
  assert.deepEqual(calls, ["executor", "trace"]);
  assert.deepEqual(fallbackReasons, ["trace_save_failed"]);
  assert.equal(reported[0]?.type, "queue_low");
  assert.equal(reported[1]?.type, "program_repair_needed");
  assert.equal(reported[1]?.reason, "trace_save_failed");
  assert.deepEqual(reported[1]?.attemptedQueries, ["SZA Good Days"]);
});

test("assisted queue logs and falls back when runtime throws", async () => {
  const { deps, fallbackReasons } = assistedDeps({
    radioAgent: { handle: async () => { throw new Error("runtime down"); } },
  });

  const queued = await tryQueueRadioAgentAssistedTrack(deps as any);

  assert.equal(queued, false);
  assert.deepEqual(fallbackReasons, ["assisted_queue_failed"]);
});

test("assisted queue reports repair when queueing the prepared track fails", async () => {
  const reported: Record<string, unknown>[] = [];
  const { deps, calls, fallbackReasons } = assistedDeps({
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
    queue: {
      addReady: () => {
        calls.push("queue-throw");
        throw new Error("queue down");
      },
    },
  });

  const queued = await tryQueueRadioAgentAssistedTrack(deps as any);

  assert.equal(queued, false);
  assert.deepEqual(fallbackReasons, ["assisted_queue_failed"]);
  assert.equal(reported[0]?.type, "queue_low");
  assert.equal(reported[1]?.type, "program_repair_needed");
  assert.equal(reported[1]?.reason, "assisted_queue_failed");
  assert.deepEqual(reported[1]?.attemptedQueries, ["SZA Good Days"]);
  assert.ok(calls.includes("queue-throw"));
});

test("assisted queue logs and falls back when executor throws", async () => {
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
    executor: { prepareFirstPlayable: async () => { throw new Error("executor down"); } },
  });

  const queued = await tryQueueRadioAgentAssistedTrack(deps as any);

  assert.equal(queued, false);
  assert.deepEqual(fallbackReasons, ["assisted_queue_failed"]);
  assert.equal(reported[0]?.type, "queue_low");
  assert.equal(reported[1]?.type, "program_repair_needed");
  assert.equal(reported[1]?.reason, "assisted_queue_failed");
  assert.deepEqual(reported[1]?.attemptedQueries, ["SZA Good Days"]);
});
