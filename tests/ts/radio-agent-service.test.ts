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
