import assert from "node:assert/strict";
import test from "node:test";

import { PlaybackQueue } from "../../src/radio/playbackQueue.js";
import {
  findNewBrainReadyItem,
  isCurrentRequestToken,
  prepareFreshBrainReadyOrReplaceWithFallback,
  prepareFreshBrainReadyForPromotion,
  removeReadyItemsMatchingRecentPlayback,
  removeReadyItemsOutsideStationContract,
  removeReadyItemsBefore,
  snapshotReadyItems,
} from "../../src/radio/requestReadySelector.js";
import { BoundaryGuard } from "../../src/radio/boundaryGuard.js";
import type { StationContract } from "../../src/radio/radioBrainTypes.js";
import type { SelectionReason, Track } from "../../src/types.js";

function track(id: string): Track {
  return { id, name: id, artist: "Artist" };
}

function reason(overrides: Partial<SelectionReason> = {}): SelectionReason {
  return {
    type: "ai_station_director",
    text: "old plan",
    ...overrides,
  };
}

test("request ready selector ignores stale ready items and promotes the new brain item", () => {
  const queue = new PlaybackQueue(3);
  queue.addReady(track("old-a"), "old-a-url", reason());
  queue.addReady(track("old-b"), "old-b-url", reason());
  const beforeRequest = snapshotReadyItems(queue);

  queue.addReady(track("new-brain"), "new-url", reason({
    type: "ai_radio_episode",
    text: "fresh request plan",
    episodeId: "episode-1",
    traceId: "trace-1",
  }));

  const selected = findNewBrainReadyItem(queue, beforeRequest);

  assert.equal(selected?.track.id, "new-brain");
  removeReadyItemsBefore(queue, selected);

  const promoted = queue.promoteNext("played");
  assert.equal(promoted?.track.id, "new-brain");
});

test("request ready selector does not treat surviving old brain items as fresh", () => {
  const queue = new PlaybackQueue(3);
  queue.addReady(track("old-brain"), "old-url", reason({
    type: "ai_radio_episode",
    text: "previous episode",
    episodeId: "old-episode",
    traceId: "old-trace",
  }));
  const beforeRequest = snapshotReadyItems(queue);

  assert.equal(findNewBrainReadyItem(queue, beforeRequest), null);
});

test("request token guard rejects superseded wait loops", () => {
  assert.equal(isCurrentRequestToken(3, 3), true);
  assert.equal(isCurrentRequestToken(2, 3), false);
  assert.equal(isCurrentRequestToken(null, 3), false);
});

test("fresh brain ready preparation rechecks before fallback can clear the queue", () => {
  const queue = new PlaybackQueue(3);
  queue.addReady(track("stale"), "stale-url", reason());
  const beforeRequest = snapshotReadyItems(queue);

  queue.addReady(track("fresh-after-timeout"), "fresh-url", reason({
    type: "ai_radio_episode",
    text: "arrived just after timeout",
    traceId: "trace-after-timeout",
  }));

  const selected = prepareFreshBrainReadyForPromotion(queue, beforeRequest);

  assert.equal(selected?.track.id, "fresh-after-timeout");
  assert.deepEqual(queue.readyItems().map((item) => item.track.id), ["fresh-after-timeout"]);
});

test("sync fallback replacement preserves a fresh brain item that arrives right before clear", () => {
  const queue = new PlaybackQueue(3);
  queue.addReady(track("stale"), "stale-url", reason());
  const beforeRequest = snapshotReadyItems(queue);
  queue.addReady(track("fresh-before-clear"), "fresh-url", reason({
    type: "ai_radio_episode",
    text: "fresh before clear",
    episodeId: "episode-before-clear",
  }));

  const result = prepareFreshBrainReadyOrReplaceWithFallback(queue, beforeRequest, {
    track: track("fallback"),
    url: "fallback-url",
    selectionReason: reason({ text: "fallback" }),
  });

  assert.equal(result.source, "brain");
  assert.equal(result.item.track.id, "fresh-before-clear");
  assert.deepEqual(queue.readyItems().map((item) => item.track.id), ["fresh-before-clear"]);
});

test("sync fallback replacement clears stale items and queues fallback when no fresh brain item exists", () => {
  const queue = new PlaybackQueue(3);
  queue.addReady(track("stale"), "stale-url", reason());
  const beforeRequest = snapshotReadyItems(queue);

  const result = prepareFreshBrainReadyOrReplaceWithFallback(queue, beforeRequest, {
    track: track("fallback"),
    url: "fallback-url",
    selectionReason: reason({ text: "fallback" }),
  });

  assert.equal(result.source, "fallback");
  assert.equal(result.item.track.id, "fallback");
  assert.deepEqual(queue.readyItems().map((item) => item.track.id), ["fallback"]);
});

