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
    traceStore: { latestForSession: () => null },
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
  await new Promise((resolve) => setImmediate(resolve));

  assert.ok(createdFrom.includes("startup"));
  assert.ok(createdFrom.includes("correction"));
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
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(warmCreatedFrom, []);

  correctionPlanning.resolve(episode("correction"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(warmCreatedFrom, ["correction"]);
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

test("planner and warmer receive startup user and correction orchestration args", async () => {
  const queue = new PlaybackQueue();
  const pack = memoryPack();
  queue.addReady(track("ready-track"), "url", reason({ text: "already ready" }));
  const planCalls: Array<{ createdFrom: string; readyTrackIds: string[]; profileQualityLevel: string }> = [];
  const warmCalls: Array<{ createdFrom: string; intentType: string; targetReady: number; sameContextPack: boolean; profileQualityLevel: string }> = [];
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
          readyTrackIds: planArgs.readyTracks.map((readyTrack) => readyTrack.id),
          profileQualityLevel: planArgs.profileQuality.level,
        });
        return episode(planArgs.createdFrom);
      },
    },
    warmer: {
      warm: async (warmArgs) => {
        warmCalls.push({
          createdFrom: warmArgs.episode.createdFrom,
          intentType: warmArgs.intentType,
          targetReady: warmArgs.targetReady,
          sameContextPack: warmArgs.contextPack === pack,
          profileQualityLevel: warmArgs.profileQuality.level,
        });
        return 0;
      },
    },
  });

  await radio.startSession({ ...args(queue), contextPack: pack });
  await radio.handleUserText({ ...args(queue), contextPack: pack, text: "more focus" });
  await radio.handleUserText({ ...args(queue), contextPack: pack, text: "not edm" });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(planCalls.map((call) => call.createdFrom), ["startup", "user_request", "correction"]);
  assert.deepEqual(planCalls.map((call) => call.profileQualityLevel), ["low_confidence", "low_confidence", "low_confidence"]);
  assert.deepEqual(planCalls[0]?.readyTrackIds, ["ready-track"]);
  assert.deepEqual(warmCalls, [
    {
      createdFrom: "startup",
      intentType: "autoplay",
      targetReady: 2,
      sameContextPack: true,
      profileQualityLevel: "low_confidence",
    },
    {
      createdFrom: "user_request",
      intentType: "music_direction_request",
      targetReady: 2,
      sameContextPack: true,
      profileQualityLevel: "low_confidence",
    },
    {
      createdFrom: "correction",
      intentType: "correction",
      targetReady: 2,
      sameContextPack: true,
      profileQualityLevel: "low_confidence",
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
