import assert from "node:assert/strict";
import test from "node:test";

import {
  buildListenerSessionMarkdown,
  buildAgentJournalMarkdown,
  buildProgramContractMarkdown,
  buildSessionReflectionMarkdown,
  buildStationNowMarkdown,
  buildUserProfileMarkdown,
} from "../../src/radio-agent/contextArtifacts.js";

test("user profile markdown separates facts from hypotheses", () => {
  const markdown = buildUserProfileMarkdown({
    uid: "42",
    facts: [{ key: "artist:SZA", value: "Frequent SZA evidence.", confidence: 0.8, evidenceCount: 3 }],
    hypotheses: [{ key: "scene:night", value: "May prefer lower energy at night.", confidence: 0.55, evidenceCount: 1 }],
    updatedAt: "2026-06-03T00:00:00.000Z",
  });

  assert.match(markdown, /## Stable Taste Facts/);
  assert.match(markdown, /Frequent SZA evidence/);
  assert.match(markdown, /## Hypotheses/);
  assert.match(markdown, /updated: 2026-06-03T00:00:00.000Z/);
});

test("user profile markdown caps long evidence lists for agent context", () => {
  const markdown = buildUserProfileMarkdown({
    uid: "42",
    facts: Array.from({ length: 40 }, (_, index) => ({
      key: `artist:${index}`,
      value: `Artist ${index}`,
      confidence: 0.9,
      evidenceCount: 40 - index,
    })),
    hypotheses: Array.from({ length: 20 }, (_, index) => ({
      key: `theme:${index}`,
      value: `Theme ${index}`,
      confidence: 0.6,
      evidenceCount: 20 - index,
    })),
    updatedAt: "2026-06-03T00:00:00.000Z",
  });

  assert.match(markdown, /artist:23/);
  assert.doesNotMatch(markdown, /artist:24/);
  assert.match(markdown, /16 additional facts omitted/);
  assert.match(markdown, /8 additional hypotheses omitted/);
});

test("station now markdown includes uncertainty", () => {
  const markdown = buildStationNowMarkdown({
    localTimeBlock: "late_night",
    timezoneName: "Asia/Hong_Kong",
    currentTrack: { id: "1", name: "A", artist: "B" },
    recentTracks: [],
    listenerStateHypothesis: "low interruption likely",
    confidence: "medium",
  });

  assert.match(markdown, /late_night/);
  assert.match(markdown, /low interruption likely/);
  assert.match(markdown, /confidence: medium/i);
});

test("program contract markdown records host boundaries", () => {
  const markdown = buildProgramContractMarkdown({
    stationGoal: "late-night R&B with adjacent electronic bridges",
    allowedMoves: ["R&B", "soul", "one adjacent electronic bridge"],
    blockedMoves: ["classical chamber drift", "generic ambient run"],
    hostStyle: "short, human, no internal planning terms",
  });

  assert.match(markdown, /late-night R&B/);
  assert.match(markdown, /classical chamber drift/);
  assert.match(markdown, /no internal planning terms/);
});

test("listener session markdown records the active request, boundaries, and DJ promise", () => {
  const markdown = buildListenerSessionMarkdown({
    updatedAt: "2026-06-03T01:02:03.000Z",
    activeRequest: "R&B",
    acceptedDirection: "Keep the current session centered on R&B vocals and groove.",
    rejectedMoves: ["generic electronic", "classical chamber music"],
    recentCorrections: ["User asked for R&B instead of old electronic/classical anchors."],
    openHypotheses: ["Session wants warm vocal R&B; do not treat this as a permanent dislike of other styles."],
    nextPromise: "Stay in R&B until the listener asks to move elsewhere.",
    hostGuidance: "Acknowledge the R&B lane naturally and avoid internal planning terms.",
  });

  assert.match(markdown, /# Listener Session/);
  assert.match(markdown, /active_request: R&B/);
  assert.match(markdown, /generic electronic/);
  assert.match(markdown, /classical chamber music/);
  assert.match(markdown, /Stay in R&B until the listener asks to move elsewhere/);
  assert.match(markdown, /do not treat this as a permanent dislike/i);
});

test("session reflection markdown summarizes outcomes without over-promoting skips", () => {
  const markdown = buildSessionReflectionMarkdown({
    updatedAt: "2026-06-03T01:02:03.000Z",
    completedTracks: [
      { id: "a1", name: "Pictures Of You", artist: "Anyma" },
      { id: "a2", name: "Eternity", artist: "Anyma" },
    ],
    skippedTracks: [{ id: "bad-1", name: "Too Much", artist: "A" }],
    correctionTexts: ["不要电子，回到 R&B"],
    sessionSignals: ["Repeated completed listening returned to Anyma."],
    temporaryAvoids: ["bad-1", "generic electronic"],
    longTermCandidates: ["artist:Anyma"],
  });

  assert.match(markdown, /# Session Reflection/);
  assert.match(markdown, /Pictures Of You - Anyma/);
  assert.match(markdown, /Too Much - A/);
  assert.match(markdown, /不要电子，回到 R&B/);
  assert.match(markdown, /Repeated completed listening returned to Anyma/);
  assert.match(markdown, /Do not turn a single skip into a permanent dislike/i);
});

test("agent journal markdown explains the latest decision without internal terms", () => {
  const markdown = buildAgentJournalMarkdown({
    updatedAt: "2026-06-03T01:02:03.000Z",
    eventType: "queue_low",
    observation: "Queue is low while the listener is staying in late-night R&B.",
    interpretation: "Recent accepted listening and reflection point toward Frank Ocean.",
    action: "Plan the next candidate around Frank Ocean and keep generic electronic out.",
    guardrails: ["avoid generic electronic", "do not expose model trace"],
    nextCheck: "If the listener skips again, narrow the R&B lane before adding more tracks.",
  });

  assert.match(markdown, /# Agent Journal/);
  assert.match(markdown, /Queue is low/);
  assert.match(markdown, /Frank Ocean/);
  assert.match(markdown, /avoid generic electronic/);
  assert.doesNotMatch(markdown, /model trace|prompt|JSON|tool call|shadow decision/i);
});
