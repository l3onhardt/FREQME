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

  assert.match(text, /Known taste anchor/i);
  assert.match(text, /late-night R&B/i);
  assert.doesNotMatch(text, /candidate|trace|verification|model|JSON|prompt|tool call/i);
});

test("agent-owned explanations filter plural internal terms", () => {
  const responder = new HostResponder();

  const examples = [
    "candidates narrowed this for the mood",
    "tool calls found the best fit",
    "models selected this from prompts",
  ];

  for (const reason of examples) {
    const text = responder.explainCurrentTrack(explanationIntent, {
      ...agentTrace,
      reason,
      hostText: "Known taste anchor inside the current late-night R&B program.",
    });

    assert.match(text, /Known taste anchor/i);
    assert.match(text, /late-night R&B/i);
    assert.doesNotMatch(text, /candidates?|traces?|verifications?|models?|JSON|prompts?|tool calls?/i);
  }
});

test("agent-owned explanations filter separator variants of internal terms", () => {
  const responder = new HostResponder();

  const examples = [
    "tool-call chose this track",
    "tool_call chose this track",
    "shadow-mode selected this",
    "shadow_mode selected this",
  ];

  for (const reason of examples) {
    const text = responder.explainCurrentTrack(explanationIntent, {
      ...agentTrace,
      reason,
      hostText: "Known taste anchor inside the current late-night R&B program.",
    });

    assert.match(text, /Known taste anchor/i);
    assert.match(text, /late-night R&B/i);
    assert.doesNotMatch(text, /tool[-_\s]calls?|shadow[-_\s]modes?/i);
  }
});

test("agent-owned explanations keep natural music language that resembles internal words", () => {
  const responder = new HostResponder();

  const safeReasons = [
    "It has traces of jazz in a soft late-night R&B shape.",
    "It prompts a late-night mood without breaking the vocal lane.",
  ];

  for (const reason of safeReasons) {
    const text = responder.explainCurrentTrack(explanationIntent, {
      ...agentTrace,
      reason,
      hostText: "Known taste anchor inside the current late-night R&B program.",
    });

    assert.match(text, /traces of jazz|prompts a late-night mood/i);
    assert.doesNotMatch(text, /Known taste anchor/i);
  }
});
