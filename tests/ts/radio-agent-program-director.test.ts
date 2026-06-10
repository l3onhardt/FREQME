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

test("fallback planning treats completed track artists as positive behavior anchors", async () => {
  const director = new RadioAgentProgramDirector(null, () => NOW);

  const window = await director.plan({
    ...contextSnapshot(),
    contract: "# Program Contract\nstation_goal: mellow R&B radio",
    profile: "",
    memoryFacts: [],
    memoryHypotheses: [],
    currentTrack: null,
    readyQueue: [],
    reflection:
      "# Session Reflection\n\n## Completed Tracks\n- Skin Tight - Ravyn Lenae (r1)\n- Xtasy - Ravyn Lenae (r2)\n\n## Temporary Avoids\n- generic electronic\n",
  });

  assert.match(window.candidateTasks[0]?.query ?? "", /Ravyn Lenae/i);
  assert.match(window.mainDirection, /Ravyn Lenae/i);
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

test("fallback planning avoids recently skipped track artists as next anchors", async () => {
  const director = new RadioAgentProgramDirector(null, () => NOW);

  const window = await director.plan({
    ...contextSnapshot(),
    contract: "# Program Contract\nstation_goal: mellow R&B radio",
    profile: "",
    memoryFacts: [{ ...contextSnapshot().memoryFacts[0]!, key: "artist:SZA" }],
    memoryHypotheses: [],
    currentTrack: null,
    readyQueue: [],
    reflection:
      "# Session Reflection\n\n## Skipped Tracks\n- Too Much - SZA (bad-1)\n\n## Completed Tracks\n- Japanese Denim - Daniel Caesar (dc1)\n",
  });

  assert.ok(window.candidateTasks.every((task) => !/^SZA$/i.test(task.query)));
  assert.match(window.candidateTasks[0]?.query ?? "", /Daniel Caesar/i);
  assert.ok(window.candidateTasks.every((task) => task.negativeConstraints.some((item) => /SZA|Too Much/i.test(item))));
});

test("fallback planning honors explicit negative artist avoids from session reflection", async () => {
  const director = new RadioAgentProgramDirector(null, () => NOW);

  const window = await director.plan({
    ...contextSnapshot(),
    profile: [
      "# User Profile",
      "",
      "## Stable Taste Facts",
      "- artist:Frank Ocean: Listener has repeated library evidence for Frank Ocean. (confidence: 0.92, evidence: 6)",
      "- artist:SZA: Listener has repeated library evidence for SZA. (confidence: 0.91, evidence: 5)",
      "- artist:Daniel Caesar: Listener has repeated library evidence for Daniel Caesar. (confidence: 0.82, evidence: 3)",
    ].join("\n"),
    memoryFacts: [
      {
        uid: "42",
        key: "artist:Frank Ocean",
        kind: "taste_fact",
        value: "Listener has repeated library evidence for Frank Ocean.",
        confidence: 0.92,
        evidenceCount: 6,
        evidenceRefs: ["track:frank-1"],
        updatedAt: NOW,
      },
      {
        uid: "42",
        key: "artist:SZA",
        kind: "taste_fact",
        value: "Listener has repeated library evidence for SZA.",
        confidence: 0.91,
        evidenceCount: 5,
        evidenceRefs: ["track:sza-1"],
        updatedAt: NOW,
      },
      {
        uid: "42",
        key: "artist:Daniel Caesar",
        kind: "taste_fact",
        value: "Listener has repeated library evidence for Daniel Caesar.",
        confidence: 0.82,
        evidenceCount: 3,
        evidenceRefs: ["track:daniel-1"],
        updatedAt: NOW,
      },
    ],
    memoryHypotheses: [],
    currentTrack: null,
    readyQueue: [],
    reflection:
      "# Session Reflection\n\n## Corrections\n- 不要Frank Ocean，less SZA tonight\n\n## Temporary Avoids\n- Frank Ocean\n- SZA\n",
    contract: "# Program Contract\nstation_goal: mellow personal radio\navoid: high-energy EDM",
  });

  assert.ok(window.candidateTasks.length > 0);
  assert.ok(window.candidateTasks.every((task) => !/Frank Ocean|SZA/i.test(task.query)));
  assert.match(window.candidateTasks[0]?.query ?? "", /Daniel Caesar/i);
  assert.ok(window.candidateTasks.every((task) => task.negativeConstraints.some((item) => /Frank Ocean|SZA/i.test(item))));
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

test("fallback planning uses durable user profile anchors when memory rows are temporarily empty", async () => {
  const director = new RadioAgentProgramDirector(null, () => NOW);

  const window = await director.plan({
    ...contextSnapshot(),
    profile: [
      "# User Profile",
      "",
      "## Stable Taste Facts",
      "- artist:FKA twigs: Listener has repeated library evidence for FKA twigs. (confidence: 0.92, evidence: 6)",
      "- artist:James Blake: Listener returns to James Blake for late-night vocal electronics. (confidence: 0.86, evidence: 4)",
      "",
      "## Hypotheses",
      "- theme:late-night: Playlist titles repeatedly suggest late night; keep this as a hypothesis until behavior confirms it. (confidence: 0.58, evidence: 2)",
    ].join("\n"),
    memoryFacts: [],
    memoryHypotheses: [],
    currentTrack: null,
    readyQueue: [],
    contract: "# Program Contract\nstation_goal: mellow personal radio\navoid: high-energy EDM",
  });

  assert.equal(window.source, "deterministic_fallback");
  assert.deepEqual(
    window.candidateTasks.slice(0, 2).map((task) => task.query),
    ["FKA twigs", "James Blake"],
  );
  assert.match(window.mainDirection, /FKA twigs/i);
  assert.match(window.stationBrief, /FKA twigs|James Blake/i);
  assert.match(window.hostIntent.text, /FKA twigs/i);
  assert.doesNotMatch(window.hostIntent.text, listenerUnsafeProgramTerms);
});

test("fallback planning immediately uses explicit session taste hypotheses", async () => {
  const director = new RadioAgentProgramDirector(null, () => NOW);

  const window = await director.plan({
    ...contextSnapshot(),
    profile: "",
    memoryFacts: [],
    memoryHypotheses: [
      {
        uid: "42",
        key: "session_artist:FKA twigs",
        kind: "taste_hypothesis",
        value: "Listener explicitly asked for more FKA twigs; treat this as a session preference signal until playback confirms it.",
        confidence: 0.64,
        evidenceCount: 1,
        evidenceRefs: ["event:30"],
        updatedAt: NOW,
      },
      {
        uid: "42",
        key: "session_artist:Frank Ocean",
        kind: "taste_hypothesis",
        value: "Listener explicitly asked for more Frank Ocean; treat this as a session preference signal until playback confirms it.",
        confidence: 0.63,
        evidenceCount: 1,
        evidenceRefs: ["event:31"],
        updatedAt: NOW,
      },
    ],
    currentTrack: null,
    readyQueue: [],
    contract: "# Program Contract\nstation_goal: mellow personal radio\navoid: high-energy EDM",
  });

  assert.equal(window.source, "deterministic_fallback");
  assert.deepEqual(
    window.candidateTasks.slice(0, 2).map((task) => task.query),
    ["FKA twigs", "Frank Ocean"],
  );
  assert.match(window.mainDirection, /FKA twigs/i);
  assert.match(window.hostIntent.text, /FKA twigs/i);
  assert.doesNotMatch(window.hostIntent.text, listenerUnsafeProgramTerms);
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

test("fallback planning prioritizes an explicit artist session contract over stale taste anchors", async () => {
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
    ],
    currentTrack: { id: "old-anchor", name: "Pictures Of You", artist: "Anyma" },
    readyQueue: [],
    contract:
      "# Program Contract\nstation_goal: Keep the current radio session centered on Frank Ocean until the listener asks to move elsewhere.\n\n## Allowed Moves\n- Use Frank Ocean as the primary session anchor.\n- Use adjacent artists only when they clearly support the requested artist direction.\n\n## Blocked Moves\n- Do not let older profile anchors override this explicit session request.",
    session:
      "# Listener Session\nactive_request: Frank Ocean\naccepted_direction: Keep this session close to Frank Ocean.\nnext_promise: Stay close to Frank Ocean until the listener asks to move elsewhere.",
  });

  assert.equal(window.source, "deterministic_fallback");
  assert.match(window.candidateTasks[0]?.query ?? "", /Frank Ocean/i);
  assert.doesNotMatch(window.candidateTasks[0]?.query ?? "", /Anyma/i);
  assert.match(window.mainDirection, /Frank Ocean/i);
  assert.doesNotMatch(window.hostIntent.text, /Anyma/i);
});

test("fallback planning turns a fresh R&B session contract into concrete first moves before old anchors", async () => {
  const director = new RadioAgentProgramDirector(null, () => NOW);

  const window = await director.plan({
    ...contextSnapshot(),
    profile: [
      "# User Profile",
      "",
      "## Stable Taste Facts",
      "- artist:Frank Ocean: Listener returns to Frank Ocean for late-night transitions. (confidence: 0.83, evidence: 4)",
      "- artist:SZA: Listener has repeated library evidence for SZA. (confidence: 0.91, evidence: 5)",
    ].join("\n"),
    memoryFacts: contextSnapshot().memoryFacts,
    memoryHypotheses: [],
    currentTrack: { id: "old-anchor", name: "Nights", artist: "Frank Ocean" },
    readyQueue: [],
    contract:
      "# Program Contract\nstation_goal: afternoon R&B with relaxed vocal groove\navoid: classical chamber music, generic electronic",
    session:
      "# Listener Session\nactive_request: afternoon R&B\naccepted_direction: Keep this session centered on relaxed afternoon R&B vocals.\nnext_promise: Stay in R&B until the listener asks to move elsewhere.",
  });

  assert.equal(window.source, "deterministic_fallback");
  assert.match(window.candidateTasks[0]?.query ?? "", /afternoon|R&B|vocal|groove/i);
  assert.doesNotMatch(window.candidateTasks[0]?.query ?? "", /^Frank Ocean$|^SZA$/i);
  assert.ok(window.candidateTasks.some((task) => /Daniel Caesar|H\.E\.R\.|Brent Faiyaz|SZA|Frank Ocean/i.test(task.query)));
  assert.match(window.mainDirection, /afternoon.*R&B|relaxed.*vocal/i);
  assert.match(window.hostIntent.text, /R&B|afternoon/i);
  assert.doesNotMatch(window.hostIntent.text, /profile|model|candidate|trace|JSON/i);
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

test("model planning under an explicit R&B contract rejects ambient and classical style metadata", async () => {
  const model: ProgramPlanningModel = {
    chat: async () => JSON.stringify({
      station_brief: "Current R&B radio with soft vocal anchors.",
      main_direction: "Keep R&B central.",
      candidate_tasks: [
        {
          query: "soft vocal bridge",
          reason: "A pure ambient electronic bridge before returning.",
          style: "ambient electronic",
        },
        {
          query: "quiet late-night vocal texture",
          reason: "Modern classical piano interlude.",
          style: "modern classical instrumental",
        },
      ],
    }),
  };
  const director = new RadioAgentProgramDirector(model, () => NOW);

  const window = await director.plan({
    ...contextSnapshot(),
    memoryFacts: [],
    currentTrack: null,
    readyQueue: [],
    contract: "# Program Contract\nstation_goal: current R&B radio with soft vocal anchors\navoid: high-energy EDM, pure classical piano, ambient electronic",
  });

  assert.equal(window.source, "deterministic_fallback");
  assert.ok(window.candidateTasks.length > 0);
  assert.ok(window.candidateTasks.every((task) => !/ambient|classical|piano|electronic/i.test([task.query, task.reason, task.style].join(" "))));
  assert.match(window.candidateTasks[0]?.query ?? "", /R&B|Daniel Caesar|Frank Ocean|SZA|H\.E\.R\.|Brent Faiyaz/i);
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

test("fallback planning treats the next move after execution repair as recovery", async () => {
  const director = new RadioAgentProgramDirector(null, () => NOW);

  const window = await director.plan({
    ...contextSnapshot(),
    readyQueue: [],
    repair: [
      "# Agent Repair",
      "",
      "## Issue",
      "- Execution could not prepare a playable track: program_executor_no_track.",
      "",
      "## Evidence",
      "- SZA",
      "- Frank Ocean",
      "",
      "## Correction",
      "- Treat the failed queries as weak negative evidence for this pass, then replan with safer concrete songs.",
      "",
      "## Next Attempt",
      "- Replan with safer concrete R&B songs.",
    ].join("\n"),
  });

  assert.equal(window.hostIntent.shouldSpeak, true);
  assert.equal(window.hostIntent.event, "recovery");
  assert.match(window.hostIntent.text, /recover|steady|back|R&B|Daniel Caesar|H\.E\.R\.|Brent Faiyaz/i);
  assert.doesNotMatch(window.hostIntent.text, listenerUnsafeProgramTerms);
  assert.ok(window.candidateTasks.every((task) => !/^SZA$|^Frank Ocean$/i.test(task.query)));
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
