import assert from "node:assert/strict";
import test from "node:test";

import { PlaybackQueue } from "../../src/radio/playbackQueue.js";
import { QueueWarmer } from "../../src/radio/queueWarmer.js";
import type { DecisionTraceStore } from "../../src/radio/decisionTraceStore.js";
import type { RadioEpisode } from "../../src/radio/radioBrainTypes.js";
import type { MusicTask, SearchVerification } from "../../src/types.js";

const episode: RadioEpisode = {
  id: "episode-1",
  brief: "安静专注工作流",
  modeLabel: "focus",
  arc: "quiet to focused",
  durationTracks: 3,
  positiveConstraints: ["安静"],
  negativeConstraints: ["EDM"],
  items: [
    {
      primaryQuery: "bad query",
      backupQueries: ["Nils Frahm Says"],
      reason: "无人声但有推进感。",
      style: "instrumental",
      energy: "low-medium",
      vocality: "instrumental",
      fitToProfile: "钢琴锚点",
      fitToContext: "工作",
      avoidBecause: ["EDM"],
    },
  ],
  fallbackPolicy: "Use backups.",
  hostNotes: [],
  createdFrom: "correction",
  createdAt: "2026-06-01T00:00:00.000Z",
};

const episodeWithTwoItems: RadioEpisode = {
  ...episode,
  id: "episode-2",
  items: [
    ...episode.items,
    {
      primaryQuery: "Max Richter On the Nature of Daylight",
      backupQueries: [],
      reason: "弦乐保持安静但更开阔。",
      style: "modern classical",
      energy: "low",
      vocality: "instrumental",
      fitToProfile: "古典氛围",
      fitToContext: "专注",
      avoidBecause: ["EDM"],
    },
  ],
};

const singlePrimaryEpisode: RadioEpisode = {
  ...episode,
  id: "episode-primary",
  items: [
    {
      primaryQuery: "Nils Frahm Says",
      backupQueries: [],
      reason: "单曲可直接命中。",
      style: "instrumental",
      energy: "low-medium",
      vocality: "instrumental",
      fitToProfile: "钢琴锚点",
      fitToContext: "工作",
      avoidBecause: ["EDM"],
    },
  ],
};

const episodeWithThrowingItem: RadioEpisode = {
  ...episode,
  id: "episode-throws",
  items: [
    {
      primaryQuery: "throw query",
      backupQueries: [],
      reason: "这个候选会失败。",
      style: "instrumental",
      energy: "low",
      vocality: "instrumental",
      fitToProfile: "测试",
      fitToContext: "测试",
      avoidBecause: [],
    },
    {
      primaryQuery: "Max Richter On the Nature of Daylight",
      backupQueries: [],
      reason: "后续候选仍然可以补上。",
      style: "modern classical",
      energy: "low",
      vocality: "instrumental",
      fitToProfile: "古典氛围",
      fitToContext: "专注",
      avoidBecause: ["EDM"],
    },
  ],
};

class FakeVerifier {
  tasks: MusicTask[] = [];

  async verify(task: MusicTask): Promise<SearchVerification> {
    this.tasks.push(task);
    const query = task.searchGoals[0] || "";
    if (query === "Nils Frahm Says") {
      return {
        status: "verified",
        selectedSong: { id: "says", name: "Says", artist: "Nils Frahm" },
        url: "/api/radio/audio/says",
        verification: { versionNote: "verified backup" },
        fallbackCandidates: [],
        recoveryOptions: [],
        usedQuery: query,
      };
    }
    if (query === "Max Richter On the Nature of Daylight") {
      return {
        status: "verified",
        selectedSong: { id: "daylight", name: "On the Nature of Daylight", artist: "Max Richter" },
        url: "/api/radio/audio/daylight",
        verification: { versionNote: "verified primary" },
        fallbackCandidates: [],
        recoveryOptions: [],
        usedQuery: query,
      };
    }
    return {
      status: "not_found",
      verification: {},
      fallbackCandidates: [],
      recoveryOptions: [],
      diagnostics: { searchedQueries: [query] },
    };
  }
}

class RawTextSensitiveVerifier extends FakeVerifier {
  rawUserTexts: string[] = [];

