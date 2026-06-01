import assert from "node:assert/strict";
import test from "node:test";

import { HostResponder } from "../../src/radio/hostResponder.js";
import type { DecisionTrace, ListeningIntentDecision } from "../../src/radio/radioBrainTypes.js";

const explanationIntent: ListeningIntentDecision = {
  type: "explanation_question",
  rawText: "为什么给我放这首？",
  query: "",
  positiveSeeds: [],
  negativeConstraints: [],
  shouldReplan: false,
  shouldClearQueue: false,
  shouldExplain: true,
  confidence: "high",
  ackText: "我解释一下这首为什么接在这里。",
};

const trace: DecisionTrace = {
  id: "trace-1",
  uid: "42",
  sessionId: 7,
  episodeId: "episode-1",
  intentType: "music_direction_request",
  profileQuality: { level: "usable", score: 0.6, reasons: [] },
  environment: { scene: "夜晚", localTimeBlock: "night", summary: "夜晚" },
  selectedTrack: { id: "song-1", name: "Says", artist: "Nils Frahm" },
  reason: "它是安静、无人声、但有推进感的器乐，贴合刚才的专注工作流。",
  rejectedCandidates: [],
  verificationAttempts: ["Nils Frahm Says"],
  fallbackLevel: "episode_primary",
  latencyMs: {},
  hostText: "这首先把工作流压稳。",
  createdAt: "2026-06-01T00:00:00.000Z",
};

test("explains the current song from decision trace", () => {
  const responder = new HostResponder();
  const text = responder.explainCurrentTrack(explanationIntent, trace);

  assert.match(text, /Says/);
  assert.match(text, /Nils Frahm/);
  assert.match(text, /专注|工作流|无人声/);
  assert.doesNotMatch(text, /系统|算法|JSON|trace/);
});

test("fast acknowledgement reflects correction constraints", () => {
  const responder = new HostResponder();
  const text = responder.acknowledge({
    ...explanationIntent,
    type: "correction",
    shouldExplain: false,
    shouldReplan: true,
    shouldClearQueue: true,
    negativeConstraints: ["人声", "EDM"],
    positiveSeeds: ["安静专注工作流"],
    ackText: "懂了，我先避开刚才那个方向，重新往你要的感觉收。",
  });

  assert.match(text, /避开|重新|专注/);
});
