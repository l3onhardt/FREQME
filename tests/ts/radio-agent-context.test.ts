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