test("contract filter removes stale ready items before promotion while keeping matching agent items", () => {
  const queue = new PlaybackQueue(3);
  const contract: StationContract = {
    id: "quiet-jazz",
    mainDirection: "quiet jazz for reading",
    rawUserText: "play quiet jazz for reading",
    allowedAdjacent: ["soft jazz piano"],
    softBridge: [],
    disallowed: ["electronic remixes", "dance tracks"],
    positiveSeeds: ["quiet jazz for reading"],
    negativeConstraints: ["electronic remixes", "dance tracks"],
    driftBudget: 1,
    bridgeCount: 0,
    mustReturnToContract: false,
    hostStyle: "standard",
    createdAt: "2026-06-11T00:00:00.000Z",
    updatedAt: "2026-06-11T00:00:00.000Z",
  };
  queue.addReady(
    { id: "radiohead", name: "How to Disappear Completely", artist: "Radiohead" },
    "radiohead-url",
    reason({ type: "ai_station_director", text: "old continuation" }),
  );
  queue.addReady(
    { id: "jazz", name: "Magical Piano", artist: "Jazz Piano Bar Academy" },
    "jazz-url",
    reason({ type: "radio_agent_program", text: "quiet jazz continuation" }),
  );

  const removed = removeReadyItemsOutsideStationContract(queue, contract, new BoundaryGuard());

  assert.equal(removed, 1);
  assert.deepEqual(queue.readyItems().map((item) => item.track.id), ["jazz"]);
});

test("contract filter removes off-contract tracks even when stale reasons mention the active direction", () => {
  const queue = new PlaybackQueue(3);
  const contract: StationContract = {
    id: "quiet-jazz",
    mainDirection: "quiet jazz for reading",
    rawUserText: "play quiet jazz for reading",
    allowedAdjacent: ["soft jazz piano"],
    softBridge: [],
    disallowed: ["electronic remixes", "dance tracks"],
    positiveSeeds: ["quiet jazz for reading"],
    negativeConstraints: ["electronic remixes", "dance tracks"],
    driftBudget: 1,
    bridgeCount: 0,
    mustReturnToContract: false,
    hostStyle: "standard",
    createdAt: "2026-06-11T00:00:00.000Z",
    updatedAt: "2026-06-11T00:00:00.000Z",
  };
  queue.addReady(
    { id: "frank", name: "Frank Ocean - White Ferrari (MyClosest remake)", artist: "MyClosest" },
    "frank-url",
    reason({ type: "ai_radio_episode", text: "quiet jazz continuation", traceId: "old-trace" }),
  );
  queue.addReady(
    { id: "bohmer", name: "Beyond Beliefs (Cold Blue Rework)", artist: "Ben Bohmer" },
    "bohmer-url",
    reason({ type: "ai_radio_episode", text: "quiet jazz continuation", traceId: "old-trace-2" }),
  );
  queue.addReady(
    { id: "jazz", name: "Magical Piano", artist: "Jazz Piano Bar Academy" },
    "jazz-url",
    reason({ type: "radio_agent_program", text: "quiet jazz continuation" }),
  );

  const removed = removeReadyItemsOutsideStationContract(queue, contract, new BoundaryGuard());

  assert.equal(removed, 2);
  assert.deepEqual(queue.readyItems().map((item) => item.track.id), ["jazz"]);
});

test("recent playback filter removes ready items matching the current track before promotion", () => {
  const queue = new PlaybackQueue(3);
  const currentTrack = { id: "current", name: "Japanese Denim", artist: "Daniel Caesar" };
  queue.addReady(
    { id: "current", name: "Japanese Denim", artist: "Daniel Caesar" },
    "current-url",
    reason({ type: "radio_agent_program", text: "rnb continuation" }),
  );
  queue.addReady(
    { id: "next", name: "Broken Clocks", artist: "SZA" },
    "next-url",
    reason({ type: "radio_agent_program", text: "rnb continuation" }),
  );

  const removed = removeReadyItemsMatchingRecentPlayback(queue, currentTrack, []);

  assert.equal(removed, 1);
  assert.deepEqual(queue.readyItems().map((item) => item.track.id), ["next"]);
});

test("recent playback filter removes ready items matching recent artist and title", () => {
  const queue = new PlaybackQueue(3);
  queue.addReady(
    { id: "sza-ready", name: "Broken Clocks", artist: "SZA" },
    "sza-url",
    reason({ type: "radio_agent_program", text: "rnb continuation" }),
  );
  queue.addReady(
    { id: "usher", name: "Climax", artist: "Usher" },
    "usher-url",
    reason({ type: "radio_agent_program", text: "rnb continuation" }),
  );

  const removed = removeReadyItemsMatchingRecentPlayback(queue, null, [
    { id: "sza-recent", name: "Broken Clocks", artist: "SZA" },
  ]);

  assert.equal(removed, 1);
  assert.deepEqual(queue.readyItems().map((item) => item.track.id), ["usher"]);
});

test("recent playback filter removes remix or remake metadata matching a recent recording", () => {
  const queue = new PlaybackQueue(3);
  queue.addReady(
    { id: "pink-remix", name: "frank ocean - pinkpuss (pink + white remix)", artist: "LegoG" },
    "pink-remix-url",
    reason({ type: "radio_agent_program", text: "rnb continuation" }),
  );
  queue.addReady(
    { id: "miguel", name: "Adorn", artist: "Miguel" },
    "miguel-url",
    reason({ type: "radio_agent_program", text: "rnb continuation" }),
  );

  const removed = removeReadyItemsMatchingRecentPlayback(queue, null, [
    { id: "pink-original", name: "Pink + White", artist: "Frank Ocean" },
  ]);

  assert.equal(removed, 1);
  assert.deepEqual(queue.readyItems().map((item) => item.track.id), ["miguel"]);
});
