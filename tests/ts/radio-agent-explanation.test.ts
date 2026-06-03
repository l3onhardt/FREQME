import assert from "node:assert/strict";
import test from "node:test";

import { HostResponder } from "../../src/radio/hostResponder.js";
import type { DecisionTrace, ListeningIntentDecision } from "../../src/radio/radioBrainTypes.js";

const explanationIntent: ListeningIntentDecision = {
  type: "explanation_question",
  rawText: "why this song?",
  query: "",
  positiveSeeds: [],
  negativeConstraints: [],
  shouldReplan: false,
  shouldClearQueue: false,
  shouldExplain: true,
  confidence: "high",
  ackText: "I will explain this one.",
};

const agentTrace: DecisionTrace = {
  id: "trace-1",
  uid: "42",
  sessionId: 9,
  episodeId: "window-1",
  intentType: "autoplay",
  profileQuality: { level: "strong", score: 0.9, reasons: ["durable profile"] },
  environment: { scene: "late night", localTimeBlock: "late_night", summary: "late night" },
  selectedTrack: { id: "s1", name: "Good Days", artist: "SZA" },
  reason: "model candidate trace verification selected this from JSON",
  rejectedCandidates: [],
  verificationAttempts: ["SZA Good Days"],
  fallbackLevel: "episode_primary",
  latencyMs: { radioAgent: 12 },
  hostText: "Known taste anchor inside the current late-night R&B program.",
  createdAt: "2026-06-03T01:02:03.000Z",
};

test("agent-owned traces explain the selected track without internal terms", () => {
  const responder = new HostResponder();
  const text = responder.explainCurrentTrack(explanationIntent, agentTrace);

  assert.match(text, /Good Days|SZA|late-night R&B/i);
  assert.doesNotMatch(text, /candidate|trace|verification|model|JSON|prompt|tool call/i);
});
