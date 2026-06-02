import assert from "node:assert/strict";
import test from "node:test";

import {
  buildProgramContractMarkdown,
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
