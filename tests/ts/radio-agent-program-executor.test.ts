import assert from "node:assert/strict";
import test from "node:test";

import { RadioAgentProgramExecutor } from "../../src/radio-agent/programExecutor.js";
import type { RadioAgentProgramWindow } from "../../src/radio-agent/types.js";
import type { MusicTask, SearchVerification } from "../../src/types.js";

const internalTerms =
  /candidate|trace|verification|model|JSON|prompt|tool call|deterministic|radio memory|current (?:station )?contract|station contract|model-selected|model selected|listener has|library evidence|playlist titles repeatedly/i;

function programWindow(overrides: Partial<RadioAgentProgramWindow> = {}): RadioAgentProgramWindow {
  return {
    id: "window-1",
    uid: "42",
    sessionId: 9,
    stationBrief: "Keep late-night R&B coherent.",
    mainDirection: "late-night R&B",
    allowedAdjacent: ["alt-R&B"],
    bridgeBudget: 1,
    disallowed: ["classical chamber music", "high-energy EDM"],
    returnRequirement: "Return to vocal R&B.",
    candidateTasks: [
      {
        query: "SZA Good Days",
        reason: "Known taste anchor.",
        style: "R&B",
        negativeConstraints: ["classical chamber music"],
      },
    ],
    hostIntent: {
      shouldSpeak: true,
      event: "return_to_contract",
      reason: "set station lane",
      text: "Keeping this close to your late-night R&B lane.",
    },
    traceBasis: {
      profile: "SZA",
      now: "local_time_block: late_night",
      contract: "late-night R&B",
      eventType: "queue_low",
    },
    source: "model",
    createdAt: "2026-06-03T01:02:03.000Z",
    ...overrides,
  };
}

test("program executor verifies the first candidate through search tools", async () => {
  const window = programWindow();
  const verifier = {
    verify: async (task: MusicTask, uid?: string | null, stationBrief?: string): Promise<SearchVerification> => {
      assert.equal(task.searchGoals[0], "SZA Good Days");
      assert.equal(task.mustNotSearchLiteralUserSentence, true);
      assert.equal(uid, "42");
      assert.match(stationBrief ?? "", /Keep late-night R&B coherent/);
      assert.ok(task.negativeConstraints.includes("classical chamber music"));
      assert.ok(task.negativeConstraints.includes("high-energy EDM"));
      assert.equal(
        task.negativeConstraints.filter((constraint) => constraint === "classical chamber music").length,
        1,
      );

      return {
        status: "verified",
        selectedSong: { id: "s1", name: "Good Days", artist: "SZA" },
        url: "/api/radio/audio/s1",
        verification: { confidence: 0.8, versionNote: "matched" },
        fallbackCandidates: [],
        recoveryOptions: [],
        usedQuery: "SZA Good Days",
      };
    },
  };

  const executor = new RadioAgentProgramExecutor(verifier as any, () => "trace-1");
  const prepared = await executor.prepareFirstPlayable(window);

  assert.equal(prepared?.track.id, "s1");
  assert.equal(prepared?.track.name, "Good Days");
  assert.equal(prepared?.track.artist, "SZA");
  assert.equal(prepared?.url, "/api/radio/audio/s1");
  assert.equal(prepared?.selectionReason.type, "radio_agent_program");
  assert.equal(prepared?.selectionReason.traceId, "trace-1");
  assert.equal(prepared?.selectionReason.text, "Known taste anchor.");
  assert.equal(prepared?.segueText, "Keeping this close to your late-night R&B lane.");
  assert.equal(prepared?.decisionTrace.id, "trace-1");
  assert.equal(prepared?.decisionTrace.episodeId, window.id);
  assert.equal(prepared?.decisionTrace.selectedTrack.id, "s1");
  assert.equal(prepared?.decisionTrace.selectedTrack.name, "Good Days");
  assert.equal(prepared?.decisionTrace.selectedTrack.artist, "SZA");
  assert.doesNotMatch(prepared?.decisionTrace.reason ?? "", internalTerms);
});

