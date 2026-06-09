import assert from "node:assert/strict";
import test from "node:test";

import { RadioAgentProgramDirector, type ProgramPlanningModel } from "../../src/radio-agent/programDirector.js";
import type { RadioAgentContextSnapshot, RadioAgentMemory, RadioAgentProgramWindow } from "../../src/radio-agent/types.js";

const NOW = "2026-06-03T01:02:03.000Z";
const listenerUnsafeProgramTerms =
  /deterministic|radio memory|current (?:station )?contract|station contract|model-selected|model selected|candidate|trace|verification|prompt|tool call|listener has|library evidence|playlist titles repeatedly/i;

test("model JSON planning creates an agent-owned radio window from compact context", async () => {
  const prompts: string[] = [];
  const model: ProgramPlanningModel = {
    chat: async (prompt, options) => {
      prompts.push(prompt);
      assert.deepEqual(options?.responseFormat, { type: "json_object" });
      assert.equal(options?.maxTokens, 1100);
      assert.match(options?.system ?? "", /program director/i);
      assert.match(options?.system ?? "", /valid JSON/i);
      assert.equal(options?.timeoutMs, 14000);
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
          event: "bridge_entered",
          reason: "queue_low",
          text: "A soft bridge, then back to the late-night thread.",
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
  assert.ok(window.candidateTasks.every((task) => typeof task.style === "string"));
  assert.deepEqual(window.candidateTasks[0]?.negativeConstraints, ["no remixes"]);
  assert.equal(window.candidateTasks[2]?.style, "");
  assert.equal(window.hostIntent.shouldSpeak, true);
  assert.equal(window.hostIntent.event, "bridge_entered");
  assert.equal(window.hostIntent.text, "A soft bridge, then back to the late-night thread.");
  assert.doesNotMatch(String(window.hostIntent.text), /model|JSON|candidate|trace|prompt|verification|shadow mode|tool call/i);
  assert.deepEqual(window.traceBasis, traceBasisFromContext(contextSnapshot()));
  assertPromptIncludesCompactContext(prompts[0] ?? "");
});

test("program director includes listener session working memory in the planning prompt", async () => {
  const prompts: string[] = [];
  const model: ProgramPlanningModel = {
    chat: async (prompt) => {
      prompts.push(prompt);
      return JSON.stringify({
        candidate_tasks: [{ query: "Daniel Caesar Japanese Denim", reason: "Direct R&B lane.", style: "R&B" }],
        host_intent: {
          should_speak: true,
          event: "request_ack",
          reason: "explicit listener boundary",
          text: "好，先守住 R&B，人声和律动靠前，电子和古典我先避开。",
        },
      });
    },
  };
  const director = new RadioAgentProgramDirector(model, () => NOW);

  await director.plan({
    ...contextSnapshot(),
    session:
      "# Listener Session\nactive_request: R&B\nrejected_moves:\n- generic electronic\n- classical chamber music\nnext_promise: Stay in R&B until the listener asks to move elsewhere.",
    memoryFacts: [],
    contract: "# Program Contract\nstation_goal: current R&B radio with soft vocal anchors\navoid: generic electronic, classical chamber music",
  });

  assert.match(prompts[0] ?? "", /Listener Session/);
  assert.match(prompts[0] ?? "", /active_request: R&B/);
  assert.match(prompts[0] ?? "", /generic electronic/);
  assert.match(prompts[0] ?? "", /Stay in R&B until the listener asks to move elsewhere/);
});

test("program director includes session reflection and memory hypotheses in the planning prompt", async () => {
  const prompts: string[] = [];
  const model: ProgramPlanningModel = {
    chat: async (prompt) => {
      prompts.push(prompt);
      return JSON.stringify({
        candidate_tasks: [{ query: "Frank Ocean Pink + White", reason: "Reflects recent accepted R&B listening.", style: "alt-R&B" }],
      });
    },
  };
  const director = new RadioAgentProgramDirector(model, () => NOW);

  await director.plan({
    ...contextSnapshot(),
    reflection: "# Session Reflection\n## Session Signals\n- session_artist:Frank Ocean",
    memoryHypotheses: [
      {
        uid: "42",
        key: "session_artist:Frank Ocean",
        kind: "taste_hypothesis",
        value: "Recent completed listening repeatedly returned to Frank Ocean.",
        confidence: 0.7,
        evidenceCount: 2,
        evidenceRefs: ["event:1", "event:2"],
        updatedAt: NOW,
      },
    ],
  });

  assert.match(prompts[0] ?? "", /Session Reflection/);
  assert.match(prompts[0] ?? "", /session_artist:Frank Ocean/);
  assert.match(prompts[0] ?? "", /Memory Hypotheses/);
  assert.match(prompts[0] ?? "", /Recent completed listening repeatedly returned to Frank Ocean/);
});

test("fallback planning turns session reflection into executable anchors and temporary avoids", async () => {
  const director = new RadioAgentProgramDirector(null, () => NOW);

  const window = await director.plan({
    ...contextSnapshot(),
    contract: "# Program Contract\nstation_goal: mellow personal radio\navoid: high-energy EDM",
    profile: "",
    memoryFacts: [],
    memoryHypotheses: [],
    currentTrack: null,
    readyQueue: [],
    reflection:
      "# Session Reflection\n\n## Session Signals\n- session_artist:Frank Ocean: Recent completed listening repeatedly returned to Frank Ocean.\n\n## Temporary Avoids\n- bad-track-1\n- generic electronic\n\n## Long-Term Candidates\n- session_artist:Frank Ocean\n",
  });

  assert.equal(window.source, "deterministic_fallback");
  assert.match(window.candidateTasks[0]?.query ?? "", /Frank Ocean/i);
  assert.ok(window.candidateTasks.every((task) => task.negativeConstraints.includes("generic electronic")));
  assert.ok(window.candidateTasks.every((task) => task.negativeConstraints.includes("bad-track-1")));
  assert.match(window.mainDirection, /Frank Ocean/i);
  assert.match(window.hostIntent.text, /Frank Ocean/i);
  assert.doesNotMatch(window.hostIntent.text, /鎴|銆|鐨|涓|杩|俙|旁边|质感/);
});

test("fallback planning does not use temporary avoids as positive anchors", async () => {
  const director = new RadioAgentProgramDirector(null, () => NOW);

  const window = await director.plan({
    ...contextSnapshot(),
    contract: "# Program Contract\nstation_goal: mellow personal radio",
    profile: "",
    memoryFacts: [],
    memoryHypotheses: [],
    currentTrack: null,
    readyQueue: [],
    reflection:
      "# Session Reflection\n\n## Skipped Tracks\n- Too Much - A (bad-1)\n\n## Temporary Avoids\n- A\n- Too Much\n- generic electronic\n",
  });

  assert.ok(window.candidateTasks.every((task) => !/^A$|Too Much|generic electronic/i.test(task.query)));
  assert.ok(window.candidateTasks.every((task) => task.negativeConstraints.includes("generic electronic")));
});

test("program director preserves spec-compliant host events and sanitizes internal host text", async () => {
  const events = [
    "station_open",
    "request_ack",
    "bridge_entered",
    "return_to_contract",
    "explanation",
    "correction",
    "recovery",
    "silent",
  ] as const;

  for (const event of events) {
    const model: ProgramPlanningModel = {
      chat: async () => JSON.stringify({
        candidate_tasks: [{ query: "SZA Snooze", reason: "Known anchor." }],
        host_intent: {
          should_speak: event !== "silent",
          event,
          reason: "contract",
          text: event === "explanation" ? "The model JSON trace says to speak." : "Keeping the thread warm.",
        },
      }),
    };
    const director = new RadioAgentProgramDirector(model, () => NOW);

    const window = await director.plan(contextSnapshot());

    assert.equal(window.hostIntent.event, event === "explanation" ? "silent" : event);
    assert.equal(window.hostIntent.text, event === "explanation" || event === "silent" ? "" : "Keeping the thread warm.");
  }
});

test("program director silences invalid model host events", async () => {
  const model: ProgramPlanningModel = {
    chat: async () => JSON.stringify({
      candidate_tasks: [{ query: "SZA Snooze", reason: "Known anchor." }],
      host_intent: {
        should_speak: true,
        event: "made_up_event",
        reason: "bad event",
        text: "Keeping the thread warm.",
      },
    }),
  };
  const director = new RadioAgentProgramDirector(model, () => NOW);

  const window = await director.plan(contextSnapshot());

  assert.equal(window.hostIntent.shouldSpeak, false);
  assert.equal(window.hostIntent.event, "silent");
  assert.equal(window.hostIntent.text, "");
});

test("program director only speaks when should_speak is a literal boolean true", async () => {
  for (const shouldSpeak of ["false", "true", 1, null]) {
    const model: ProgramPlanningModel = {
      chat: async () => JSON.stringify({
        candidate_tasks: [{ query: "SZA Snooze", reason: "Known anchor." }],
        host_intent: {
          should_speak: shouldSpeak,
          event: "bridge_entered",
          reason: "malformed boolean",
          text: "Keeping the thread warm.",
        },
      }),
    };
    const director = new RadioAgentProgramDirector(model, () => NOW);

    const window = await director.plan(contextSnapshot());

    assert.equal(window.hostIntent.shouldSpeak, false);
    assert.equal(window.hostIntent.event, "silent");
    assert.equal(window.hostIntent.text, "");
  }
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

test("program director supports deterministic planning when no model is configured", async () => {
  const director = new RadioAgentProgramDirector(null, () => NOW);

  const window = await director.plan(contextSnapshot());

  assertFallbackWindow(window);
});

test("fallback planning speaks once with a concrete continuity handoff on first queue pressure", async () => {
  const director = new RadioAgentProgramDirector(null, () => NOW);

  const window = await director.plan(contextSnapshot());

  assert.equal(window.hostIntent.shouldSpeak, true);
  assert.equal(window.hostIntent.event, "return_to_contract");
  assert.match(window.hostIntent.text, /SZA/);
  assert.doesNotMatch(window.hostIntent.text, listenerUnsafeProgramTerms);
  assert.doesNotMatch(window.hostIntent.text, /旁边|质感/);
});

test("fallback planning still speaks when repeated queue pressure has not produced an agent item yet", async () => {
  const director = new RadioAgentProgramDirector(null, () => NOW);

  const window = await director.plan({
    ...contextSnapshot(),
    recentEvents: [
      ...contextSnapshot().recentEvents,
      {
        uid: "42",
        sessionId: 7,
        type: "queue_low",
        priority: "warm",
        payload: { readyQueueSize: 0 },
        createdAt: "2026-06-03T01:00:30.000Z",
      },
    ],
    readyQueue: [],
  });

  assert.equal(window.hostIntent.shouldSpeak, true);
  assert.equal(window.hostIntent.event, "return_to_contract");
  assert.match(window.hostIntent.text, /SZA/);
});

test("fallback planning stays quiet once an agent-program item is already ready", async () => {
  const director = new RadioAgentProgramDirector(null, () => NOW);

  const window = await director.plan({
    ...contextSnapshot(),
    readyQueue: [
      {
        id: "agent-1",
        name: "Breakaway",
        artist: "Martin Garrix",
        selectionReason: {
          type: "radio_agent_program",
          text: "Agent-owned program item.",
          traceId: "trace-1",
        },
      },
    ],
  });

  assert.equal(window.hostIntent.shouldSpeak, false);
  assert.equal(window.hostIntent.event, "silent");
  assert.equal(window.hostIntent.text, "");
});

test("fallback planning uses the current contract when no playback or memory anchors exist", async () => {
  const director = new RadioAgentProgramDirector(null, () => NOW);

  const window = await director.plan({
    ...contextSnapshot(),
    memoryFacts: [],
    memoryHypotheses: [],
    currentTrack: null,
    readyQueue: [],
    contract: "# Program Contract\nstation_goal: late-night R&B with soft neo soul vocals\navoid: sleep sounds, study beats",
  });

  assert.equal(window.source, "deterministic_fallback");
  assert.ok(window.candidateTasks.length > 0);
  assert.match(window.candidateTasks[0]?.query ?? "", /late-night R&B|neo soul|vocals/i);
  assert.ok(window.candidateTasks.every((task) => typeof task.style === "string"));
});

test("fallback planning prioritizes an explicit contract over stale taste anchors", async () => {
  const director = new RadioAgentProgramDirector(null, () => NOW);

  const window = await director.plan({
    ...contextSnapshot(),
    memoryFacts: [
      {
        uid: "42",
        key: "artist:Anyma",
        kind: "taste_fact",
        value: "Listener has repeated library evidence for Anyma.",
        confidence: 0.91,
        evidenceCount: 6,
        evidenceRefs: ["track:anyma-1"],
        updatedAt: "2026-06-03T01:00:00.000Z",
      },
      {
        uid: "42",
        key: "artist:Glenn Gould",
        kind: "taste_fact",
        value: "Listener has repeated library evidence for Glenn Gould.",
        confidence: 0.91,
        evidenceCount: 6,
        evidenceRefs: ["track:gould-1"],
        updatedAt: "2026-06-03T01:00:00.000Z",
      },
      {
        uid: "42",
        key: "artist:Colyn",
        kind: "taste_fact",
        value: "Listener has repeated library evidence for Colyn.",
        confidence: 0.91,
        evidenceCount: 6,
        evidenceRefs: ["track:colyn-1"],
        updatedAt: "2026-06-03T01:00:00.000Z",
      },
    ],
    currentTrack: { id: "edm-1", name: "Breakaway", artist: "Martin Garrix" },
    readyQueue: [],
    contract: "# Program Contract\nstation_goal: current R&B radio with soft vocal anchors\navoid: high-energy EDM, pure classical piano",
  });

  assert.match(window.candidateTasks[0]?.query ?? "", /R&B|vocal/i);
  assert.ok(window.candidateTasks.every((task) => !/Anyma|Martin Garrix|Glenn Gould|Colyn/i.test(task.query)));
  assert.doesNotMatch(window.hostIntent.text, /Anyma|Martin Garrix|Glenn Gould|Colyn/i);
});

test("model planning under an explicit R&B contract drops off-contract electronic candidates", async () => {
  const model: ProgramPlanningModel = {
    chat: async () => JSON.stringify({
      station_brief: "Current R&B radio with soft vocal anchors.",
      main_direction: "Keep R&B central.",
      candidate_tasks: [
        { query: "Anyma Eternity", reason: "Old profile anchor", style: "melodic techno" },
        { query: "Martin Garrix Breakaway", reason: "Old EDM anchor", style: "festival EDM" },
      ],
    }),
  };
  const director = new RadioAgentProgramDirector(model, () => NOW);

  const window = await director.plan({
    ...contextSnapshot(),
    memoryFacts: [],
    currentTrack: null,
    readyQueue: [],
    contract: "# Program Contract\nstation_goal: current R&B radio with soft vocal anchors\navoid: high-energy EDM, pure classical piano",
  });

  assert.equal(window.source, "deterministic_fallback");
  assert.ok(window.candidateTasks.length > 0);
  assert.match(window.candidateTasks[0]?.query ?? "", /R&B|vocal/i);
  assert.ok(window.candidateTasks.every((task) => !/Anyma|Martin Garrix/i.test(task.query)));
});

test("fallback planning rewrites raw memory-evidence station goals into listener-facing language", async () => {
  const director = new RadioAgentProgramDirector(null, () => NOW);

  const window = await director.plan({
    ...contextSnapshot(),
    contract: "# Program Contract\nstation_goal: Listener has repeated library evidence for Anyma. Listener has repeated library evidence for Innellea.",
    memoryFacts: [
      {
        uid: "42",
        key: "artist:Anyma",
        kind: "taste_fact",
        value: "Listener has repeated library evidence for Anyma.",
        confidence: 0.91,
        evidenceCount: 6,
        evidenceRefs: ["track:anyma-1"],
        updatedAt: "2026-06-03T01:00:00.000Z",
      },
    ],
  });

  assert.match(window.stationBrief, /Anyma/i);
  assert.doesNotMatch(window.stationBrief, listenerUnsafeProgramTerms);
  assert.doesNotMatch(window.mainDirection, listenerUnsafeProgramTerms);
  for (const task of window.candidateTasks) {
    assert.doesNotMatch(task.reason, listenerUnsafeProgramTerms);
  }
});

test("fallback planning still produces a safe candidate when all anchors are missing", async () => {
  const director = new RadioAgentProgramDirector(null, () => NOW);

  const window = await director.plan({
    ...contextSnapshot(),
    profile: "",
    now: "",
    contract: "",
    memoryFacts: [],
    memoryHypotheses: [],
    currentTrack: null,
    readyQueue: [],
  });

  assert.equal(window.source, "deterministic_fallback");
  assert.ok(window.candidateTasks.length > 0);
  assert.doesNotMatch(window.candidateTasks[0]?.query ?? "", /study|sleep|playlist|timer|white noise/i);
});

test("empty model tasks fall back to deterministic memory anchors", async () => {
  const model: ProgramPlanningModel = {
    chat: async () => JSON.stringify({ candidate_tasks: [{ query: "sleep sounds", reason: "not music programming" }] }),
  };
  const director = new RadioAgentProgramDirector(model, () => NOW);

  const window = await director.plan(contextSnapshot());

  assertFallbackWindow(window);
});

test("fallback planning avoids queries that just failed execution", async () => {
  const director = new RadioAgentProgramDirector(null, () => NOW);

  const window = await director.plan({
    ...contextSnapshot(),
    repair:
      "# Agent Repair\n\n## Evidence\n- SZA\n- Frank Ocean\n\n## Next Attempt\n- Replan with safer concrete R&B songs.",
  });

  assert.ok(window.candidateTasks.length > 0);
  assert.ok(window.candidateTasks.every((task) => !/^SZA$|^Frank Ocean$/i.test(task.query)));
  assert.ok(window.candidateTasks.some((task) => /Daniel Caesar|H\.E\.R\.|Brent Faiyaz/i.test(task.query)));
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
    session: "",
    reflection: "",
    repair: "",
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
  assert.match(prompt, /Listener Session/);
  assert.match(prompt, /Session Reflection/);
  assert.match(prompt, /Listener has repeated library evidence for SZA/);
  assert.match(prompt, /queue_low/);
  assert.match(prompt, /Good Days/);
  assert.match(prompt, /Pink \+ White/);
}

function assertFallbackWindow(window: RadioAgentProgramWindow): void {
  assert.equal(window.uid, "42");
  assert.equal(window.sessionId, 7);
  assert.equal(window.createdAt, NOW);
  assert.equal(window.source, "deterministic_fallback");
  assert.deepEqual(window.traceBasis, traceBasisFromContext(contextSnapshot()));
  assert.match(window.stationBrief, /late-night R&B/i);
  assert.match(window.mainDirection, /SZA/i);
  assert.ok(window.candidateTasks.length >= 2);
  assert.ok(window.candidateTasks.length <= 5);
  assert.match(window.candidateTasks[0]?.query ?? "", /SZA/i);
  assert.match(window.candidateTasks[1]?.query ?? "", /Frank Ocean/i);
  assert.ok(window.candidateTasks.every((task) => task.reason.length > 0));
  assert.doesNotMatch(window.mainDirection, listenerUnsafeProgramTerms);
  assert.doesNotMatch(window.returnRequirement, listenerUnsafeProgramTerms);
  for (const task of window.candidateTasks) {
    assert.doesNotMatch(task.reason, listenerUnsafeProgramTerms);
  }
  assert.ok(window.candidateTasks.every((task) => typeof task.style === "string"));
  assert.ok(window.candidateTasks.every((task) => !/study|sleep|playlist|timer|white noise/i.test(task.query)));
  assert.equal(window.hostIntent.shouldSpeak, true);
  assert.equal(window.hostIntent.event, "return_to_contract");
  assert.match(window.hostIntent.text, /SZA/);
  assert.doesNotMatch(window.hostIntent.text, listenerUnsafeProgramTerms);
}

function traceBasisFromContext(context: RadioAgentContextSnapshot): RadioAgentProgramWindow["traceBasis"] {
  return {
    profile: context.profile,
    now: context.now,
    contract: context.contract,
    session: context.session,
    reflection: context.reflection,
    eventType: context.eventType,
  };
}
