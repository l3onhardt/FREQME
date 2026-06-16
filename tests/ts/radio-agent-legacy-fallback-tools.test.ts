import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { createLegacyFallbackTools } from "../../src/radio-agent/legacyFallbackTools.js";

const candidateTrack = { id: "legacy-1", name: "Legacy Safe", artist: "Legacy Artist" };

function baseContext(overrides: Record<string, unknown> = {}) {
  return {
    source: "request" as const,
    level: "legacy_with_label" as const,
    reason: "agent_request_fallback",
    requestText: "quiet rnb",
    activeRequestToken: 2,
    expectedRequestToken: 2,
    contract: null,
    currentTrack: null,
    recentTracks: [],
    readyQueue: [],
    ...overrides,
  };
}

test("legacy fallback returns play_now only after governor accepts a candidate", async () => {
  const calls: string[] = [];
  const tools = createLegacyFallbackTools({
    candidateSource: async (context) => {
      calls.push(`candidate:${context.source}:${context.reason}`);
      return {
        track: candidateTrack,
        url: "/api/radio/audio/legacy-1",
        reason: { type: "radio_agent_program", text: "Governed fallback." },
        hostText: "I found a safe fallback.",
      };
    },
    governCandidate: async ({ candidate, url, fallbackLevel, hostText }) => {
      calls.push(`govern:${candidate.id}:${url}:${fallbackLevel}:${hostText}`);
      return {
        status: "accepted",
        track: candidate,
        url,
        trace: {
          status: "accepted",
          contractId: null,
          requestToken: 2,
          candidateKey: "legacy artist::legacy safe",
          decision: "direct_positive",
          evidence: ["accepted by test"],
          fallbackLevel,
        },
      };
    },
  });

  const result = await tools.fallbackToAction(baseContext());

  assert.deepEqual(calls, [
    "candidate:request:agent_request_fallback",
    "govern:legacy-1:/api/radio/audio/legacy-1:legacy_with_label:I found a safe fallback.",
  ]);
  assert.equal(result.status, "action");
  assert.equal(result.action.type, "play_now");
  if (result.action.type === "play_now") {
    assert.equal(result.action.track.id, "legacy-1");
    assert.equal(result.action.hostText, "I found a safe fallback.");
    assert.equal(result.action.governanceTrace?.status, "accepted");
  }
});

test("legacy fallback returns honest_not_found when governor rejects candidate", async () => {
  const tools = createLegacyFallbackTools({
    candidateSource: async () => ({
      track: candidateTrack,
      url: "/api/radio/audio/legacy-1",
      reason: { type: "radio_agent_program", text: "Governed fallback." },
    }),
    governCandidate: async () => ({
      status: "rejected",
      reason: "reject_off_contract",
      trace: {
        status: "rejected",
        contractId: null,
        requestToken: 2,
        candidateKey: "legacy artist::legacy safe",
        decision: "reject_off_contract",
        evidence: ["off contract"],
        fallbackLevel: "legacy_with_label",
      },
    }),
  });

  const result = await tools.fallbackToAction(baseContext());

  assert.equal(result.status, "action");
  assert.equal(result.action.type, "honest_not_found");
  if (result.action.type === "honest_not_found") {
    assert.equal(result.action.reason, "reject_off_contract");
    assert.equal(result.action.governanceTrace?.status, "rejected");
  }
});

test("legacy fallback does not call candidate source for stale request token", async () => {
  let candidateCalls = 0;
  const tools = createLegacyFallbackTools({
    candidateSource: async () => {
      candidateCalls += 1;
      return null;
    },
    governCandidate: async () => {
      throw new Error("governor should not run for stale token");
    },
  });

  const result = await tools.fallbackToAction(baseContext({ activeRequestToken: 3, expectedRequestToken: 2 }));

  assert.deepEqual(result, { status: "stale" });
  assert.equal(candidateCalls, 0);
});

test("legacy fallback reports empty when candidate source has no option", async () => {
  const tools = createLegacyFallbackTools({
    candidateSource: async () => null,
    governCandidate: async () => {
      throw new Error("governor should not run without candidate");
    },
  });

  const result = await tools.fallbackToAction(baseContext({ reason: "no_candidate" }));

  assert.deepEqual(result, { status: "empty", reason: "no_candidate" });
});

test("legacy fallback tools module cannot mutate playback directly", () => {
  const source = fs.readFileSync("src/radio-agent/legacyFallbackTools.ts", "utf8");
  assert.doesNotMatch(source, /queue\.addReady|queue\.promoteNext|fillQueue|send\(|synthesizeAndSendDjMessage|radioBrain|stationDirector|scheduler/);
});