test("program executor returns null when no candidate verifies", async () => {
  const verifier = {
    verify: async (): Promise<SearchVerification> => ({
      status: "not_found",
      verification: {},
      fallbackCandidates: [],
      recoveryOptions: [],
      failureReason: "none",
    }),
  };

  const executor = new RadioAgentProgramExecutor(verifier as any, () => "trace-2");
  const prepared = await executor.prepareFirstPlayable(programWindow());

  assert.equal(prepared, null);
});

test("program executor leaves segue text empty when host intent should not speak", async () => {
  const verifier = {
    verify: async (): Promise<SearchVerification> => ({
      status: "verified",
      selectedSong: { id: "s1", name: "Good Days", artist: "SZA" },
      url: "/api/radio/audio/s1",
      verification: { confidence: 0.8, versionNote: "matched" },
      fallbackCandidates: [],
      recoveryOptions: [],
      usedQuery: "SZA Good Days",
    }),
  };
  const executor = new RadioAgentProgramExecutor(verifier as any, () => "trace-3");

  const prepared = await executor.prepareFirstPlayable(
    programWindow({
      hostIntent: {
        shouldSpeak: false,
        event: "silent",
        reason: "ordinary continuation",
        text: "Keeping this close to your late-night R&B lane.",
      },
    }),
  );

  assert.equal(prepared?.segueText, "");
  assert.equal(prepared?.decisionTrace.hostText, "");
});

test("program executor does not expose diagnostic fallback wording in listener-facing reasons", async () => {
  const verifier = {
    verify: async (): Promise<SearchVerification> => ({
      status: "verified",
      selectedSong: { id: "s3", name: "Breakaway", artist: "Martin Garrix" },
      url: "/api/radio/audio/s3",
      verification: { confidence: 0.8, versionNote: "matched" },
      fallbackCandidates: [],
      recoveryOptions: [],
      usedQuery: "Martin Garrix",
    }),
  };
  const executor = new RadioAgentProgramExecutor(verifier as any, () => "trace-diagnostic");

  const prepared = await executor.prepareFirstPlayable(
    programWindow({
      stationBrief: "Listener has repeated library evidence for Anyma. Listener has repeated library evidence for Innellea.",
      mainDirection: "Continue from Anyma while respecting the current station contract.",
      candidateTasks: [
        {
          query: "Martin Garrix",
          reason: "Deterministic anchor from radio memory or current contract.",
          style: "melodic electronic",
          negativeConstraints: [],
        },
      ],
    }),
  );

  assert.doesNotMatch(prepared?.selectionReason.text ?? "", internalTerms);
  assert.doesNotMatch(prepared?.decisionTrace.reason ?? "", internalTerms);
});

test("program executor tries later candidates until the first playable track verifies", async () => {
  const calls: string[] = [];
  const verifier = {
    verify: async (task: MusicTask): Promise<SearchVerification> => {
      calls.push(task.searchGoals[0] ?? "");
      if (task.searchGoals[0] === "Frank Ocean Pink + White") {
        return {
          status: "verified",
          selectedSong: { id: "s2", name: "Pink + White", artist: "Frank Ocean" },
          url: "/api/radio/audio/s2",
          verification: { confidence: 0.82, versionNote: "matched" },
          fallbackCandidates: [],
          recoveryOptions: [],
          usedQuery: "Frank Ocean Pink + White",
        };
      }
      return {
        status: "not_found",
        verification: {},
        fallbackCandidates: [],
        recoveryOptions: [],
        failureReason: "first candidate not playable",
      };
    },
  };
  const executor = new RadioAgentProgramExecutor(verifier as any, () => "trace-4");

  const prepared = await executor.prepareFirstPlayable(
    programWindow({
      candidateTasks: [
        {
          query: "SZA Good Days",
          reason: "Known taste anchor.",
          style: "R&B",
          negativeConstraints: [],
        },
        {
          query: "Frank Ocean Pink + White",
          reason: "Soft adjacent bridge.",
          style: "alt-R&B",
          negativeConstraints: [],
        },
      ],
    }),
  );

  assert.deepEqual(calls, ["SZA Good Days", "Frank Ocean Pink + White"]);
  assert.equal(prepared?.track.id, "s2");
  assert.equal(prepared?.selectionReason.fallbackLevel, "episode_backup");
  assert.deepEqual(prepared?.decisionTrace.rejectedCandidates, ["SZA Good Days"]);
  assert.deepEqual(prepared?.decisionTrace.verificationAttempts, ["SZA Good Days", "Frank Ocean Pink + White"]);
});

