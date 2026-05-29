import assert from "node:assert/strict";
import test from "node:test";

import { QueueDirector } from "../../src/radio/queueDirector.js";
import { PlaybackQueue } from "../../src/radio/playbackQueue.js";
import type { DJDecision, MemoryPack, MusicTask, Track } from "../../src/types.js";

const task: MusicTask = {
  type: "scene_genre_direction",
  primaryEntities: [
    { role: "scene", name: "late night" },
    { role: "genre", name: "R&B" },
  ],
  workHint: "",
  styleHint: "late-night R&B",
  negativeConstraints: ["avoid loud club tracks"],
  searchGoals: ["Daniel Caesar Japanese Denim", "SZA Broken Clocks"],
  mustNotSearchLiteralUserSentence: true,
};

const decision: DJDecision = {
  action: "set_direction_and_play",
  understoodIntent: "listener wants a personalized late-night R&B direction",
  musicTask: task,
  queuePolicy: { durationTracks: 4, continueDirection: true, avoidRepetition: true },
  uncertainty: { level: "low", reason: "", shouldAskUser: false },
  djResponse: { speakNow: "我往深夜一点的 R&B 接。", tone: "warm_confident" },
  memoryUpdate: {
    sessionPreference: ["late-night R&B"],
    possibleLongTermPreference: [],
    negativeConstraints: [],
  },
  rawText: "放点深夜听的rnb",
};

class FakeMemoryManager {
  sourcePlaybackContext?: Record<string, unknown>;

  readonly contextPack: MemoryPack = {
    userProfileDigest: "prefers Frank Ocean, SZA, Daniel Caesar, intimate late-night vocals",
    sessionWorkingMemory: { activeMode: { label: "quiet night radio" } },
    recentTurns: [{ user: "不要太炸" }],
    retrievedMemories: [{ memoryText: "likes warm R&B textures" }],
    playbackContext: { currentTrack: { name: "Nights", artist: "Frank Ocean" } },
    userSettings: { musicNotes: "avoid noisy club tracks", localTimeBlock: "late_night" },
    hardConstraints: ["Do not search the literal listener sentence."],
  };
  playbackEvents: Array<{ eventType: string; options: Record<string, unknown> }> = [];

  buildContextPack(args?: { playbackContext?: Record<string, unknown> }): MemoryPack {
    this.sourcePlaybackContext = args?.playbackContext;
    if (this.sourcePlaybackContext) this.contextPack.playbackContext = this.sourcePlaybackContext;
    return this.contextPack;
  }

  applyDecisionUpdate(): void {}

  logPlaybackEvent(eventType: string, options: Record<string, unknown>): void {
    this.playbackEvents.push({ eventType, options });
  }
}

class FakeDjAgent {
  async decide(): Promise<DJDecision> {
    return decision;
  }
}

class CapturingVerifier {
  receivedContext?: MemoryPack;

  async verify(
    musicTask: MusicTask,
    uid: string | null,
    rawUserText: string,
    contextPack?: MemoryPack,
  ): Promise<Record<string, unknown>> {
    this.receivedContext = contextPack;
    assert.equal(musicTask.styleHint, "late-night R&B");
    assert.equal(uid, "42");
    assert.equal(rawUserText, "放点深夜听的rnb");
    const selectedSong: Track = { id: "song-1", name: "Japanese Denim", artist: "Daniel Caesar" };
    return {
      status: "verified",
      selectedSong,
      url: "/api/radio/audio/song-1",
      verification: { versionNote: "personalized late-night R&B fit" },
      fallbackCandidates: [],
      recoveryOptions: [],
      usedQuery: "Daniel Caesar Japanese Denim",
    };
  }
}

test("queue director passes private DJ memory context into search verification", async () => {
  const memory = new FakeMemoryManager();
  const verifier = new CapturingVerifier();
  const director = new QueueDirector(new FakeDjAgent() as any, verifier as any, memory as any);
  const queue = new PlaybackQueue();

  const result = await director.handleSongRequest({
    requestText: decision.rawText,
    playbackQueue: queue,
    uid: "42",
    sessionId: 7,
    profile: null,
    userSettings: {},
    playbackContext: {},
    recentTurns: [],
  });

  assert.equal(result.status, "queued");
  assert.equal(result.nextSong?.name, "Japanese Denim");
  assert.equal(verifier.receivedContext, memory.contextPack);
  assert.equal(queue.readyItems()[0]?.selectionReason.understoodIntent, decision.understoodIntent);
});

test("queue director passes ready queue memory before replacing queued tracks", async () => {
  const memory = new FakeMemoryManager();
  const verifier = new CapturingVerifier();
  const director = new QueueDirector(new FakeDjAgent() as any, verifier as any, memory as any);
  const queue = new PlaybackQueue();
  const requestText = decision.rawText;
  queue.addReady(
    { id: "snooze", name: "Snooze", artist: "SZA" },
    "/api/radio/audio/snooze",
    { type: "scheduler", text: "previous ready track" },
  );

  const result = await director.handleSongRequest({
    requestText,
    playbackQueue: queue,
    uid: "42",
    sessionId: 7,
    profile: null,
    userSettings: {},
    playbackContext: {
      currentTrack: { id: "nights", name: "Nights", artist: "Frank Ocean" },
      recentTracks: [],
      readyQueue: queue.readyItems().map((item) => item.track),
      scene: "late night",
    },
    recentTurns: [],
  });

  assert.equal(result.status, "queued");
  assert.deepEqual(verifier.receivedContext?.playbackContext.readyQueue, [
    { id: "snooze", name: "Snooze", artist: "SZA", selectionReason: { type: "scheduler", text: "previous ready track" } },
  ]);
  assert.equal(queue.readyItems().length, 1);
  assert.equal(queue.readyItems()[0]?.track.name, "Japanese Denim");
});

test("queue director records verification diagnostics when a playable direction cannot be queued", async () => {
  const memory = new FakeMemoryManager();
  const verifier = {
    async verify(): Promise<Record<string, unknown>> {
      return {
        status: "not_found",
        verification: {},
        fallbackCandidates: [],
        recoveryOptions: [],
        failureReason: "Search planner did not produce concrete song queries.",
        usedQuery: "",
        diagnostics: {
          searchedQueries: [],
          rejectedQueries: ["R&B 电子融合", "舞曲 R&B", "Electronic R&B"],
          candidateIds: [],
          attemptedSongIds: [],
        },
      };
    },
  };
  const director = new QueueDirector(new FakeDjAgent() as any, verifier as any, memory as any);

  const result = await director.handleSongRequest({
    requestText: "我要听5电的rnb",
    playbackQueue: new PlaybackQueue(),
    uid: "42",
    sessionId: 7,
    profile: null,
    userSettings: {},
    playbackContext: {},
    recentTurns: [],
  });

  assert.equal(result.status, "needs_recovery");
  assert.equal(memory.playbackEvents[0]?.eventType, "song_request_not_found");
  const payload = memory.playbackEvents[0]?.options.payload as Record<string, unknown>;
  assert.equal(((payload.decision as Record<string, unknown>).musicTask as MusicTask).type, "scene_genre_direction");
  delete payload.decision;
  assert.deepEqual(payload, {
    requestText: "我要听5电的rnb",
    failureReason: "Search planner did not produce concrete song queries.",
    usedQuery: "",
    diagnostics: {
      searchedQueries: [],
      rejectedQueries: ["R&B 电子融合", "舞曲 R&B", "Electronic R&B"],
      candidateIds: [],
      attemptedSongIds: [],
    },
  });
});
