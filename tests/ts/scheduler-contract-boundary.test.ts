import assert from "node:assert/strict";
import test from "node:test";

import { BoundaryGuard } from "../../src/radio/boundaryGuard.js";
import { StreamScheduler } from "../../src/radio/scheduler.js";
import type { StationContract } from "../../src/radio/radioBrainTypes.js";
import type { Track } from "../../src/types.js";

const rnbContract: StationContract = {
  id: "contract-rnb",
  mainDirection: "late-night R&B",
  rawUserText: "听 R&B",
  allowedAdjacent: ["alt-R&B", "neo-soul"],
  softBridge: [],
  disallowed: ["classical", "electronic", "ambient", "piano"],
  positiveSeeds: ["R&B"],
  negativeConstraints: ["classical", "electronic", "ambient", "piano"],
  driftBudget: 1,
  bridgeCount: 0,
  mustReturnToContract: false,
  hostStyle: "standard",
  createdAt: "2026-06-03T01:02:03.000Z",
  updatedAt: "2026-06-03T01:02:03.000Z",
};

function track(id: string, name: string, artist: string): Track {
  return { id, name, artist };
}

function scheduler(overrides: {
  similarSongs?: Track[];
  recommendSongs?: Track[];
  personalFm?: Track[];
} = {}) {
  const netease = {
    similarSongs: async () => overrides.similarSongs || [],
    recommendSongs: async () => overrides.recommendSongs || [],
    personalFm: async () => overrides.personalFm || [],
  };
  const store = {
    getRecentTrackIds: () => [],
    wasTrackRecentlyFailed: () => false,
  };
  const audioResolver = {
    resolveWithCandidates: async (candidate: Track) => ({ ok: true, songId: candidate.id, proxyUrl: `/audio/${candidate.id}` }),
  };
  return new StreamScheduler(netease as any, store as any, audioResolver as any, new BoundaryGuard());
}

test("scheduler degraded fallback skips off-contract recommendations under an R&B station contract", async () => {
  const stream = scheduler({
    recommendSongs: [
      track("classical-1", "Piano Quintet No. 2 in C Minor", "Sviatoslav Richter"),
      track("electronic-1", "A Drifting Down", "Jon Hopkins"),
      track("rnb-1", "Get You", "Daniel Caesar"),
    ],
  });

  const picked = await stream.pickNext({
    currentSongId: null,
    profile: null,
    userSettings: {},
    sessionState: stream.newSessionState(),
    uid: "42",
    stationContract: rnbContract,
  });

  assert.equal(picked?.id, "rnb-1");
  assert.equal(picked?.selectionReason?.type, "daily_personal");
});

test("scheduler returns null instead of breaking an R&B contract with only off-contract fallback candidates", async () => {
  const stream = scheduler({
    recommendSongs: [track("classical-1", "Piano Quintet No. 2 in C Minor", "Sviatoslav Richter")],
    personalFm: [track("ambient-1", "A Drifting Down", "Jon Hopkins")],
  });

  const picked = await stream.pickNext({
    currentSongId: null,
    profile: null,
    userSettings: {},
    sessionState: stream.newSessionState(),
    uid: "42",
    stationContract: rnbContract,
  });

  assert.equal(picked, null);
});

test("scheduler active intent search is still bounded by the current R&B station contract", async () => {
  const sessionState = scheduler().newSessionState();
  sessionState.activeIntent = {
    label: "ambient piano",
    rawText: "keep going",
    expiresAfterTracks: 2,
    constraints: [],
    seedTask: {
      type: "scene_genre_direction",
      primaryEntities: [],
      workHint: "",
      styleHint: "ambient piano",
      negativeConstraints: [],
      searchGoals: ["ambient piano"],
      mustNotSearchLiteralUserSentence: true,
    },
  };
  const neteaseSearches: string[] = [];
  const streamWithSearch = new StreamScheduler(
    {
      similarSongs: async () => [],
      recommendSongs: async () => [],
      personalFm: async () => [track("rnb-1", "Get You", "Daniel Caesar")],
      search: async (query: string) => {
        neteaseSearches.push(query);
        return [track("ambient-1", "A Drifting Down", "Jon Hopkins")];
      },
    } as any,
    {
      getRecentTrackIds: () => [],
      wasTrackRecentlyFailed: () => false,
    } as any,
    {
      resolveWithCandidates: async (candidate: Track) => ({ ok: true, songId: candidate.id, proxyUrl: `/audio/${candidate.id}` }),
    } as any,
    new BoundaryGuard(),
  );

  const picked = await streamWithSearch.pickNext({
    currentSongId: null,
    profile: null,
    userSettings: {},
    sessionState,
    uid: "42",
    stationContract: rnbContract,
  });

  assert.deepEqual(neteaseSearches, ["ambient piano"]);
  assert.equal(picked?.id, "rnb-1");
});
