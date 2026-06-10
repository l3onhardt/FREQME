import assert from "node:assert/strict";
import test from "node:test";

import { chooseOpeningTrack, likedOpeningTracks } from "../../src/radio-agent/openingTrack.js";
import type { TasteProfile } from "../../src/types.js";

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

test("opening selector skips durable avoided artists before first playback", () => {
  const result = chooseOpeningTrack({
    recentPlayableTracks: [{ id: "recent-sza", name: "Snooze", artist: "SZA" }],
    profileAnchorTracks: [{ id: "anchor-sza", name: "Good Days", artist: "SZA" }],
    likedTracks: [{ id: "liked-frank", name: "Pink + White", artist: "Frank Ocean" }],
    fallbackTracks: [],
    avoidTrackIds: new Set(),
    avoidArtists: new Set(["sza"]),
  });

  assert.equal(result?.track.id, "liked-frank");
  assert.equal(result?.reason.type, "radio_agent_opening_liked");
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

test("liked opening tracks restores liked ids from profile and scanned library metadata", () => {
  const profile = tasteProfile({
    likedTrackIds: ["liked-library", "liked-anchor", "missing-meta"],
    anchorTracks: [
      { id: "liked-anchor", name: "Anchor Like", artist: "A" },
      { id: "not-liked", name: "Not Liked", artist: "B" },
    ],
    recentTracks: [{ id: "liked-library", name: "Recent Like", artist: "C" }],
  });
  const tracks = likedOpeningTracks({
    uid: "42",
    profile,
    libraryTracks: [
      { uid: "42", playlistId: "p1", songId: "liked-library", songName: "Library Like", artist: "D", album: "Album", source: {}, scannedAt: "" },
      { uid: "42", playlistId: "p1", songId: "missing-meta", songName: "", artist: "E", album: "", source: {}, scannedAt: "" },
    ],
  });

  assert.deepEqual(tracks.map((track) => track.id), ["liked-anchor", "liked-library"]);
  assert.equal(tracks[0]?.name, "Anchor Like");
});

function tasteProfile(overrides: Partial<TasteProfile>): TasteProfile {
  return {
    uid: "42",
    musicDna: {
      genres: {},
      languageBias: {},
      energyLevel: "",
      vocalPreference: "",
    },
    personality: {
      traits: [],
      emotionalResonance: "",
    },
    radioInsights: {
      tasteSummary: "",
      comfortZone: [],
      discoveryDirection: [],
      emotionalHooks: [],
      djTalkingPoints: [],
    },
    anchorTracks: [],
    recentTracks: [],
    likedTrackIds: [],
    learned: {
      avoidedLanguages: [],
      avoidedStyles: [],
      skippedTrackIds: [],
      negativeFeedbackCount: 0,
    },
    updatedAt: "",
    ...overrides,
  };
}
