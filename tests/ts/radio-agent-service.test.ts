import assert from "node:assert/strict";
import test from "node:test";

import { ContractController } from "../../src/radio-agent/contractController.js";
import { RadioAgentService } from "../../src/radio-agent/radioAgentService.js";
import type { OpeningTrackPick } from "../../src/radio-agent/openingTrack.js";
import type { AgentSessionContract } from "../../src/radio-agent/playbackGovernor.js";
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

test("service exposes explicit play action for a prepared opening", async () => {
  const openingTrack: Track = { id: "liked-1", name: "Pink + White", artist: "Frank Ocean" };
  const service = new RadioAgentService({
    chooseOpeningTrack: () => ({
      track: openingTrack,
      reason: { type: "radio_agent_opening_liked", sourceRank: 3 },
    }) satisfies OpeningTrackPick,
    prepareTrack: async (track) => prepared(track, { type: "radio_agent_opening_liked", text: "Started from a liked track." }),
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

  assert.deepEqual(result.actions.map((action) => action.type), ["play_now"]);
  assert.equal(result.actions[0]?.type, "play_now");
  if (result.actions[0]?.type !== "play_now") throw new Error("expected play_now action");
  assert.equal(result.actions[0].track.id, "liked-1");
  assert.equal(result.actions[0].url, "/audio/liked-1");
  assert.equal(result.actions[0].reason.type, "radio_agent_opening_liked");
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

test("service exposes honest_not_found action when user direction has no playable candidate", async () => {
  const programWindow = radioWindow({
    id: "window-empty",
    stationBrief: "Quiet jazz for reading.",
    mainDirection: "quiet jazz for reading",
    allowedAdjacent: ["modal jazz"],
    disallowed: ["high energy EDM"],
    candidateTasks: [
      { query: "Miles Davis Blue in Green", reason: "Quiet jazz reading anchor.", style: "jazz", negativeConstraints: [] },
      { query: "Bill Evans Peace Piece", reason: "Soft piano jazz backup.", style: "jazz", negativeConstraints: [] },
    ],
  });
  const service = new RadioAgentService({
    chooseOpeningTrack: () => null,
    prepareTrack: async () => null,
    handleRadioAgentEvent: async () =>
      ({
        controlsPlayback: false,
        event: { uid: "42", sessionId: 7, type: "user_text", priority: "hot", payload: {}, createdAt: "2026-06-11T00:00:00.000Z" },
        hostDecision: {
          shouldSpeak: true,
          event: "recovery",
          reason: "no playable candidate",
          text: "I could not find a playable match for that direction yet.",
        },
        programWindow,
      }) satisfies RadioAgentHandleResult,
    prepareProgramWindow: async () => null,
    hostTextForDelivery: ({ decision }) => decision?.text || "",
  });

  const result = await service.handleUserText({
    uid: "42",
    sessionId: 7,
    text: "play quiet jazz for reading",
    currentTrack: null,
    readyQueue: [],
    shouldClearQueue: false,
  });

  const notFound = result.actions.find((action) => action.type === "honest_not_found");
  assert.equal(notFound?.type, "honest_not_found");
  if (notFound?.type !== "honest_not_found") throw new Error("expected honest_not_found action");
  assert.equal("stationBrief" in (notFound.contract || {}) ? notFound.contract?.stationBrief : notFound.contract?.mainDirection, "quiet jazz for reading.");
  assert.equal(notFound.contract?.rawUserText, "play quiet jazz for reading");
  assert.match(notFound.reason, /no playable candidate/i);
  assert.deepEqual(notFound.searchedQueries, ["Miles Davis Blue in Green", "Bill Evans Peace Piece"]);
});

test("service creates and retains a contract when explicit direction cannot queue a playable item", async () => {
  const stored: AgentSessionContract[] = [];
  const contractController = new ContractController({ now: () => "2026-06-16T00:00:00.000Z" });
  const programWindow = radioWindow({
    id: "window-empty-contract",
    stationBrief: "Quiet jazz for reading.",
    mainDirection: "quiet jazz for reading",
    candidateTasks: [
      { query: "Miles Davis Blue in Green", reason: "Quiet jazz reading anchor.", style: "jazz", negativeConstraints: [] },
    ],
  });
  const service = new RadioAgentService({
    contractController,
    activeContractStore: {
      get: () => stored.at(-1) || null,
      set: (contract) => {
        stored.push(contract);
      },
    },
    chooseOpeningTrack: () => null,
    prepareTrack: async () => null,
    handleRadioAgentEvent: async () =>
      ({
        controlsPlayback: false,
        event: { uid: "42", sessionId: 7, type: "user_text", priority: "hot", payload: {}, createdAt: "2026-06-16T00:00:00.000Z" },
        hostDecision: { shouldSpeak: false, event: "silent", reason: "test" },
        programWindow,
      }) satisfies RadioAgentHandleResult,
    prepareProgramWindow: async () => null,
  });

  const result = await service.handleUserText({
    uid: "42",
    sessionId: 7,
    text: "play quiet jazz for reading",
    currentTrack: null,
    readyQueue: [],
    shouldClearQueue: false,
  });

  assert.equal(stored.at(-1)?.rawUserText, "play quiet jazz for reading");
  assert.equal(stored.at(-1)?.status, "active");
  assert.ok(result.actions.some((action) => action.type === "repair_contract"));
  const notFound = result.actions.find((action) => action.type === "honest_not_found");
  assert.equal(notFound?.type, "honest_not_found");
  if (notFound?.type !== "honest_not_found") throw new Error("expected honest_not_found action");
  assert.equal(notFound.contract?.id, stored.at(-1)?.id);
  assert.deepEqual(notFound.searchedQueries, ["Miles Davis Blue in Green"]);
});

test("service rejects prepared duplicate through playback governor before returning a play action", async () => {
  const duplicateTrack: Track = { id: "duplicate-alt", name: "Good Days", artist: "SZA" };
  const contract = serviceContract({ rawUserText: "play rnb", stationBrief: "late-night R&B." });
  const programWindow = radioWindow({
    id: "window-duplicate",
    stationBrief: "Late-night R&B.",
    mainDirection: "late-night R&B",
    candidateTasks: [{ query: "SZA Good Days", reason: "Known R&B anchor.", style: "R&B", negativeConstraints: [] }],
  });
  const governorCalls: Array<{ contractId: string | null; candidateId: string }> = [];
  const service = new RadioAgentService({
    activeContractStore: {
      get: () => contract,
      set: () => undefined,
    },
    playbackGovernor: {
      evaluate: async (args) => {
        governorCalls.push({ contractId: args.contract?.id || null, candidateId: args.candidate.id });
        return {
          status: "rejected",
          reason: "reject_duplicate_recent",
          trace: {
            status: "rejected",
            contractId: args.contract?.id || null,
            requestToken: args.requestToken,
            candidateKey: "sza::gooddays",
            decision: "reject_duplicate_recent",
            evidence: ["candidate matches recent playback"],
          },
        };
      },
    },
    chooseOpeningTrack: () => null,
    prepareTrack: async () => null,
    handleRadioAgentEvent: async () =>
      ({
        controlsPlayback: false,
        event: { uid: "42", sessionId: 7, type: "user_text", priority: "hot", payload: {}, createdAt: "2026-06-16T00:00:00.000Z" },
        hostDecision: { shouldSpeak: false, event: "silent", reason: "test" },
        programWindow,
      }) satisfies RadioAgentHandleResult,
    prepareProgramWindow: async () => prepared(duplicateTrack, { type: "radio_agent_program", text: "Known R&B anchor." }),
  });

  const result = await service.handleUserText({
    uid: "42",
    sessionId: 7,
    text: "play rnb",
    currentTrack: null,
    recentTracks: [{ id: "recent-sza", name: "Good Days", artist: "SZA" }],
    readyQueue: [],
    shouldClearQueue: false,
  });

  assert.deepEqual(governorCalls, [{ contractId: "contract-test", candidateId: "duplicate-alt" }]);
  assert.ok(!result.actions.some((action) => action.type === "play_now"));
  const notFound = result.actions.find((action) => action.type === "honest_not_found");
  assert.equal(notFound?.type, "honest_not_found");
  if (notFound?.type !== "honest_not_found") throw new Error("expected honest_not_found action");
  assert.equal(notFound.reason, "reject_duplicate_recent");
  assert.equal(notFound.governanceTrace?.decision, "reject_duplicate_recent");
});

test("service can execute an explicit direction through the queue adapter when direct preparation is unavailable", async () => {
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

test("service prefers concrete program window host intent over generic acknowledgement", async () => {
  const calls: string[] = [];
  const programWindow = radioWindow({
    id: "window-jazz",
    stationBrief: "Quiet jazz for reading.",
    mainDirection: "quiet jazz for reading",
    hostIntent: {
      shouldSpeak: true,
      event: "request_ack",
      reason: "listener changed the active music direction",
      text: "好，接下来收进安静爵士，适合阅读，我先给你找一首稳的。",
    },
  });
  const service = new RadioAgentService({
    chooseOpeningTrack: () => null,
    prepareTrack: async () => null,
    handleRadioAgentEvent: async () => ({
      controlsPlayback: false,
      event: { uid: "42", sessionId: 7, type: "user_text", priority: "hot", payload: {}, createdAt: "2026-06-11T00:00:00.000Z" },
      hostDecision: {
        shouldSpeak: true,
        event: "request_ack",
        reason: "generic acknowledgement",
        text: "收到，我会按这个方向调整。",
      },
      programWindow,
    }) satisfies RadioAgentHandleResult,
    queueProgramWindow: async () => true,
    hostTextForDelivery: ({ eventType, decision }) => {
      calls.push(`host:${eventType}:${decision?.text}`);
      return decision?.text || "";
    },
  });

  const result = await service.handleUserText({
    uid: "42",
    sessionId: 7,
    text: "播放安静爵士阅读",
    currentTrack: null,
    readyQueue: [],
    shouldClearQueue: false,
  });

  assert.equal(result.programQueued, true);
  assert.equal(result.hostText, "好，接下来收进安静爵士，适合阅读，我先给你找一首稳的。");
  assert.deepEqual(calls, ["host:user_text:好，接下来收进安静爵士，适合阅读，我先给你找一首稳的。"]);
});

test("service times out explicit direction queueing so request fallback can continue", async () => {
  const calls: string[] = [];
  const programWindow = radioWindow({
    id: "window-slow",
    stationBrief: "Quiet jazz for reading.",
    mainDirection: "quiet jazz for reading",
  });
  const service = new RadioAgentService({
    chooseOpeningTrack: () => null,
    prepareTrack: async () => null,
    handleRadioAgentEvent: async () => {
      calls.push("agent");
      return {
        controlsPlayback: false,
        event: { uid: "42", sessionId: 7, type: "user_text", priority: "hot", payload: {}, createdAt: "2026-06-11T00:00:00.000Z" },
        hostDecision: {
          shouldSpeak: true,
          event: "request_ack",
          reason: "listener changed direction",
          text: "Okay.",
        },
        programWindow,
      } satisfies RadioAgentHandleResult;
    },
    queueProgramWindow: async () => {
      calls.push("queue-start");
      return await new Promise<boolean>(() => undefined);
    },
    hostTextForDelivery: ({ eventType, decision }) => {
      calls.push(`host:${eventType}`);
      return decision?.text || "";
    },
    userTextQueueTimeoutMs: 1,
  });

  const result = await service.handleUserText({
    uid: "42",
    sessionId: 7,
    text: "play quiet jazz for reading",
    currentTrack: null,
    readyQueue: [],
    shouldClearQueue: false,
  });

  assert.equal(result.programWindow?.id, "window-slow");
  assert.equal(result.programQueued, false);
  assert.equal(result.fallbackReason, "radio_agent_user_text_queue_timeout");
  assert.deepEqual(calls, ["agent", "queue-start", "host:user_text"]);
});

test("service prepares a request track directly when background queueing times out", async () => {
  const preparedTrack = prepared(
    { id: "sza-good-days", name: "Good Days", artist: "SZA" },
    { type: "radio_agent_program", text: "Known R&B anchor." },
  );
  const programWindow = radioWindow({
    id: "window-timeout-direct",
    stationBrief: "Late-night R&B.",
    mainDirection: "R&B vocals and groove.",
    candidateTasks: [
      { query: "SZA Good Days", reason: "Known R&B anchor.", style: "R&B", negativeConstraints: [] },
    ],
  });
  const service = new RadioAgentService({
    chooseOpeningTrack: () => null,
    prepareTrack: async () => null,
    handleRadioAgentEvent: async () =>
      ({
        controlsPlayback: false,
        event: { uid: "42", sessionId: 7, type: "user_text", priority: "hot", payload: {}, createdAt: "2026-06-11T00:00:00.000Z" },
        hostDecision: {
          shouldSpeak: true,
          event: "request_ack",
          reason: "listener direction",
          text: "好，先守住 R&B，人声和律动靠前，不乱跳出去。",
        },
        programWindow,
      }) satisfies RadioAgentHandleResult,
    queueProgramWindow: async () => {
      await new Promise((resolve) => setTimeout(resolve, 40));
      return false;
    },
    prepareProgramWindow: async () => preparedTrack,
    playbackGovernor: {
      evaluate: async () => ({
        status: "accepted",
        track: preparedTrack.track,
        url: preparedTrack.url,
        trace: {
          status: "accepted",
          contractId: "contract-test",
          requestToken: 1,
          candidateKey: "SZA::Good Days",
          decision: "direct_positive",
          evidence: ["R&B anchor"],
        },
      }),
    },
    hostTextForDelivery: ({ decision }) => decision?.text || "",
    userTextQueueTimeoutMs: 1,
  });

  const result = await service.handleUserText({
    uid: "42",
    sessionId: 7,
    text: "play rnb",
    currentTrack: null,
    readyQueue: [],
    shouldClearQueue: true,
  });

  assert.equal(result.preparedTrack?.track.id, "sza-good-days");
  assert.equal(result.fallbackReason, undefined);
  assert.ok(result.actions.some((action) => action.type === "play_now"));
  assert.equal(result.actions.some((action) => action.type === "honest_not_found"), false);
});

test("service prepares and governs an explicit request before starting background queueing", async () => {
  const calls: string[] = [];
  const preparedTrack = prepared(
    { id: "daniel-get-you", name: "Get You", artist: "Daniel Caesar" },
    { type: "radio_agent_program", text: "Fresh R&B anchor." },
  );
  const programWindow = radioWindow({
    id: "window-direct-first",
    stationBrief: "Late-night R&B.",
    mainDirection: "R&B vocals and groove.",
    candidateTasks: [
      { query: "Daniel Caesar Get You", reason: "Fresh R&B anchor.", style: "R&B", negativeConstraints: [] },
    ],
  });
  const service = new RadioAgentService({
    chooseOpeningTrack: () => null,
    prepareTrack: async () => null,
    handleRadioAgentEvent: async () => {
      calls.push("agent");
      return {
        controlsPlayback: false,
        event: { uid: "42", sessionId: 7, type: "user_text", priority: "hot", payload: {}, createdAt: "2026-06-11T00:00:00.000Z" },
        hostDecision: { shouldSpeak: false, event: "request_ack", reason: "listener direction", text: "" },
        programWindow,
      } satisfies RadioAgentHandleResult;
    },
    clearReadyQueue: () => calls.push("clear"),
    prepareProgramWindow: async () => {
      calls.push("prepare");
      return preparedTrack;
    },
    playbackGovernor: {
      evaluate: async () => {
        calls.push("govern");
        return {
          status: "accepted",
          track: preparedTrack.track,
          url: preparedTrack.url,
          trace: {
            status: "accepted",
            contractId: "contract-test",
            requestToken: 1,
            candidateKey: "Daniel Caesar::Get You",
            decision: "direct_positive",
            evidence: ["fresh R&B anchor"],
          },
        };
      },
    },
    queueProgramWindow: async () => {
      calls.push("queue-start");
      return true;
    },
    hostTextForDelivery: ({ decision }) => decision?.text || "",
  });

  const result = await service.handleUserText({
    uid: "42",
    sessionId: 7,
    text: "play rnb",
    currentTrack: null,
    readyQueue: [],
    shouldClearQueue: true,
  });

  assert.equal(result.preparedTrack?.track.id, "daniel-get-you");
  assert.deepEqual(calls, ["agent", "clear", "prepare", "govern"]);
  assert.equal(result.programQueued, false);
});

test("service starts explicit request preparation from concrete candidates before generic style queries", async () => {
  const preparedTrack = prepared(
    { id: "daniel-japanese-denim", name: "Japanese Denim", artist: "Daniel Caesar" },
    { type: "radio_agent_program", text: "Concrete R&B anchor." },
  );
  const preparedOffsets: Array<number | undefined> = [];
  const programWindow = radioWindow({
    id: "window-generic-first",
    stationBrief: "rnb",
    mainDirection: "rnb",
    candidateTasks: [
      { query: "rnb", reason: "Generic style direction.", style: "R&B", negativeConstraints: [] },
      { query: "Daniel Caesar Japanese Denim", reason: "Concrete R&B anchor.", style: "R&B", negativeConstraints: [] },
      { query: "SZA Broken Clocks", reason: "Concrete R&B backup.", style: "R&B", negativeConstraints: [] },
    ],
  });
  const service = new RadioAgentService({
    chooseOpeningTrack: () => null,
    prepareTrack: async () => null,
    handleRadioAgentEvent: async () =>
      ({
        controlsPlayback: false,
        event: { uid: "42", sessionId: 7, type: "user_text", priority: "hot", payload: {}, createdAt: "2026-06-11T00:00:00.000Z" },
        hostDecision: { shouldSpeak: false, event: "request_ack", reason: "listener direction", text: "" },
        programWindow,
      }) satisfies RadioAgentHandleResult,
    prepareProgramWindow: async (_window, options?: { skipCandidates?: number }) => {
      preparedOffsets.push(options?.skipCandidates);
      return options?.skipCandidates === 1 ? preparedTrack : null;
    },
    playbackGovernor: {
      evaluate: async () => ({
        status: "accepted",
        track: preparedTrack.track,
        url: preparedTrack.url,
        trace: {
          status: "accepted",
          contractId: "contract-test",
          requestToken: 1,
          candidateKey: "Daniel Caesar::Japanese Denim",
          decision: "direct_positive",
          evidence: ["concrete R&B anchor"],
        },
      }),
    },
    hostTextForDelivery: ({ decision }) => decision?.text || "",
  });

  const result = await service.handleUserText({
    uid: "42",
    sessionId: 7,
    text: "play rnb",
    currentTrack: null,
    readyQueue: [],
    shouldClearQueue: true,
  });

  assert.equal(result.preparedTrack?.track.id, "daniel-japanese-denim");
  assert.equal(preparedOffsets[0], 1);
});

test("service times out a slow candidate preparation and tries the next concrete candidate", async () => {
  const preparedTrack = prepared(
    { id: "sza-broken-clocks", name: "Broken Clocks", artist: "SZA" },
    { type: "radio_agent_program", text: "Second concrete R&B anchor." },
  );
  const preparedOffsets: Array<number | undefined> = [];
  const programWindow = radioWindow({
    id: "window-slow-candidate",
    stationBrief: "rnb",
    mainDirection: "rnb",
    candidateTasks: [
      { query: "Daniel Caesar Japanese Denim", reason: "Slow candidate.", style: "R&B", negativeConstraints: [] },
      { query: "SZA Broken Clocks", reason: "Second concrete R&B anchor.", style: "R&B", negativeConstraints: [] },
    ],
  });
  const service = new RadioAgentService({
    chooseOpeningTrack: () => null,
    prepareTrack: async () => null,
    handleRadioAgentEvent: async () =>
      ({
        controlsPlayback: false,
        event: { uid: "42", sessionId: 7, type: "user_text", priority: "hot", payload: {}, createdAt: "2026-06-11T00:00:00.000Z" },
        hostDecision: { shouldSpeak: false, event: "request_ack", reason: "listener direction", text: "" },
        programWindow,
      }) satisfies RadioAgentHandleResult,
    prepareProgramWindow: async (_window, options?: { skipCandidates?: number }) => {
      preparedOffsets.push(options?.skipCandidates);
      if (!options?.skipCandidates) return await new Promise<RadioAgentPreparedTrack | null>(() => undefined);
      return preparedTrack;
    },
    playbackGovernor: {
      evaluate: async () => ({
        status: "accepted",
        track: preparedTrack.track,
        url: preparedTrack.url,
        trace: {
          status: "accepted",
          contractId: "contract-test",
          requestToken: 1,
          candidateKey: "SZA::Broken Clocks",
          decision: "direct_positive",
          evidence: ["second concrete R&B anchor"],
        },
      }),
    },
    hostTextForDelivery: ({ decision }) => decision?.text || "",
    programCandidateTimeoutMs: 1,
  });

  const result = await service.handleUserText({
    uid: "42",
    sessionId: 7,
    text: "play rnb",
    currentTrack: null,
    readyQueue: [],
    shouldClearQueue: true,
  });

  assert.deepEqual(preparedOffsets, [undefined, 1]);
  assert.equal(result.preparedTrack?.track.id, "sza-broken-clocks");
});

test("service tries the next program candidate when governor rejects the first prepared request track", async () => {
  const rejectedTrack = prepared(
    { id: "pink-remix", name: "frank ocean - pinkpuss (pink + white remix)", artist: "LegoG" },
    { type: "radio_agent_program", text: "Rejected duplicate." },
  );
  const acceptedTrack = prepared(
    { id: "daniel-get-you", name: "Get You", artist: "Daniel Caesar" },
    { type: "radio_agent_program", text: "Fresh R&B anchor." },
  );
  const preparedOffsets: Array<number | undefined> = [];
  const programWindow = radioWindow({
    id: "window-governor-retry",
    stationBrief: "Late-night R&B.",
    mainDirection: "R&B vocals and groove.",
    candidateTasks: [
      { query: "Frank Ocean Pink + White", reason: "Current-adjacent R&B.", style: "R&B", negativeConstraints: [] },
      { query: "Daniel Caesar Get You", reason: "Fresh R&B anchor.", style: "R&B", negativeConstraints: [] },
    ],
  });
  const service = new RadioAgentService({
    chooseOpeningTrack: () => null,
    prepareTrack: async () => null,
    handleRadioAgentEvent: async () =>
      ({
        controlsPlayback: false,
        event: { uid: "42", sessionId: 7, type: "user_text", priority: "hot", payload: {}, createdAt: "2026-06-11T00:00:00.000Z" },
        hostDecision: { shouldSpeak: false, event: "request_ack", reason: "listener direction", text: "" },
        programWindow,
      }) satisfies RadioAgentHandleResult,
    queueProgramWindow: async () => false,
    prepareProgramWindow: async (_window, options?: { skipCandidates?: number }) => {
      preparedOffsets.push(options?.skipCandidates);
      return options?.skipCandidates ? acceptedTrack : rejectedTrack;
    },
    playbackGovernor: {
      evaluate: async ({ candidate }) =>
        candidate.id === "pink-remix"
          ? {
              status: "rejected",
              reason: "reject_duplicate_recent",
              trace: {
                status: "rejected",
                contractId: "contract-test",
                requestToken: 1,
                candidateKey: "LegoG::pinkpuss",
                decision: "reject_duplicate_recent",
                evidence: ["candidate matches current or recent playback"],
              },
            }
          : {
              status: "accepted",
              track: acceptedTrack.track,
              url: acceptedTrack.url,
              trace: {
                status: "accepted",
                contractId: "contract-test",
                requestToken: 1,
                candidateKey: "Daniel Caesar::Get You",
                decision: "direct_positive",
                evidence: ["fresh R&B anchor"],
              },
            },
    },
    hostTextForDelivery: ({ decision }) => decision?.text || "",
  });

  const result = await service.handleUserText({
    uid: "42",
    sessionId: 7,
    text: "play rnb",
    currentTrack: { id: "pink-white", name: "Pink + White", artist: "Frank Ocean" },
    recentTracks: [],
    readyQueue: [],
    shouldClearQueue: true,
  });

  assert.deepEqual(preparedOffsets, [undefined, 1]);
  assert.equal(result.preparedTrack?.track.id, "daniel-get-you");
  assert.ok(result.actions.some((action) => action.type === "play_now"));
  assert.equal(result.fallbackReason, undefined);
});

test("service repairs the active window after explicit negative feedback", async () => {
  const calls: string[] = [];
  const programWindow = radioWindow({
    id: "window-repaired",
    stationBrief: "Move away from the rejected artist.",
    mainDirection: "mellow R&B without Frank Ocean",
    disallowed: ["Frank Ocean"],
    candidateTasks: [
      {
        query: "SZA Good Days",
        reason: "Nearby replacement that avoids the rejected artist.",
        style: "R&B",
        negativeConstraints: ["Frank Ocean"],
      },
    ],
    hostIntent: {
      shouldSpeak: true,
      event: "correction",
      reason: "listener rejected the current artist",
      text: "明白，我先避开 Frank Ocean，换成更稳的 R&B。",
    },
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
          event: "correction",
          reason: "listener rejected the current artist",
          text: "明白，我先避开 Frank Ocean，换成更稳的 R&B。",
        },
        programWindow,
      } satisfies RadioAgentHandleResult;
    },
    clearReadyQueue: () => {
      calls.push("clear");
    },
    queueProgramWindow: async (window) => {
      calls.push(`queue:${window.id}`);
      return true;
    },
    hostTextForDelivery: ({ eventType, decision }) => {
      calls.push(`host:${eventType}:${decision?.event}`);
      return decision?.text || "";
    },
  });

  const result = await service.handleCorrection({
    uid: "42",
    sessionId: 7,
    text: "don't play Frank Ocean tonight",
    currentTrack: { id: "frank-1", name: "Pink + White", artist: "Frank Ocean" },
    readyQueue: [{ id: "frank-2", name: "Nights", artist: "Frank Ocean" }],
  });

  assert.equal(result.programWindow?.id, "window-repaired");
  assert.equal(result.programQueued, true);
  assert.equal(result.shouldClearQueue, true);
  const speech = result.actions.find((action) => action.type === "speak");
  assert.equal(speech?.type, "speak");
  if (speech?.type !== "speak") throw new Error("expected correction speech action");
  assert.equal(speech.speechRole, "correction");
  assert.equal(result.hostText, "明白，我先避开 Frank Ocean，换成更稳的 R&B。");
  assert.deepEqual(calls, [
    "agent:user_text:don't play Frank Ocean tonight",
    "clear",
    "queue:window-repaired",
    "host:user_text:correction",
  ]);
});

test("service does not return unsafe host text from its delivery boundary", async () => {
  const service = new RadioAgentService({
    chooseOpeningTrack: () => null,
    prepareTrack: async () => null,
    handleRadioAgentEvent: async () =>
      ({
        controlsPlayback: false,
        event: { uid: "42", sessionId: 7, type: "user_text", priority: "hot", payload: {}, createdAt: "2026-06-11T00:00:00.000Z" },
        hostDecision: {
          shouldSpeak: true,
          event: "request_ack",
          reason: "listener changed direction",
          text: "The current station direction contract says this candidate fits the pipeline.",
        },
        programWindow: radioWindow({ id: "unsafe-host-window" }),
      }) satisfies RadioAgentHandleResult,
    queueProgramWindow: async () => true,
    hostTextForDelivery: () => "The current station direction contract says this candidate fits the pipeline.",
  });

  const result = await service.handleUserText({
    uid: "42",
    sessionId: 7,
    text: "play quiet jazz",
    currentTrack: null,
    readyQueue: [],
    shouldClearQueue: true,
  });

  assert.equal(result.programQueued, true);
  assert.equal(result.hostText, "");
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

test("service rejects an unsafe ready item through playback governor before promotion", async () => {
  const contract = serviceContract({ rawUserText: "play rnb", stationBrief: "late-night R&B." });
  const readyTrack = { id: "classical-live", name: "Piano Quintet No. 2 in C Minor", artist: "Classical Ensemble" };
  const governorCalls: string[] = [];
  const service = new RadioAgentService({
    activeContractStore: {
      get: () => contract,
      set: () => undefined,
    },
    playbackGovernor: {
      evaluate: async (args) => {
        governorCalls.push(`${args.contract?.id}:${args.candidate.id}`);
        return {
          status: "rejected",
          reason: "reject_off_contract",
          trace: {
            status: "rejected",
            contractId: args.contract?.id || null,
            requestToken: args.requestToken,
            candidateKey: "classicalensemble::pianoquintetno2incminor",
            decision: "reject_off_contract",
            evidence: ["candidate is classical, not R&B"],
          },
        };
      },
    },
    chooseOpeningTrack: () => null,
    prepareTrack: async () => null,
  });

  const result = await service.handleTrackEnded({
    uid: "42",
    sessionId: 7,
    previousEvent: "played",
    currentTrack: { id: "current", name: "Good Days", artist: "SZA" },
    readyQueue: [readyTrack],
  });

  assert.deepEqual(governorCalls, ["contract-test:classical-live"]);
  assert.equal(result.action, "legacy_fallback");
  assert.equal(result.fallbackReason, "reject_off_contract");
  assert.ok(!result.actions.some((action) => action.type === "fallback" && action.reason === "ready_queue_available"));
  const notFound = result.actions.find((action) => action.type === "honest_not_found");
  assert.equal(notFound?.type, "honest_not_found");
  if (notFound?.type !== "honest_not_found") throw new Error("expected honest_not_found action");
  assert.equal(notFound.governanceTrace?.decision, "reject_off_contract");
});

test("queue-low continuation uses active contract and governor before gateway promotion", async () => {
  const contract = serviceContract({ rawUserText: "play quiet jazz for reading", stationBrief: "quiet jazz for reading." });
  const preparedTrack = prepared(
    { id: "miles-blue", name: "Blue in Green", artist: "Miles Davis" },
    { type: "radio_agent_program", text: "Quiet jazz continuation." },
  );
  const programWindow = radioWindow({
    id: "window-governed-continuation",
    stationBrief: "Quiet jazz for reading.",
    mainDirection: "quiet jazz for reading",
    candidateTasks: [{ query: "Miles Davis Blue in Green", reason: "Quiet jazz continuation.", style: "jazz", negativeConstraints: [] }],
  });
  const calls: string[] = [];
  const service = new RadioAgentService({
    activeContractStore: {
      get: (uid, sessionId) => {
        calls.push(`contract:${uid}:${sessionId}`);
        return contract;
      },
      set: () => undefined,
    },
    playbackGovernor: {
      evaluate: async (args) => {
        calls.push(`govern:${args.contract?.id}:${args.candidate.id}`);
        return {
          status: "accepted",
          track: args.candidate,
          url: args.url,
          trace: {
            status: "accepted",
            contractId: args.contract?.id || null,
            requestToken: args.requestToken,
            candidateKey: "milesdavis::blueingreen",
            decision: "direct_positive",
            evidence: ["candidate metadata matches positive anchor: jazz"],
          },
        };
      },
    },
    chooseOpeningTrack: () => null,
    prepareTrack: async () => null,
    handleRadioAgentEvent: async (event) => {
      calls.push(`agent:${event.type}`);
      return {
        controlsPlayback: false,
        event: { uid: "42", sessionId: 7, type: "queue_low", priority: "warm", payload: {}, createdAt: "2026-06-16T00:00:00.000Z" },
        hostDecision: { shouldSpeak: false, event: "silent", reason: "ordinary continuation" },
        programWindow,
      } satisfies RadioAgentHandleResult;
    },
    prepareProgramWindow: async () => {
      calls.push("prepare");
      return preparedTrack;
    },
  });

  const result = await service.handleTrackEnded({
    uid: "42",
    sessionId: 7,
    previousEvent: "played",
    currentTrack: { id: "current", name: "Peace Piece", artist: "Bill Evans" },
    readyQueue: [],
  });

  assert.deepEqual(calls, [
    "agent:queue_low",
    "prepare",
    "contract:42:7",
    "govern:contract-test:miles-blue",
  ]);
  const play = result.actions.find((action) => action.type === "play_now");
  assert.equal(play?.type, "play_now");
  if (play?.type !== "play_now") throw new Error("expected governed play_now action");
  assert.equal(play.track.id, "miles-blue");
  assert.equal(play.governanceTrace?.decision, "direct_positive");
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

test("service track-end continuation times out instead of blocking playback recovery", async () => {
  const calls: string[] = [];
  const service = new RadioAgentService({
    chooseOpeningTrack: () => null,
    prepareTrack: async () => null,
    handleRadioAgentEvent: async () => {
      calls.push("agent");
      return await new Promise<RadioAgentHandleResult>(() => undefined);
    },
    queueProgramWindow: async () => {
      calls.push("queue");
      return true;
    },
    trackEndTimeoutMs: 1,
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
  assert.equal(result.fallbackReason, "radio_agent_track_end_timeout");
  assert.deepEqual(calls, ["agent"]);
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

function serviceContract(overrides: Partial<AgentSessionContract> = {}): AgentSessionContract {
  return {
    id: "contract-test",
    uid: "42",
    sessionId: 7,
    rawUserText: "play quiet jazz",
    stationBrief: "quiet jazz.",
    positiveAnchors: ["jazz", "R&B"],
    disallowed: ["high energy EDM"],
    allowedAdjacent: ["soul"],
    bridgeBudget: 1,
    returnRequirement: "Return to the requested direction.",
    sourceEventId: "event-test",
    status: "active",
    createdAt: "2026-06-16T00:00:00.000Z",
    updatedAt: "2026-06-16T00:00:00.000Z",
    ...overrides,
  };
}