  override async verify(
    task: MusicTask,
    _uid: string | null = null,
    rawUserText = "",
  ): Promise<SearchVerification> {
    this.rawUserTexts.push(rawUserText);
    const query = task.searchGoals[0] || "";
    if (rawUserText === query) {
      return {
        status: "not_found",
        verification: {},
        fallbackCandidates: [],
        recoveryOptions: [],
        diagnostics: { rejectedQueries: [query] },
      };
    }
    return super.verify(task);
  }
}

class SlowVerifier extends FakeVerifier {
  private releaseVerify: (() => void) | null = null;
  readonly firstVerificationStarted = new Promise<void>((resolve) => {
    this.releaseVerify = resolve;
  });

  override async verify(task: MusicTask): Promise<SearchVerification> {
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    this.releaseVerify?.();
    return super.verify(task);
  }
}

class ThrowingVerifier extends FakeVerifier {
  override async verify(task: MusicTask): Promise<SearchVerification> {
    this.tasks.push(task);
    if (task.searchGoals[0] === "throw query") {
      throw new Error("verifier failed");
    }
    return super.verify(task);
  }
}

class CurrentFlippingVerifier extends FakeVerifier {
  constructor(private readonly flipCurrent: () => void) {
    super();
  }

  override async verify(task: MusicTask): Promise<SearchVerification> {
    const result = await super.verify(task);
    if (result.status === "verified") {
      this.flipCurrent();
    }
    return result;
  }
}

class FakeTraceStore {
  traces: unknown[] = [];

  save(trace: unknown): void {
    this.traces.push(trace);
  }
}

const warmArgs = (queue: PlaybackQueue, episodeArg: RadioEpisode) => ({
  queue,
  episode: episodeArg,
  uid: "42",
  sessionId: 7,
  intentType: "correction" as const,
  profileQuality: { level: "usable" as const, score: 0.5, reasons: [] },
  environment: { scene: "夜晚", localTimeBlock: "night", summary: "夜晚" },
  targetReady: 1,
  contextPack: {
    userProfileDigest: "",
    sessionWorkingMemory: {},
    recentTurns: [],
    retrievedMemories: [],
    playbackContext: {},
    userSettings: {},
    hardConstraints: [],
  },
});

test("queue warmer verifies backups and writes a trace", async () => {
  const queue = new PlaybackQueue(2);
  const verifier = new FakeVerifier();
  const traceStore = new FakeTraceStore();
  const warmer = new QueueWarmer(verifier as any, traceStore as unknown as DecisionTraceStore);

  const added = await warmer.warm(warmArgs(queue, episode));

  assert.equal(added, 1);
  assert.equal(queue.readyItems()[0]?.track.name, "Says");
  assert.equal(queue.readyItems()[0]?.selectionReason.episodeId, "episode-1");
  assert.equal(traceStore.traces.length, 1);
  assert.equal(verifier.tasks[0]?.searchGoals[0], "bad query");
  assert.equal(verifier.tasks[1]?.searchGoals[0], "Nils Frahm Says");
});

test("queue warmer does not pass the planned query as raw user text", async () => {
  const queue = new PlaybackQueue(2);
  const verifier = new RawTextSensitiveVerifier();
  const traceStore = new FakeTraceStore();
  const warmer = new QueueWarmer(verifier as any, traceStore as unknown as DecisionTraceStore);

  const added = await warmer.warm(warmArgs(queue, singlePrimaryEpisode));

  assert.equal(added, 1);
  assert.equal(queue.readyItems()[0]?.track.name, "Says");
  assert.equal(verifier.rawUserTexts[0], "");
  assert.equal(verifier.tasks[0]?.searchGoals[0], "Nils Frahm Says");
});

test("concurrent warm calls for the same episode do not duplicate a single item", async () => {
  const queue = new PlaybackQueue(2);
  const verifier = new SlowVerifier();
  const traceStore = new FakeTraceStore();
  const warmer = new QueueWarmer(verifier as any, traceStore as unknown as DecisionTraceStore);
  const args = warmArgs(queue, singlePrimaryEpisode);

  const firstWarm = warmer.warm(args);
  await verifier.firstVerificationStarted;
  const secondWarm = warmer.warm(args);
  const added = await Promise.all([firstWarm, secondWarm]);

  assert.deepEqual(added, [1, 0]);
  assert.equal(queue.readyItems().length, 1);
  assert.equal(queue.readyItems()[0]?.track.name, "Says");
  assert.equal(traceStore.traces.length, 1);
});

