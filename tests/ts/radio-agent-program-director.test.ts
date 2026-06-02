import assert from "node:assert/strict";
import test from "node:test";

import { RadioAgentProgramDirector, type ProgramPlanningModel } from "../../src/radio-agent/programDirector.js";
import type { RadioAgentContextSnapshot, RadioAgentMemory, RadioAgentProgramWindow } from "../../src/radio-agent/types.js";

const NOW = "2026-06-03T01:02:03.000Z";

test("model JSON planning creates an agent-owned radio window from compact context", async () => {
  const prompts: string[] = [];
  const model: ProgramPlanningModel = {
    chat: async (prompt, options) => {
      prompts.push(prompt);
      assert.deepEqual(options, { responseFormat: "json" });
      return JSON.stringify({
        station_brief: "Late-night R&B with a gentle discovery edge.",
        main_direction: "Keep the SZA thread warm, then widen toward Frank Ocean textures.",
        allowed_adjacent: ["alt rnb", "neo soul", "quiet pop"],
        bridge_budget: 2,
        disallowed: ["sleep sounds", "study beats"],
        return_requirement: "Return to late-night R&B after any adjacent step.",
        candidate_tasks: [
          { query: "SZA Snooze", reason: "Direct taste anchor", style: "late night rnb", negative_constraints: ["no remixes"] },
          { query: "Frank Ocean Pink + White", reason: "Soft adjacent bridge", style: "alt rnb" },
          { query: "", reason: "blank query must be dropped" },
          { query: "please play something chill for studying", reason: "raw command must be dropped" },
          { query: "lofi study beats", reason: "utility audio must be dropped" },
          { query: "Daniel Caesar Japanese Denim", reason: "Warm vocal anchor" },
          { query: "H.E.R. Focus", reason: "Quiet R&B continuation" },
          { query: "Kelela Raven", reason: "Textural adjacent" },
          { query: "Jorja Smith Blue Lights", reason: "Over cap" },
          { query: "Ravyn Lenae Skin Tight", reason: "Over cap" },
        ],
        host_intent: {
          should_speak: true,
          event: "bridge",
          reason: "queue_low",
          text: "The JSON candidate trace says this model should verify the next tool call.",
        },
        trace_basis: ["profile", "memory", "ready_queue"],
      });
    },
  };

  const director = new RadioAgentProgramDirector(model, () => NOW);
  const window = await director.plan(contextSnapshot());

  assert.equal(window.uid, "42");
  assert.equal(window.sessionId, 7);
  assert.equal(window.createdAt, NOW);
  assert.equal(window.source, "model");
  assert.equal(window.stationBrief, "Late-night R&B with a gentle discovery edge.");
  assert.equal(window.mainDirection, "Keep the SZA thread warm, then widen toward Frank Ocean textures.");
  assert.deepEqual(window.allowedAdjacent, ["alt rnb", "neo soul", "quiet pop"]);
  assert.equal(window.bridgeBudget, 2);
  assert.deepEqual(window.disallowed, ["sleep sounds", "study beats"]);
  assert.equal(window.returnRequirement, "Return to late-night R&B after any adjacent step.");
  assert.deepEqual(
    window.candidateTasks.map((task) => task.query),
    ["SZA Snooze", "Frank Ocean Pink + White", "Daniel Caesar Japanese Denim", "H.E.R. Focus", "Kelela Raven"],
  );
  assert.deepEqual(window.candidateTasks[0]?.negativeConstraints, ["no remixes"]);
  assert.equal(window.hostIntent.shouldSpeak, false);
  assert.equal(window.hostIntent.text, "");
  assert.doesNotMatch(String(window.hostIntent.text), /model|JSON|candidate|trace|prompt|verification|shadow mode|tool call/i);
  assert.deepEqual(window.traceBasis, ["profile", "memory", "ready_queue"]);
  assertPromptIncludesCompactContext(prompts[0] ?? "");
});