test("program executor treats scene and genre directions as non-specific music tasks", async () => {
  const received: Array<{ query: string; type: MusicTask["type"] }> = [];
  const verifier = {
    verify: async (task: MusicTask): Promise<SearchVerification> => {
      received.push({ query: task.searchGoals[0] ?? "", type: task.type });
      return {
        status: "not_found",
        verification: {},
        fallbackCandidates: [],
        recoveryOptions: [],
        failureReason: "classification sample",
      };
    },
  };
  const executor = new RadioAgentProgramExecutor(verifier as any, () => "trace-5");

  await executor.prepareFirstPlayable(
    programWindow({
      candidateTasks: [
        { query: "Late Night R&B", reason: "scene direction", style: "R&B", negativeConstraints: [] },
        { query: "Neo Soul", reason: "genre direction", style: "neo soul", negativeConstraints: [] },
        { query: "City Pop", reason: "genre direction", style: "city pop", negativeConstraints: [] },
        { query: "late-night R&B - mellow alt-R&B", reason: "style direction", style: "alt-R&B", negativeConstraints: [] },
        { query: "Study Focus - piano", reason: "utility-like direction", style: "piano", negativeConstraints: [] },
      ],
    }),
  );

  assert.deepEqual(
    received.map((item) => item.type),
    [
      "scene_genre_direction",
      "scene_genre_direction",
      "scene_genre_direction",
      "scene_genre_direction",
      "scene_genre_direction",
    ],
  );
});

test("program executor keeps typographic separator style directions non-specific", async () => {
  const received: Array<{ query: string; type: MusicTask["type"] }> = [];
  const verifier = {
    verify: async (task: MusicTask): Promise<SearchVerification> => {
      received.push({ query: task.searchGoals[0] ?? "", type: task.type });
      return {
        status: "not_found",
        verification: {},
        fallbackCandidates: [],
        recoveryOptions: [],
        failureReason: "classification sample",
      };
    },
  };
  const executor = new RadioAgentProgramExecutor(verifier as any, () => "trace-6");

  await executor.prepareFirstPlayable(
    programWindow({
      candidateTasks: [
        { query: "late-night R&B \u2013 mellow alt-R&B", reason: "style direction", style: "alt-R&B", negativeConstraints: [] },
        { query: "late-night R&B \u2014 mellow alt-R&B", reason: "style direction", style: "alt-R&B", negativeConstraints: [] },
        { query: "late-night R&B : mellow alt-R&B", reason: "style direction", style: "alt-R&B", negativeConstraints: [] },
      ],
    }),
  );

  assert.deepEqual(
    received.map((item) => item.type),
    ["scene_genre_direction", "scene_genre_direction", "scene_genre_direction"],
  );
});

test("program executor treats explicit artist-title shapes as specific tracks", async () => {
  const received: Array<{ query: string; type: MusicTask["type"] }> = [];
  const verifier = {
    verify: async (task: MusicTask): Promise<SearchVerification> => {
      received.push({ query: task.searchGoals[0] ?? "", type: task.type });
      return {
        status: "not_found",
        verification: {},
        fallbackCandidates: [],
        recoveryOptions: [],
        failureReason: "classification sample",
      };
    },
  };
  const executor = new RadioAgentProgramExecutor(verifier as any, () => "trace-6");

  await executor.prepareFirstPlayable(
    programWindow({
      candidateTasks: [
        { query: "Frank Ocean - Pink + White", reason: "specific song", style: "alt-R&B", negativeConstraints: [] },
        { query: "Pink + White by Frank Ocean", reason: "specific song", style: "alt-R&B", negativeConstraints: [] },
        { query: "Radiohead - Creep", reason: "specific song", style: "alt rock", negativeConstraints: [] },
        { query: "Piano Man by Billy Joel", reason: "specific song", style: "piano rock", negativeConstraints: [] },
        { query: "Sleep Token - The Summoning", reason: "specific song", style: "metal", negativeConstraints: [] },
      ],
    }),
  );

  assert.deepEqual(
    received.map((item) => item.type),
    ["specific_track", "specific_track", "specific_track", "specific_track", "specific_track"],
  );
});
