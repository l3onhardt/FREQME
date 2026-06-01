import assert from "node:assert/strict";
import test from "node:test";

import { PlaybackQueue } from "../../src/radio/playbackQueue.js";
import {
  findNewBrainReadyItem,
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