test("model failure falls back to deterministic memory anchors", async () => {
  const model: ProgramPlanningModel = {
    chat: async () => {
      throw new Error("model unavailable");
    },
  };
  const director = new RadioAgentProgramDirector(model, () => NOW);

  const window = await director.plan(contextSnapshot());

  assertFallbackWindow(window);
});

test("empty model tasks fall back to deterministic memory anchors", async () => {
  const model: ProgramPlanningModel = {
    chat: async () => JSON.stringify({ candidate_tasks: [{ query: "sleep sounds", reason: "not music programming" }] }),
  };
  const director = new RadioAgentProgramDirector(model, () => NOW);

  const window = await director.plan(contextSnapshot());

  assertFallbackWindow(window);
});

function contextSnapshot(): RadioAgentContextSnapshot {
  const memoryFacts: RadioAgentMemory[] = [
    {
      uid: "42",
      key: "artist:SZA",
      kind: "taste_fact",
      value: "Listener has repeated library evidence for SZA.",
      confidence: 0.91,
      evidenceCount: 5,
      evidenceRefs: ["track:sza-1"],
      updatedAt: "2026-06-03T01:00:00.000Z",
    },
    {
      uid: "42",
      key: "artist:Frank Ocean",
      kind: "taste_fact",
      value: "Listener returns to Frank Ocean for soft late-night transitions.",
      confidence: 0.83,
      evidenceCount: 4,
      evidenceRefs: ["track:frank-1"],
      updatedAt: "2026-06-03T01:00:00.000Z",
    },
  ];

  return {
    uid: "42",
    sessionId: 7,
    eventType: "queue_low",
    profile: "# User Profile\n- SZA is a durable R&B anchor.\n- Frank Ocean is a soft adjacent anchor.",
    now: "# Station Now\nlocal_time_block: late_night\ncurrent_track: Good Days - SZA (s1)",
    contract: "# Program Contract\nstation_goal: keep late-night R&B coherent\navoid: sleep sounds, study beats",
    memoryFacts,
    memoryHypotheses: [],
    recentEvents: [
      {
        uid: "42",
        sessionId: 7,
        type: "queue_low",
        priority: "warm",
        payload: { readyQueueSize: 1 },
        createdAt: "2026-06-03T01:01:00.000Z",
      },
    ],
    currentTrack: { id: "s1", name: "Good Days", artist: "SZA" },
    readyQueue: [{ id: "s2", name: "Pink + White", artist: "Frank Ocean" }],
  };
}

function assertPromptIncludesCompactContext(prompt: string): void {
  assert.match(prompt, /JSON only/i);
  assert.match(prompt, /User Profile/);
  assert.match(prompt, /Station Now/);
  assert.match(prompt, /Program Contract/);
  assert.match(prompt, /Listener has repeated library evidence for SZA/);
  assert.match(prompt, /queue_low/);
  assert.match(prompt, /Good Days/);
  assert.match(prompt, /Pink \+ White/);
}

function assertFallbackWindow(window: RadioAgentProgramWindow): void {
  assert.equal(window.uid, "42");
  assert.equal(window.sessionId, 7);
  assert.equal(window.createdAt, NOW);
  assert.equal(window.source, "fallback");
  assert.match(window.stationBrief, /late-night R&B/i);
  assert.match(window.mainDirection, /SZA/i);
  assert.ok(window.candidateTasks.length >= 2);
  assert.ok(window.candidateTasks.length <= 5);
  assert.match(window.candidateTasks[0]?.query ?? "", /SZA/i);
  assert.match(window.candidateTasks[1]?.query ?? "", /Frank Ocean/i);
  assert.ok(window.candidateTasks.every((task) => task.reason.length > 0));
  assert.ok(window.candidateTasks.every((task) => !/study|sleep|playlist|timer|white noise/i.test(task.query)));
  assert.equal(window.hostIntent.shouldSpeak, false);
  assert.equal(window.hostIntent.text, "");
  assert.ok(window.traceBasis.some((basis) => basis.includes("artist:SZA")));
}
