import assert from "node:assert/strict";
import test from "node:test";

import { runRadioAgentActions } from "../../src/radio-agent/actionRunner.js";
import type { RadioAgentAction } from "../../src/radio-agent/agentActions.js";

function deps(calls: string[] = []) {
  return {
    queuePlayNow: async ({ track, url, reason, hostText }: any) => {
      calls.push(`queue:${track.id}:${url}:${reason.type}:${hostText}`);
    },
    queuePrepared: async ({ prepared }: any) => {
      calls.push(`prepared:${prepared.track.id}`);
    },
    speak: async ({ text }: any) => calls.push(`speak:${text}`),
    staySilent: async ({ reason }: any) => calls.push(`silent:${reason}`),
    reportNotFound: async ({ reason }: any) => calls.push(`not-found:${reason}`),
    reportFallback: async ({ level, reason }: any) => calls.push(`fallback:${level}:${reason}`),
  };
}

test("action runner queues a play_now action without choosing music", async () => {
  const calls: string[] = [];
  const actions: RadioAgentAction[] = [
    {
      type: "play_now",
      track: { id: "track-1", name: "Track One", artist: "Artist One" },
      url: "/api/radio/audio/track-1",
      hostText: "Short handoff.",
      reason: { type: "radio_agent_program", text: "Approved." },
    },
  ];

  const result = await runRadioAgentActions(actions, deps(calls));

  assert.deepEqual(calls, ["queue:track-1:/api/radio/audio/track-1:radio_agent_program:Short handoff."]);
  assert.deepEqual(result.executedTypes, ["play_now"]);
  assert.equal(result.playbackQueued, true);
  assert.equal(result.spoke, false);
});

test("action runner preserves speak before play order", async () => {
  const calls: string[] = [];

  await runRadioAgentActions(
    [
      { type: "speak", text: "Got it.", speechRole: "ack" },
      {
        type: "play_now",
        track: { id: "track-2", name: "Track Two", artist: "Artist Two" },
        url: "/api/radio/audio/track-2",
        reason: { type: "radio_agent_program", text: "Approved." },
      },
    ],
    deps(calls),
  );

  assert.deepEqual(calls, ["speak:Got it.", "queue:track-2:/api/radio/audio/track-2:radio_agent_program:"]);
});

test("action runner queues only prepared tracks from queue_window", async () => {
  const calls: string[] = [];
  const result = await runRadioAgentActions(
    [
      {
        type: "queue_window",
        window: {
          id: "window-1",
          uid: "42",
          sessionId: 7,
          stationBrief: "Brief.",
          mainDirection: "quiet",
          allowedAdjacent: [],
          bridgeBudget: 0,
          disallowed: [],
          returnRequirement: "Stay quiet.",
          candidateTasks: [{ query: "should not execute", reason: "data only", style: "quiet", negativeConstraints: [] }],
          hostIntent: { shouldSpeak: false, event: "silent", reason: "test", text: "" },
          traceBasis: { profile: "", now: "", contract: "", eventType: "queue_low" },
          source: "deterministic_fallback",
          createdAt: "2026-06-17T00:00:00.000Z",
        },
        prepared: [
          {
            track: { id: "prepared-1", name: "Prepared", artist: "Artist" },
            url: "/api/radio/audio/prepared-1",
            selectionReason: { type: "radio_agent_program", text: "Already prepared." },
            segueText: "",
            decisionTrace: { id: "trace-1", source: "radio_agent", steps: [] },
          },
        ],
      },
    ],
    deps(calls),
  );

  assert.deepEqual(calls, ["prepared:prepared-1"]);
  assert.equal(result.preparedQueued, 1);
});

test("action runner reports honest not found without fallback mutation", async () => {
  const calls: string[] = [];
  const result = await runRadioAgentActions(
    [
      {
        type: "honest_not_found",
        contract: null,
        reason: "reject_off_contract",
        searchedQueries: ["quiet rnb"],
      },
    ],
    deps(calls),
  );

  assert.deepEqual(calls, ["not-found:reject_off_contract"]);
  assert.equal(result.notFound, true);
  assert.equal(result.playbackQueued, false);
});

test("action runner reports fallback intent without running legacy systems", async () => {
  const calls: string[] = [];
  const result = await runRadioAgentActions(
    [{ type: "fallback", level: "legacy_with_label", reason: "agent_request_fallback" }],
    deps(calls),
  );

  assert.deepEqual(calls, ["fallback:legacy_with_label:agent_request_fallback"]);
  assert.deepEqual(result.fallbackLevels, ["legacy_with_label"]);
  assert.equal(result.playbackQueued, false);
});
