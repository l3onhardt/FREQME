import assert from "node:assert/strict";
import test from "node:test";

import { buildRadioAgentContextSnapshot } from "../../src/radio-agent/agentContext.js";
import type { RadioAgentEvent, RadioAgentMemory } from "../../src/radio-agent/types.js";

test("agent context compacts profile, now, contract, memory, and current playback", () => {
  const events: RadioAgentEvent[] = [
    {
      uid: "42",
      sessionId: 7,
      type: "playback_started",
      priority: "warm",
      payload: { track: { id: "s1", name: "Good Days", artist: "SZA" } },
      createdAt: "2026-06-03T01:00:00.000Z",
    },
  ];
  const memories: RadioAgentMemory[] = [
    {
      uid: "42",
      key: "artist:SZA",
      kind: "taste_fact",
      value: "Listener has repeated library evidence for SZA.",
      confidence: 0.84,
      evidenceCount: 4,
      evidenceRefs: ["track:s1"],
      updatedAt: "2026-06-03T01:01:00.000Z",
    },
  ];

  const snapshot = buildRadioAgentContextSnapshot({
    uid: "42",
    sessionId: 7,
    eventType: "queue_low",
    artifacts: {
      "user_profile.md": "# User Profile\n\n## Stable Taste Facts\n- artist:SZA: Listener has repeated library evidence for SZA.",
      "station_now.md": "# Station Now\n\nlocal_time_block: late_night\ncurrent_track: Good Days - SZA (s1)",
      "program_contract.md": "# Program Contract\n\nstation_goal: keep late-night R&B coherent",
      "listener_session.md": "# Listener Session\n\nactive_request: R&B\nnext_promise: stay inside R&B",
    },
    recentEvents: events,
    memories,
    currentTrack: { id: "s1", name: "Good Days", artist: "SZA" },
    readyQueue: [],
  });

  assert.equal(snapshot.uid, "42");
  assert.equal(snapshot.eventType, "queue_low");
  assert.equal(snapshot.currentTrack?.id, "s1");
  assert.match(snapshot.profile, /SZA/);
  assert.match(snapshot.now, /late_night/);
  assert.match(snapshot.contract, /late-night R&B/);
  assert.match(snapshot.session, /active_request: R&B/);
  assert.equal(snapshot.memoryFacts[0]?.key, "artist:SZA");
});

test("agent context caps large artifacts before model boundary", () => {
  const huge = `${"profile evidence\n".repeat(1000)}`;
  const snapshot = buildRadioAgentContextSnapshot({
    uid: "42",
    sessionId: 7,
    eventType: "queue_low",
    artifacts: { "user_profile.md": huge },
    recentEvents: [],
    memories: [],
    currentTrack: null,
    readyQueue: [],
  });

  assert.ok(snapshot.profile.length < huge.length);
  assert.match(snapshot.profile, /truncated for agent context/);
});

test("agent context strips raw track and event payload data", () => {
  const rawPayload = { raw_json: { secret: "netease-private-json" }, source_json: { rows: ["library-row"] } };
  const snapshot = buildRadioAgentContextSnapshot({
    uid: "42",
    sessionId: 7,
    eventType: "queue_low",
    artifacts: {},
    recentEvents: [
      {
        uid: "42",
        sessionId: 7,
        type: "queue_low",
        priority: "warm",
        payload: {
          currentTrack: {
            id: "s1",
            name: "Good Days",
            artist: "SZA",
            raw: { secret: "event-track-raw" },
            source: "netease",
          },
          readyQueue: [
            { id: "s2", name: "Pink + White", artist: "Frank Ocean", raw: { secret: "queue-track-raw" } },
          ],
          text: `${"turn it down ".repeat(1000)}event-text-secret`,
          timezoneName: "Asia/Hong_Kong",
          localTimeBlock: "late_night",
          raw: rawPayload,
          source_json: rawPayload,
        },
        createdAt: "2026-06-03T01:00:00.000Z",
      },
    ],
    memories: [],
    currentTrack: {
      id: "s1",
      name: "Good Days",
      artist: "SZA",
      raw: { secret: "current-track-raw" },
      source: "netease",
    },
    readyQueue: [
      { id: "s2", name: "Pink + White", artist: "Frank Ocean", raw: { secret: "ready-queue-raw" } },
    ],
  });

  assert.equal(Object.hasOwn(snapshot.currentTrack ?? {}, "raw"), false);
  assert.equal(Object.hasOwn(snapshot.readyQueue[0] ?? {}, "raw"), false);
  assert.equal(Object.hasOwn((snapshot.recentEvents[0]?.payload.currentTrack as Record<string, unknown>) ?? {}, "raw"), false);
  assert.equal(Object.hasOwn((snapshot.recentEvents[0]?.payload.readyQueue as Record<string, unknown>[])[0] ?? {}, "raw"), false);
  assert.equal(Object.hasOwn(snapshot.recentEvents[0]?.payload ?? {}, "raw"), false);
  assert.equal(Object.hasOwn(snapshot.recentEvents[0]?.payload ?? {}, "source_json"), false);
  assert.match(String(snapshot.recentEvents[0]?.payload.text), /truncated for agent context/);
  assert.doesNotMatch(JSON.stringify(snapshot), /current-track-raw|ready-queue-raw|event-track-raw|queue-track-raw|netease-private-json|library-row|event-text-secret/);
});

test("agent context keeps the latest 12 newest-first recent events", () => {
  const events: RadioAgentEvent[] = Array.from({ length: 15 }, (_, index) => ({
    uid: "42",
    sessionId: 7,
    type: "playback_progress",
    priority: "cold",
    payload: { text: `event-${index}` },
    createdAt: `2026-06-03T01:${String(index).padStart(2, "0")}:00.000Z`,
  }));

  const snapshot = buildRadioAgentContextSnapshot({
    uid: "42",
    sessionId: 7,
    eventType: "queue_low",
    artifacts: {},
    recentEvents: events,
    memories: [],
    currentTrack: null,
    readyQueue: [],
  });

  assert.equal(snapshot.recentEvents.length, 12);
  assert.equal(snapshot.recentEvents[0]?.payload.text, "event-0");
  assert.equal(snapshot.recentEvents.some((event) => event.payload.text === "event-14"), false);
});