test("queue warmer treats verifier exceptions as failed attempts and continues", async () => {
  const queue = new PlaybackQueue(2);
  const verifier = new ThrowingVerifier();
  const traceStore = new FakeTraceStore();
  const warmer = new QueueWarmer(verifier as any, traceStore as unknown as DecisionTraceStore);

  const added = await warmer.warm(warmArgs(queue, episodeWithThrowingItem));

  assert.equal(added, 1);
  assert.equal(queue.readyItems()[0]?.track.name, "On the Nature of Daylight");
  assert.equal(verifier.tasks[0]?.searchGoals[0], "throw query");
  assert.equal(verifier.tasks[1]?.searchGoals[0], "Max Richter On the Nature of Daylight");
});

test("queue warmer does not save a trace or queue a track after becoming stale", async () => {
  const queue = new PlaybackQueue(2);
  let current = true;
  const verifier = new CurrentFlippingVerifier(() => {
    current = false;
  });
  const traceStore = new FakeTraceStore();
  const warmer = new QueueWarmer(verifier as any, traceStore as unknown as DecisionTraceStore);

  const added = await warmer.warm({
    ...warmArgs(queue, singlePrimaryEpisode),
    isCurrent: () => current,
  });

  assert.equal(added, 0);
  assert.equal(queue.readyDepth(), 0);
  assert.equal(traceStore.traces.length, 0);
  assert.equal(verifier.tasks.length, 1);
});

test("queue warmer does not exceed targetReady when queue already has ready items", async () => {
  const queue = new PlaybackQueue(2);
  queue.addReady(
    { id: "existing", name: "Existing Track", artist: "Existing Artist" },
    "/api/radio/audio/existing",
    { type: "manual", text: "already ready" },
  );
  const verifier = new FakeVerifier();
  const traceStore = new FakeTraceStore();
  const warmer = new QueueWarmer(verifier as any, traceStore as unknown as DecisionTraceStore);

  const added = await warmer.warm(warmArgs(queue, episode));

  assert.equal(added, 0);
  assert.equal(queue.readyItems().length, 1);
  assert.equal(queue.readyItems()[0]?.track.name, "Existing Track");
  assert.equal(verifier.tasks.length, 0);
  assert.equal(traceStore.traces.length, 0);
});

test("queue warmer advances the episode cursor across repeated warm calls", async () => {
  const queue = new PlaybackQueue(2);
  const verifier = new FakeVerifier();
  const traceStore = new FakeTraceStore();
  const warmer = new QueueWarmer(verifier as any, traceStore as unknown as DecisionTraceStore);

  const firstAdded = await warmer.warm(warmArgs(queue, episodeWithTwoItems));
  const first = queue.promoteNext();
  assert.equal(firstAdded, 1);
  assert.equal(first?.track.name, "Says");

  const secondAdded = await warmer.warm(warmArgs(queue, episodeWithTwoItems));

  assert.equal(secondAdded, 1);
  assert.equal(queue.readyItems().length, 1);
  assert.equal(queue.readyItems()[0]?.track.name, "On the Nature of Daylight");
});

test("removeReadyWhere removes only ready items", () => {
  const queue = new PlaybackQueue(3);
  queue.addReady({ id: "played-target", name: "Played Target", artist: "A" }, "/played-target", { type: "test", text: "" });
  queue.addReady({ id: "playing-target", name: "Playing Target", artist: "B" }, "/playing-target", { type: "test", text: "" });
  queue.promoteNext();
  queue.addReady({ id: "ready-keep", name: "Ready Keep", artist: "C" }, "/ready-keep", { type: "test", text: "" });
  queue.markCurrent("played");
  queue.promoteNext();
  queue.addReady({ id: "ready-target", name: "Ready Target", artist: "D" }, "/ready-target", { type: "test", text: "" });

  const removed = queue.removeReadyWhere((item) => item.track.id.endsWith("target"));

  assert.equal(removed, 1);
  assert.deepEqual(
    queue.items.map((item) => [item.track.id, item.status]),
    [
      ["played-target", "played"],
      ["playing-target", "playing"],
      ["ready-keep", "ready"],
    ],
  );
});
