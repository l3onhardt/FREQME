import assert from "node:assert/strict";
import test from "node:test";

import { PlaybackQueue } from "../../src/radio/playbackQueue.js";
import {
  findNewBrainReadyItem,
  isCurrentRequestToken,
  prepareFreshBrainReadyOrReplaceWithFallback,
  prepareFreshBrainReadyForPromotion,
  removeReadyItemsBefore,
  snapshotReadyItems,
} from "../../src/radio/requestReadySelector.js";
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
