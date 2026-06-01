import assert from "node:assert/strict";
import test from "node:test";

import { PlaybackQueue } from "../../src/radio/playbackQueue.js";
import { RadioBrain } from "../../src/radio/radioBrain.js";
import type { DecisionTrace, ListeningIntentDecision, RadioEpisode } from "../../src/radio/radioBrainTypes.js";
import type { MemoryPack, SelectionReason, StationEnvironment, Track } from "../../src/types.js";

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (reason?: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  return { promise, resolve, reject };
}

async function flushBackground(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function track(id: string, name = id): Track {
  return { id, name, artist: "Artist" };
}

function env(): StationEnvironment {
  return {
    scene: "desk",
    localTimeBlock: "night",
    timezoneName: "Asia/Shanghai",
    locale: "zh-CN",
    summary: "late desk session",
  };
}

function memoryPack(): MemoryPack {
  return {
    userProfileDigest: "",
    sessionWorkingMemory: { reflectionMemory: { currentConstraints: ["old"] } },
    recentTurns: [],
    retrievedMemories: [],
    playbackContext: {},
    userSettings: {},
    hardConstraints: [],
  };
}

function reason(overrides: Partial<SelectionReason> = {}): SelectionReason {
  return {
    type: "ai_radio_episode",
    text: "calm instrumental queue",
    ...overrides,
  };
}

function episode(createdFrom: RadioEpisode["createdFrom"]): RadioEpisode {
  return {
    id: `episode-${createdFrom}`,
    brief: "brief",
    modeLabel: "mode",
    arc: "",
    durationTracks: 1,
    positiveConstraints: [],
    negativeConstraints: [],
    items: [],
    fallbackPolicy: "",
    hostNotes: [],
    createdFrom,
    createdAt: new Date().toISOString(),
  };
}

function intent(overrides: Partial<ListeningIntentDecision> = {}): ListeningIntentDecision {
  return {
    type: "music_direction_request",
    rawText: "more focus",
    query: "",
    positiveSeeds: ["focus"],
    negativeConstraints: [],
    shouldReplan: true,
    shouldClearQueue: true,
    shouldExplain: false,
    confidence: "high",
    ackText: "ack",
    ...overrides,
  };
}

function brain(overrides: Partial<ConstructorParameters<typeof RadioBrain>[0]> = {}): RadioBrain {
  return new RadioBrain({
    intentRouter: { classify: (text) => intent({ rawText: text }) },
    planner: { plan: async (args) => episode(args.createdFrom) },
    warmer: { warm: async () => 0 },
    responder: {
      acknowledge: (decision) => `ack:${decision.type}`,
      explainCurrentTrack: () => "because it fits",
    },
    traceStore: { latestForSession: () => null, latestForTrack: () => null },
    reflectionLoop: { record: (args) => args.existing },
    ...overrides,
  });
}

function args(queue = new PlaybackQueue()) {
  return {
    queue,
    uid: "u1",
    sessionId: 12,
    profile: null,
    settings: {},
    environment: env(),
    currentTrack: null,
    playedTracks: [],
    recentTurns: [],
    contextPack: memoryPack(),
  };
}

test("startup returns a bridge track before deep planning completes", async () => {
  const queue = new PlaybackQueue();
  const planning = deferred<RadioEpisode>();
  let plannerStarted = false;
  const radio = brain({
    bridgePicker: async () => ({ track: track("bridge", "Bridge Song"), url: "https://audio/bridge", reason: "profile anchor" }),
    planner: {
      plan: async (planArgs) => {
        plannerStarted = true;
        return planning.promise.then(() => episode(planArgs.createdFrom));
      },
    },
  });

  const result = await radio.startSession(args(queue));

  assert.deepEqual(result, { status: "bridge_ready", hostText: "" });
  assert.equal(queue.readyDepth(), 1);
  assert.equal(queue.readyItems()[0]?.track.id, "bridge");
  assert.equal(queue.readyItems()[0]?.selectionReason.type, "startup_bridge");
  assert.equal(queue.readyItems()[0]?.selectionReason.text, "profile anchor");
  assert.equal(plannerStarted, true);
  planning.resolve(episode("startup"));
});

test("startup propagates bridge picker failures instead of reporting bridge ready", async () => {
  const queue = new PlaybackQueue();
  const radio = brain({
    bridgePicker: async () => {
      throw new Error("bridge unavailable");
    },
  });

  await assert.rejects(radio.startSession(args(queue)), /bridge unavailable/);
  assert.equal(queue.readyDepth(), 0);
});

test("explanation request returns text and does not clear queue", async () => {
  const queue = new PlaybackQueue();
  queue.addReady(track("ready"), "url", reason({ text: "EDM queue" }));
  const trace: DecisionTrace = {
    id: "trace",
    uid: "u1",
    sessionId: 12,
    episodeId: "episode",
    intentType: "autoplay",
    profileQuality: { level: "low_confidence", score: 0, reasons: [] },
    environment: env(),
    selectedTrack: track("playing"),
    reason: "trace reason",
    rejectedCandidates: [],
    verificationAttempts: [],
    fallbackLevel: "episode_primary",
    latencyMs: {},
    hostText: "host",
    createdAt: new Date().toISOString(),
  };
  let loadedTrace = false;
  const radio = brain({
    intentRouter: { classify: (text) => intent({ type: "explanation_question", rawText: text, shouldExplain: true, shouldReplan: false, shouldClearQueue: false }) },
    traceStore: {
      latestForTrack: () => null,
      latestForSession: () => {
        loadedTrace = true;
        return trace;
      },
    },
    responder: {
      acknowledge: () => "unused",
      explainCurrentTrack: (_decision, loaded) => `explained:${loaded?.id}`,
    },
  });

  const result = await radio.handleUserText({ ...args(queue), text: "为什么这首" });

  assert.deepEqual(result, { status: "explained", hostText: "explained:trace" });
  assert.equal(loadedTrace, true);
  assert.equal(queue.readyDepth(), 1);
});

test("explanation request prefers the trace for the current track over prewarmed future tracks", async () => {
  const queue = new PlaybackQueue();
  const currentTrace: DecisionTrace = {
    id: "current-trace",
    uid: "u1",
    sessionId: 12,
    episodeId: "episode-current",
    intentType: "music_direction_request",
    profileQuality: { level: "usable", score: 0.5, reasons: [] },
    environment: env(),
    selectedTrack: track("playing"),
    reason: "current track reason",
    rejectedCandidates: [],
    verificationAttempts: [],
    fallbackLevel: "episode_primary",
    latencyMs: {},
    hostText: "current host",
    createdAt: new Date().toISOString(),
  };
  const futureTrace: DecisionTrace = {
    ...currentTrace,
    id: "future-trace",
    selectedTrack: track("future"),
    reason: "future track reason",
  };
  const radio = brain({
    intentRouter: { classify: (text) => intent({ type: "explanation_question", rawText: text, shouldExplain: true, shouldReplan: false, shouldClearQueue: false }) },
    traceStore: {
      latestForSession: () => futureTrace,
      latestForTrack: () => currentTrace,
    } as any,
    responder: {
      acknowledge: () => "unused",
      explainCurrentTrack: (_decision, loaded) => `explained:${loaded?.id}`,
    },
  });

  const result = await radio.handleUserText({ ...args(queue), currentTrack: track("playing"), text: "为什么这首" });

  assert.deepEqual(result, { status: "explained", hostText: "explained:current-trace" });
});

test("correction clears only ready items that conflict with negative constraints", async () => {
  const queue = new PlaybackQueue();
  queue.addReady(track("conflict-text"), "url", reason({ text: "too much EDM energy" }));
  queue.addReady(track("conflict-intent"), "url", reason({ understoodIntent: "avoid VOCAL hooks" }));
  queue.addReady(track("conflict-fallback"), "url", reason({ fallbackLevel: "profile_anchor" }));
  queue.addReady(track("safe"), "url", reason({ text: "calm piano" }));
  queue.addReady(track("playing-conflict"), "url", reason({ text: "EDM playing" }));
  queue.promoteNext();

  const radio = brain({
    intentRouter: {
      classify: (text) =>
        intent({
          type: "correction",
          rawText: text,
          negativeConstraints: ["edm", "vocal", "profile_anchor"],
          shouldReplan: false,
          shouldClearQueue: true,
        }),
    },
  });

  const result = await radio.handleUserText({ ...args(queue), currentTrack: track("playing-conflict"), text: "not this" });

  assert.equal(result.status, "acknowledged");
  assert.deepEqual(
    queue.items.map((item) => [item.track.id, item.status]),
    [
      ["conflict-text", "playing"],
      ["safe", "ready"],
    ],
  );
});

test("correction with no negative constraints clears stale ready queue but keeps playing item", async () => {
  const queue = new PlaybackQueue();
  queue.addReady(track("playing"), "url", reason({ text: "old playing direction" }));
  queue.addReady(track("ready-a"), "url", reason({ text: "old ready direction" }));
  queue.addReady(track("ready-b"), "url", reason({ text: "another old ready direction" }));
  queue.promoteNext();
  const radio = brain({
    intentRouter: {
      classify: (text) =>
        intent({
          type: "correction",
          rawText: text,
          negativeConstraints: [],
          shouldReplan: false,
          shouldClearQueue: true,
        }),
    },
  });

  await radio.handleUserText({ ...args(queue), text: "不是这个方向" });

  assert.deepEqual(
    queue.items.map((item) => [item.track.id, item.status]),
    [["playing", "playing"]],
  );
});

test("new music direction clears stale ready queue so fresh brain items must be planned", async () => {
  const queue = new PlaybackQueue();
  queue.addReady(track("playing"), "url", reason({ text: "current song" }));
  queue.addReady(track("stale-safe"), "url", reason({ text: "quiet piano from previous direction" }));
  queue.addReady(track("stale-other"), "url", reason({ text: "soft ambient from previous direction" }));
  queue.promoteNext();
  const radio = brain({
    intentRouter: {
      classify: (text) =>
        intent({
          type: "music_direction_request",
          rawText: text,
          negativeConstraints: ["edm", "dubstep"],
          shouldReplan: false,
          shouldClearQueue: true,
        }),
    },
  });

  await radio.handleUserText({ ...args(queue), text: "我要专注写代码，不要 edm" });

  assert.deepEqual(
    queue.items.map((item) => [item.track.id, item.status]),
    [["playing", "playing"]],
  );
});

test("conflict matching respects roman token boundaries", async () => {
  const queue = new PlaybackQueue();
  queue.addReady(track("safe-bedmate"), "url", reason({ text: "bedmate ambient track" }));
  queue.addReady(track("conflict-edm"), "url", reason({ text: "EDM pulse track" }));
  const radio = brain({
    intentRouter: {
      classify: (text) =>
        intent({
          type: "correction",
          rawText: text,
          negativeConstraints: ["edm"],
          shouldReplan: false,
          shouldClearQueue: true,
        }),
    },
  });

  await radio.handleUserText({ ...args(queue), text: "不要 edm" });

  assert.deepEqual(queue.readyItems().map((item) => item.track.id), ["safe-bedmate"]);
});

test("planner receives createdFrom correction for correction and startup for startup", async () => {
  const createdFrom: string[] = [];
  const radio = brain({
    bridgePicker: async () => null,
    intentRouter: {
      classify: (text) =>
        intent({
          type: "correction",
          rawText: text,
          negativeConstraints: ["edm"],
          shouldReplan: true,
          shouldClearQueue: true,
        }),
    },
    planner: {
      plan: async (planArgs) => {
        createdFrom.push(planArgs.createdFrom);
        return episode(planArgs.createdFrom);
      },
    },
  });

  await radio.startSession(args());
  await radio.handleUserText({ ...args(), text: "不是这个" });
  await flushBackground();

  assert.ok(createdFrom.includes("startup"));
  assert.ok(createdFrom.includes("correction"));
});

test("continuation planning preserves the active station contract", async () => {
  const queue = new PlaybackQueue();
  const activeContract = {
    id: "contract-1",
    mainDirection: "late-night R&B",
    rawUserText: "放点深夜听的rnb",
    allowedAdjacent: ["alt-R&B"],
    softBridge: ["ambient electronic"],
    disallowed: ["classical chamber music"],
    positiveSeeds: ["R&B"],
    negativeConstraints: [],
    driftBudget: 1,
    bridgeCount: 0,
    mustReturnToContract: false,
    hostStyle: "standard" as const,
    createdAt: "2026-06-02T00:00:00.000Z",
    updatedAt: "2026-06-02T00:00:00.000Z",
  };
  let receivedContract: unknown = null;
  const radio = brain({
    intentRouter: { classify: (text) => intent({ type: "continuation", rawText: text, shouldReplan: true, shouldClearQueue: false }) },
    contractManager: { update: () => activeContract } as any,
    planner: {
      plan: async (planArgs: any) => {
        receivedContract = planArgs.stationContract;
        return episode("autoplay");
      },
    },
  } as any);

  await radio.handleUserText({ ...args(queue), text: "继续保持这个感觉" });
  await flushBackground();

  assert.equal((receivedContract as any)?.mainDirection, "late-night R&B");
});

test("startup planning rehydrates station contract from session memory", async () => {
  const queue = new PlaybackQueue();
  const activeContract = {
    id: "contract-1",
    mainDirection: "late-night R&B",
    rawUserText: "放点深夜听的rnb",
    allowedAdjacent: ["alt-R&B"],
    softBridge: ["ambient electronic"],
    disallowed: ["classical chamber music"],
    positiveSeeds: ["R&B"],
    negativeConstraints: [],
    driftBudget: 1,
    bridgeCount: 0,
    mustReturnToContract: false,
    hostStyle: "standard" as const,
    createdAt: "2026-06-02T00:00:00.000Z",
    updatedAt: "2026-06-02T00:00:00.000Z",
  };
  const pack = memoryPack();
  pack.sessionWorkingMemory.stationContract = activeContract;
  let receivedContract: unknown = null;
  const radio = brain({
    bridgePicker: async () => null,
    planner: {
      plan: async (planArgs: any) => {
        receivedContract = planArgs.stationContract;
        return episode(planArgs.createdFrom);
      },
    },
  });

  await radio.startSession({ ...args(queue), contextPack: pack });
  await flushBackground();

  assert.equal((receivedContract as any)?.mainDirection, "late-night R&B");
});

test("startup planning uses the latest station contract after a delayed bridge", async () => {
  const queue = new PlaybackQueue();
  const bridge = deferred<null>();
  const updatedContract = {
    id: "contract-updated",
    mainDirection: "late-night R&B",
    rawUserText: "late night r&b",
    allowedAdjacent: ["alt-R&B"],
    softBridge: ["ambient electronic"],
    disallowed: ["classical chamber music"],
    positiveSeeds: ["R&B"],
    negativeConstraints: [],
    driftBudget: 1,
    bridgeCount: 0,
    mustReturnToContract: false,
    hostStyle: "standard" as const,
    createdAt: "2026-06-02T00:00:00.000Z",
    updatedAt: "2026-06-02T00:00:00.000Z",
  };
  let startupContract: unknown = null;
  let userRequestContract: unknown = null;
  const radio = brain({
    bridgePicker: () => bridge.promise,
    intentRouter: {
      classify: (text) =>
        intent({
          type: "music_direction_request",
          rawText: text,
          positiveSeeds: ["R&B"],
          shouldReplan: true,
          shouldClearQueue: true,
        }),
    },
    contractManager: { update: () => updatedContract } as any,
    planner: {
      plan: async (planArgs: any) => {
        if (planArgs.createdFrom === "startup") startupContract = planArgs.stationContract;
        if (planArgs.createdFrom === "user_request") userRequestContract = planArgs.stationContract;
        return episode(planArgs.createdFrom);
      },
    },
  } as any);

  const starting = radio.startSession(args(queue));
  await flushBackground();
  await radio.handleUserText({ ...args(queue), text: "late night r&b" });
  await flushBackground();

  assert.equal((userRequestContract as any)?.id, "contract-updated");

  bridge.resolve(null);
  await starting;
  await flushBackground();

  assert.equal((startupContract as any)?.id, "contract-updated");
});

test("stale startup plan does not warm after a newer correction plan starts", async () => {
  const queue = new PlaybackQueue();
  const startupPlanning = deferred<RadioEpisode>();
  const correctionPlanning = deferred<RadioEpisode>();
  const warmCreatedFrom: string[] = [];
  const radio = brain({
    bridgePicker: async () => null,
    intentRouter: {
      classify: (text) =>
        intent({
          type: "correction",
          rawText: text,
          negativeConstraints: ["edm"],
          shouldReplan: true,
          shouldClearQueue: true,
        }),
    },
    planner: {
      plan: async (planArgs) => {
        if (planArgs.createdFrom === "startup") return startupPlanning.promise;
        if (planArgs.createdFrom === "correction") return correctionPlanning.promise;
        return episode(planArgs.createdFrom);
      },
    },
    warmer: {
      warm: async (warmArgs) => {
        warmCreatedFrom.push(warmArgs.episode.createdFrom);
        return 0;
      },
    },
  });

  await radio.startSession(args(queue));
  await radio.handleUserText({ ...args(queue), text: "不要 edm" });

  startupPlanning.resolve(episode("startup"));
  await flushBackground();
  assert.deepEqual(warmCreatedFrom, []);

  correctionPlanning.resolve(episode("correction"));
  await flushBackground();
  assert.deepEqual(warmCreatedFrom, ["correction"]);
});

test("a correction in one session does not invalidate another session background plan", async () => {
  const queueA = new PlaybackQueue();
  const queueB = new PlaybackQueue();
  const sessionBPlanning = deferred<RadioEpisode>();
  const warmSessionIds: Array<number | null> = [];
  const radio = brain({
    bridgePicker: async () => null,
    intentRouter: {
      classify: (text) =>
        intent({
          type: "correction",
          rawText: text,
          negativeConstraints: ["edm"],
          shouldReplan: true,
          shouldClearQueue: true,
        }),
    },
    planner: {
      plan: async (planArgs) => {
        if (planArgs.sessionId === 202 && planArgs.createdFrom === "startup") return sessionBPlanning.promise;
        return episode(planArgs.createdFrom);
      },
    },
    warmer: {
      warm: async (warmArgs) => {
        warmSessionIds.push(warmArgs.sessionId);
        return 0;
      },
    },
  });

  await radio.startSession({ ...args(queueB), uid: "user-b", sessionId: 202 });
  await radio.handleUserText({ ...args(queueA), uid: "user-a", sessionId: 101, text: "不要 edm" });

  sessionBPlanning.resolve(episode("startup"));
  await flushBackground();

  assert.ok(warmSessionIds.includes(202));
});

test("stale warmer already in progress cannot add tracks after a newer correction", async () => {
  const queue = new PlaybackQueue();
  const startupWarmStarted = deferred<void>();
  const startupWarmResume = deferred<void>();
  const staleSideEffects: string[] = [];
  const radio = brain({
    bridgePicker: async () => null,
    intentRouter: {
      classify: (text) =>
        intent({
          type: "correction",
          rawText: text,
          negativeConstraints: ["edm"],
          shouldReplan: true,
          shouldClearQueue: true,
        }),
    },
    planner: {
      plan: async (planArgs) => episode(planArgs.createdFrom),
    },
    warmer: {
      warm: async (warmArgs) => {
        if (warmArgs.episode.createdFrom === "startup") {
          assert.equal(typeof warmArgs.isCurrent, "function");
          startupWarmStarted.resolve();
          await startupWarmResume.promise;
          if (warmArgs.isCurrent?.()) {
            staleSideEffects.push("stale-current");
          }
          warmArgs.queue.addReady(track("stale-startup"), "stale-url", reason({ text: "stale startup" }));
          return 1;
        }
        assert.equal(warmArgs.isCurrent?.(), true);
        warmArgs.queue.addReady(track("fresh-correction"), "fresh-url", reason({ text: "fresh correction" }));
        return 1;
      },
    },
  });

  await radio.startSession(args(queue));
  await startupWarmStarted.promise;
  await radio.handleUserText({ ...args(queue), text: "不要 edm" });

  startupWarmResume.resolve();
  await flushBackground();

  assert.deepEqual(queue.readyItems().map((item) => item.track.id), ["fresh-correction"]);
  assert.deepEqual(staleSideEffects, []);
});

test("radio brain preserves narration segue text added by the warmer", async () => {
  const queue = new PlaybackQueue();
  const radio = brain({
    bridgePicker: async () => null,
    warmer: {
      warm: async (warmArgs) => {
        warmArgs.queue.addReady(track("bridge"), "bridge-url", reason({ text: "bridge" }), {
          segueText: "短暂做一首器乐过渡，下一首拉回 R&B。",
        });
        return 1;
      },
    },
  });

  await radio.startSession(args(queue));
  await flushBackground();

  assert.equal(queue.readyItems()[0]?.segueText, "短暂做一首器乐过渡，下一首拉回 R&B。");
});

test("evicted keyed startup work cannot add tracks after same-session correction", async () => {
  const queueA = new PlaybackQueue();
  const startupWarmStarted = deferred<void>();
  const startupWarmResume = deferred<void>();
  const staleSideEffects: string[] = [];
  const radio = brain({
    bridgePicker: async () => null,
    intentRouter: {
      classify: (text) =>
        intent({
          type: "correction",
          rawText: text,
          negativeConstraints: ["edm"],
          shouldReplan: true,
          shouldClearQueue: true,
        }),
    },
    planner: {
      plan: async (planArgs) => episode(planArgs.createdFrom),
    },
    warmer: {
      warm: async (warmArgs) => {
        if (warmArgs.uid === "user-a" && warmArgs.sessionId === 101 && warmArgs.episode.createdFrom === "startup") {
          startupWarmStarted.resolve();
          await startupWarmResume.promise;
          if (warmArgs.isCurrent?.()) {
            staleSideEffects.push("stale-current");
          }
          warmArgs.queue.addReady(track("stale-startup"), "stale-url", reason({ text: "stale startup" }));
          return 1;
        }
        if (warmArgs.uid === "user-a" && warmArgs.sessionId === 101 && warmArgs.episode.createdFrom === "correction") {
          assert.equal(warmArgs.isCurrent?.(), true);
          warmArgs.queue.addReady(track("fresh-correction"), "fresh-url", reason({ text: "fresh correction" }));
          return 1;
        }
        return 0;
      },
    },
  });

  await radio.startSession({ ...args(queueA), uid: "user-a", sessionId: 101 });
  await startupWarmStarted.promise;
  for (let i = 0; i < 256; i += 1) {
    await radio.startSession({ ...args(new PlaybackQueue()), uid: `evicting-user-${i}`, sessionId: i });
  }
  await radio.handleUserText({ ...args(queueA), uid: "user-a", sessionId: 101, text: "不要 edm" });

  startupWarmResume.resolve();
  await flushBackground();

  assert.deepEqual(queueA.readyItems().map((item) => item.track.id), ["fresh-correction"]);
  assert.deepEqual(staleSideEffects, []);
});

test("null-session fallback state migrates when identity becomes available on the same queue", async () => {
  const queue = new PlaybackQueue();
  const startupWarmStarted = deferred<void>();
  const startupWarmResume = deferred<void>();
  const radio = brain({
    bridgePicker: async () => null,
    intentRouter: {
      classify: (text) =>
        intent({
          type: "correction",
          rawText: text,
          negativeConstraints: ["edm"],
          shouldReplan: true,
          shouldClearQueue: true,
        }),
    },
    planner: {
      plan: async (planArgs) => episode(planArgs.createdFrom),
    },
    warmer: {
      warm: async (warmArgs) => {
        if (warmArgs.episode.createdFrom === "startup") {
          startupWarmStarted.resolve();
          await startupWarmResume.promise;
          warmArgs.queue.addReady(track("anonymous-stale"), "stale-url", reason({ text: "anonymous startup" }));
          return 1;
        }
        warmArgs.queue.addReady(track("identified-fresh"), "fresh-url", reason({ text: "identified correction" }));
        return 1;
      },
    },
  });

  await radio.startSession({ ...args(queue), uid: null, sessionId: null });
  await startupWarmStarted.promise;
  await radio.handleUserText({ ...args(queue), uid: "identified", sessionId: 99, text: "不要 edm" });

  startupWarmResume.resolve();
  await flushBackground();

  assert.deepEqual(queue.readyItems().map((item) => item.track.id), ["identified-fresh"]);
});

test("broad direction request returns acknowledgement before background planner resolves", async () => {
  const planning = deferred<RadioEpisode>();
  const radio = brain({
    intentRouter: { classify: (text) => intent({ type: "music_direction_request", rawText: text, shouldReplan: true, shouldClearQueue: false }) },
    planner: { plan: async (planArgs) => planning.promise.then(() => episode(planArgs.createdFrom)) },
    responder: {
      acknowledge: () => "moving that way",
      explainCurrentTrack: () => "unused",
    },
  });

  const result = await radio.handleUserText({ ...args(), text: "来点适合写代码的" });

  assert.deepEqual(result, { status: "acknowledged", hostText: "moving that way" });
  planning.resolve(episode("user_request"));
});

test("background planner failures are reported with session context", async () => {
  const failures: Array<Record<string, unknown>> = [];
  const radio = brain({
    planner: {
      plan: async () => {
        throw new Error("planner timeout");
      },
    },
    onBackgroundPlanFailure: (failure) => {
      failures.push(failure as unknown as Record<string, unknown>);
    },
  });

  await radio.handleUserText({ ...args(), text: "来点适合写代码的" });
  await flushBackground();

  assert.equal(failures.length, 1);
  assert.equal(failures[0]?.uid, "u1");
  assert.equal(failures[0]?.sessionId, 12);
  assert.equal(failures[0]?.createdFrom, "user_request");
  assert.equal(failures[0]?.intentType, "music_direction_request");
  assert.equal(failures[0]?.message, "planner timeout");
});

test("planner and warmer receive startup user and correction orchestration args", async () => {
  const queue = new PlaybackQueue();
  const pack = memoryPack();
  pack.sessionWorkingMemory.stationContract = {
    id: "contract-1",
    mainDirection: "late-night R&B",
    rawUserText: "late night r&b",
    allowedAdjacent: ["alt-R&B"],
    softBridge: ["ambient electronic"],
    disallowed: ["classical chamber music"],
    positiveSeeds: ["R&B"],
    negativeConstraints: [],
    driftBudget: 1,
    bridgeCount: 0,
    mustReturnToContract: false,
    hostStyle: "standard",
    createdAt: "2026-06-02T00:00:00.000Z",
    updatedAt: "2026-06-02T00:00:00.000Z",
  };
  const environment = env();
  const currentTrack = track("current-track");
  const playedTracks = [track("played-one")];
  const recentTurns = [{ role: "listener", text: "previous" }];
  queue.addReady(track("ready-track"), "url", reason({ text: "already ready" }));
  const planCalls: Array<{
    createdFrom: string;
    uid: string | null;
    sessionId: number | null;
    intentType: string;
    readyTrackIds: string[];
    sameEnvironment: boolean;
    currentTrackId: string | null;
    playedTrackIds: string[];
    sameRecentTurns: boolean;
    profileQualityLevel: string;
  }> = [];
  const warmCalls: Array<{
    createdFrom: string;
    uid: string | null;
    sessionId: number | null;
    intentType: string;
    targetReady: number;
    sameContextPack: boolean;
    sameEnvironment: boolean;
    profileQualityLevel: string;
    stationContractId: string | null;
  }> = [];
  const intents = [
    intent({ type: "music_direction_request", rawText: "more focus", shouldReplan: true, shouldClearQueue: false }),
    intent({ type: "correction", rawText: "not edm", negativeConstraints: ["edm"], shouldReplan: true, shouldClearQueue: true }),
  ];
  const radio = brain({
    bridgePicker: async () => null,
    intentRouter: {
      classify: () => intents.shift() || intent({ shouldReplan: false, shouldClearQueue: false }),
    },
    planner: {
      plan: async (planArgs) => {
        planCalls.push({
          createdFrom: planArgs.createdFrom,
          uid: planArgs.uid,
          sessionId: planArgs.sessionId,
          intentType: planArgs.intent.type,
          readyTrackIds: planArgs.readyTracks.map((readyTrack) => readyTrack.id),
          sameEnvironment: planArgs.environment === environment,
          currentTrackId: planArgs.currentTrack?.id || null,
          playedTrackIds: planArgs.playedTracks.map((playedTrack) => playedTrack.id),
          sameRecentTurns: planArgs.recentTurns === recentTurns,
          profileQualityLevel: planArgs.profileQuality.level,
        });
        return episode(planArgs.createdFrom);
      },
    },
    warmer: {
      warm: async (warmArgs) => {
        warmCalls.push({
          createdFrom: warmArgs.episode.createdFrom,
          uid: warmArgs.uid,
          sessionId: warmArgs.sessionId,
          intentType: warmArgs.intentType,
          targetReady: warmArgs.targetReady,
          sameContextPack: warmArgs.contextPack === pack,
          sameEnvironment: warmArgs.environment === environment,
          profileQualityLevel: warmArgs.profileQuality.level,
          stationContractId: warmArgs.stationContract?.id || null,
        });
        return 0;
      },
    },
  });

  const sharedArgs = {
    ...args(queue),
    uid: "arg-user",
    sessionId: 456,
    contextPack: pack,
    environment,
    currentTrack,
    playedTracks,
    recentTurns,
  };
  await radio.startSession(sharedArgs);
  await radio.handleUserText({ ...sharedArgs, text: "more focus" });
  await radio.handleUserText({ ...sharedArgs, text: "not edm" });
  await flushBackground();

  assert.deepEqual(planCalls.map((call) => call.createdFrom), ["startup", "user_request", "correction"]);
  assert.deepEqual(planCalls.map((call) => call.profileQualityLevel), ["low_confidence", "low_confidence", "low_confidence"]);
  assert.deepEqual(planCalls.map((call) => call.uid), ["arg-user", "arg-user", "arg-user"]);
  assert.deepEqual(planCalls.map((call) => call.sessionId), [456, 456, 456]);
  assert.deepEqual(planCalls.map((call) => call.intentType), ["continuation", "music_direction_request", "correction"]);
  assert.deepEqual(planCalls.map((call) => call.sameEnvironment), [true, true, true]);
  assert.deepEqual(planCalls.map((call) => call.currentTrackId), ["current-track", "current-track", "current-track"]);
  assert.deepEqual(planCalls.map((call) => call.playedTrackIds), [["played-one"], ["played-one"], ["played-one"]]);
  assert.deepEqual(planCalls.map((call) => call.sameRecentTurns), [true, true, true]);
  assert.deepEqual(planCalls[0]?.readyTrackIds, ["ready-track"]);
  assert.deepEqual(warmCalls, [
    {
      createdFrom: "startup",
      uid: "arg-user",
      sessionId: 456,
      intentType: "autoplay",
      targetReady: 2,
      sameContextPack: true,
      sameEnvironment: true,
      profileQualityLevel: "low_confidence",
      stationContractId: "contract-1",
    },
    {
      createdFrom: "user_request",
      uid: "arg-user",
      sessionId: 456,
      intentType: "music_direction_request",
      targetReady: 2,
      sameContextPack: true,
      sameEnvironment: true,
      profileQualityLevel: "low_confidence",
      stationContractId: "contract-1",
    },
    {
      createdFrom: "correction",
      uid: "arg-user",
      sessionId: 456,
      intentType: "correction",
      targetReady: 2,
      sameContextPack: true,
      sameEnvironment: true,
      profileQualityLevel: "low_confidence",
      stationContractId: "contract-1",
    },
  ]);
});

test("normal music direction request does not call reflectionLoop.record as negative feedback", async () => {
  let recordCount = 0;
  const radio = brain({
    intentRouter: { classify: (text) => intent({ type: "music_direction_request", rawText: text, shouldReplan: false, shouldClearQueue: false }) },
    reflectionLoop: {
      record: (recordArgs) => {
        recordCount += 1;
        assert.notEqual(recordArgs.event, "negative_feedback");
        return recordArgs.existing;
      },
    },
  });

  await radio.handleUserText({ ...args(), text: "来点适合写代码的" });

  assert.equal(recordCount, 0);
});

test("reflection memory persists across calls with fresh context packs", async () => {
  const seenExistingConstraints: string[][] = [];
  const constraints = [["avoid-bright"], ["avoid-cold"]];
  const radio = brain({
    intentRouter: {
      classify: (text) =>
        intent({
          type: "preference_update",
          rawText: text,
          negativeConstraints: constraints.shift() || [],
          shouldReplan: false,
          shouldClearQueue: false,
        }),
    },
    reflectionLoop: {
      record: (recordArgs) => {
        seenExistingConstraints.push(recordArgs.existing.currentConstraints || []);
        return {
          ...recordArgs.existing,
          currentConstraints: [...(recordArgs.existing.currentConstraints || []), ...(recordArgs.constraints || [])],
        };
      },
    },
  });

  await radio.handleUserText({ ...args(), contextPack: memoryPack(), text: "以后少放亮的" });
  await radio.handleUserText({ ...args(), contextPack: memoryPack(), text: "以后少放冷的" });

  assert.deepEqual(seenExistingConstraints, [["old"], ["old", "avoid-bright"]]);
});

test("reflection memory is isolated between user sessions on one radio brain", async () => {
  const seenExistingConstraints: string[][] = [];
  const radio = brain({
    intentRouter: {
      classify: (text) =>
        intent({
          type: "preference_update",
          rawText: text,
          negativeConstraints: [text],
          shouldReplan: false,
          shouldClearQueue: false,
        }),
    },
    reflectionLoop: {
      record: (recordArgs) => {
        seenExistingConstraints.push(recordArgs.existing.currentConstraints || []);
        return {
          ...recordArgs.existing,
          currentConstraints: [...(recordArgs.existing.currentConstraints || []), ...(recordArgs.constraints || [])],
        };
      },
    },
  });

  await radio.handleUserText({ ...args(), uid: "user-a", sessionId: 1, contextPack: memoryPack(), text: "avoid-a" });
  await radio.handleUserText({ ...args(), uid: "user-b", sessionId: 2, contextPack: memoryPack(), text: "avoid-b" });

  assert.deepEqual(seenExistingConstraints, [["old"], ["old"]]);
});

test("keyed session reflection state is bounded and evicts oldest sessions", async () => {
  const seenExistingConstraints: string[][] = [];
  const radio = brain({
    intentRouter: {
      classify: (text) =>
        intent({
          type: "preference_update",
          rawText: text,
          negativeConstraints: [text],
          shouldReplan: false,
          shouldClearQueue: false,
        }),
    },
    reflectionLoop: {
      record: (recordArgs) => {
        seenExistingConstraints.push(recordArgs.existing.currentConstraints || []);
        return {
          ...recordArgs.existing,
          currentConstraints: [...(recordArgs.existing.currentConstraints || []), ...(recordArgs.constraints || [])],
        };
      },
    },
  });

  await radio.handleUserText({ ...args(), uid: "oldest", sessionId: 1, contextPack: memoryPack(), text: "oldest-pref" });
  for (let index = 0; index < 256; index += 1) {
    await radio.handleUserText({ ...args(), uid: `user-${index}`, sessionId: index, contextPack: memoryPack(), text: `pref-${index}` });
  }
  await radio.handleUserText({ ...args(), uid: "oldest", sessionId: 1, contextPack: memoryPack(), text: "oldest-again" });

  assert.deepEqual(seenExistingConstraints.at(-1), ["old"]);
});
