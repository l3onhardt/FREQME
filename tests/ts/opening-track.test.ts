import assert from "node:assert/strict";
import test from "node:test";

import { chooseOpeningTrack } from "../../src/radio-agent/openingTrack.js";

test("opening selector prefers recent playable tracks", () => {
  const result = chooseOpeningTrack({
    recentPlayableTracks: [{ id: "recent-1", name: "Recent", artist: "A" }],
    profileAnchorTracks: [{ id: "anchor-1", name: "Anchor", artist: "B" }],
    likedTracks: [],
    fallbackTracks: [],
    avoidTrackIds: new Set(),
  });

  assert.equal(result?.track.id, "recent-1");
  assert.equal(result?.reason.type, "radio_agent_opening_recent");
});

test("opening selector skips avoided tracks and falls back to anchors", () => {
  const result = chooseOpeningTrack({
    recentPlayableTracks: [{ id: "bad", name: "Bad", artist: "A" }],
    profileAnchorTracks: [{ id: "anchor-1", name: "Anchor", artist: "B" }],
    likedTracks: [],
    fallbackTracks: [],
    avoidTrackIds: new Set(["bad"]),
  });

  assert.equal(result?.track.id, "anchor-1");
  assert.equal(result?.reason.type, "radio_agent_opening_profile_anchor");
});

test("opening selector ignores blank names, empty ids, and duplicate candidates", () => {
  const result = chooseOpeningTrack({
    recentPlayableTracks: [
      { id: "", name: "No Id", artist: "A" },
      { id: "dup", name: "   ", artist: "A" },
    ],
    profileAnchorTracks: [{ id: "dup", name: "Anchor", artist: "B" }],
    likedTracks: [{ id: "liked-1", name: "Liked", artist: "C" }],
    fallbackTracks: [{ id: "fallback-1", name: "Fallback", artist: "D" }],
    avoidTrackIds: new Set(),
  });

  assert.equal(result?.track.id, "liked-1");
  assert.equal(result?.reason.type, "radio_agent_opening_liked");
});

test("opening selector returns null when no candidate is usable", () => {
  const result = chooseOpeningTrack({
    recentPlayableTracks: [{ id: "bad", name: "Bad", artist: "A" }],
    profileAnchorTracks: [],
    likedTracks: [],
    fallbackTracks: [],
    avoidTrackIds: new Set(["bad"]),
  });

  assert.equal(result, null);
});
