import assert from "node:assert/strict";
import test from "node:test";

import { RadioAgentService } from "../../src/radio-agent/radioAgentService.js";
import type { OpeningTrackPick } from "../../src/radio-agent/openingTrack.js";
import type { RadioAgentPreparedTrack } from "../../src/radio-agent/types.js";
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

function prepared(track: Track): RadioAgentPreparedTrack {
  return {
    track,
    url: `/audio/${track.id}`,
    segueText: "",
    selectionReason: { type: "radio_agent_opening_liked", text: "Started from a liked track." } satisfies SelectionReason,
    decisionTrace: {
      id: "trace-1",
      trackId: track.id,
      source: "radio_agent",
      reason: "Started from a liked track.",
      createdAt: "2026-06-11T00:00:00.000Z",
    },
  };
}
