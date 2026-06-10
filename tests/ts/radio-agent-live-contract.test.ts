import assert from "node:assert/strict";
import test from "node:test";

import { RadioAgentProgramDirector, type ProgramPlanningModel } from "../../src/radio-agent/programDirector.js";
import type { RadioAgentContextSnapshot, RadioAgentMemory, RadioAgentProgramWindow } from "../../src/radio-agent/types.js";

const NOW = "2026-06-11T09:30:00.000Z";

test("agent program windows keep the next three R&B moves inside the explicit contract", async () => {
  const window = await planMixedWindow(
    contractFor({
      goal: "late-night R&B vocal groove",
      allowed: ["R&B vocals", "neo-soul", "alt-R&B"],
      bridgeOnly: ["soft downtempo instrumental"],
      blocked: ["classical chamber music", "ambient electronic", "festival EDM"],
    }),
    [
      { query: "SZA Broken Clocks", reason: "R&B vocal anchor.", style: "R&B vocals" },
      { query: "Daniel Caesar Japanese Denim", reason: "Warm vocal groove.", style: "neo-soul" },
      { query: "H.E.R. Focus", reason: "Quiet R&B continuation.", style: "alt-R&B" },
      { query: "Jon Hopkins A Drifting Down", reason: "Pure ambient bridge.", style: "ambient electronic" },
      { query: "Max Richter On the Nature of Daylight", reason: "Modern classical interlude.", style: "classical chamber music" },
    ],
  );

  assertNextThree(window, [/SZA/i, /Daniel Caesar/i, /H\.E\.R\./i]);
  assertRejects(window, /Jon Hopkins|Max Richter|ambient|classical/i);
});

test("agent program windows keep quiet jazz reading requests out of classical and electronic drift", async () => {
  const window = await planMixedWindow(
    contractFor({
      goal: "quiet jazz for reading",
      allowed: ["quiet jazz", "cool jazz", "small-combo jazz"],
      bridgeOnly: ["soft instrumental texture"],
      blocked: ["classical chamber music", "ambient electronic", "festival EDM"],
    }),
    [
      { query: "Miles Davis Blue in Green", reason: "Quiet jazz anchor.", style: "quiet jazz" },
      { query: "Bill Evans Peace Piece", reason: "Soft piano jazz for reading.", style: "cool jazz" },
      { query: "Chet Baker Almost Blue", reason: "Small-combo late-night jazz.", style: "small-combo jazz" },
      { query: "Brian Eno An Ending", reason: "Soft instrumental texture bridge.", style: "soft instrumental texture" },
      { query: "Max Richter Piano Quintet", reason: "Classical chamber drift.", style: "classical chamber music" },
      { query: "Jon Hopkins Emerald Rush", reason: "Electronic texture.", style: "ambient electronic" },
    ],
  );

  assertNextThree(window, [/Miles Davis/i, /Bill Evans/i, /Chet Baker/i]);
  assertRejects(window, /Brian Eno|Max Richter|Jon Hopkins|soft instrumental texture|classical|electronic/i);
});

test("agent program windows keep quiet focus requests musical without accepting utility audio", async () => {
  const window = await planMixedWindow(
    contractFor({
      goal: "quiet focus instrumental music",
      allowed: ["minimal piano", "modern chamber ambient", "soft instrumental"],
      bridgeOnly: ["low-key ambient texture"],
      blocked: ["white noise", "sleep sounds", "lofi study beats", "festival EDM"],
    }),
    [
      { query: "Nils Frahm Says", reason: "Minimal piano focus piece.", style: "minimal piano" },
      { query: "Olafur Arnalds Near Light", reason: "Soft instrumental focus.", style: "soft instrumental" },
      { query: "Hania Rani Glass", reason: "Modern chamber ambient focus.", style: "modern chamber ambient" },
      { query: "lofi study beats playlist", reason: "Utility playlist filler.", style: "lofi study beats" },
      { query: "white noise for focus", reason: "Utility audio.", style: "white noise" },
    ],
  );

  assertNextThree(window, [/Nils Frahm/i, /Olafur Arnalds/i, /Hania Rani/i]);
  assertRejects(window, /lofi|white noise|playlist/i);
});

test("agent program windows keep Chinese mood requests coherent across the next three moves", async () => {
  const window = await planMixedWindow(
    contractFor({
      goal: "安静一点的华语独立流行，适合晚上放松",
      allowed: ["华语独立流行", "安静民谣", "轻柔女声"],
      bridgeOnly: ["轻器乐过渡"],
      blocked: ["高能电子", "古典室内乐", "睡眠白噪音"],
    }),
    [
      { query: "陈绮贞 旅行的意义", reason: "安静华语独立流行。", style: "华语独立流行" },
      { query: "苏打绿 小情歌", reason: "轻柔华语流行延续。", style: "华语独立流行" },
      { query: "魏如萱 香格里拉", reason: "轻柔女声。", style: "轻柔女声" },
      { query: "Martin Garrix Animals", reason: "高能电子跳走。", style: "高能电子" },
      { query: "巴赫 大提琴组曲", reason: "古典室内乐。", style: "古典室内乐" },
    ],
  );

  assertNextThree(window, [/陈绮贞/i, /苏打绿/i, /魏如萱/i]);
  assertRejects(window, /Martin Garrix|Animals|巴赫|高能电子|古典/i);
});

async function planMixedWindow(contract: string, candidateTasks: Array<{ query: string; reason: string; style: string }>): Promise<RadioAgentProgramWindow> {
  const model: ProgramPlanningModel = {
    chat: async () =>
      JSON.stringify({
        station_brief: "Model-proposed mixed window.",
        main_direction: "Follow the listener request.",
        allowed_adjacent: [],
        bridge_budget: 1,
        disallowed: [],
        return_requirement: "Return to the requested lane after one bridge.",
        candidate_tasks: candidateTasks,
        host_intent: { should_speak: false, event: "silent", reason: "test", text: "" },
      }),
  };
  const director = new RadioAgentProgramDirector(model, () => NOW);
  return await director.plan(contextSnapshot(contract));
}

function contractFor(args: { goal: string; allowed: string[]; bridgeOnly: string[]; blocked: string[] }): string {
  return [
    "# Program Contract",
    "",
    `station_goal: ${args.goal}`,
    "",
    "## Allowed Moves",
    ...args.allowed.map((move) => `- ${move}`),
    "",
    "## Bridge-Only Moves",
    ...args.bridgeOnly.map((move) => `- ${move}`),
    "",
    "## Blocked Moves",
    ...args.blocked.map((move) => `- ${move}`),
  ].join("\n");
}

function assertNextThree(window: RadioAgentProgramWindow, expected: RegExp[]): void {
  assert.ok(window.candidateTasks.length >= 3, "expected at least three compatible tasks");
  for (let index = 0; index < expected.length; index += 1) {
    assert.match(window.candidateTasks[index]?.query ?? "", expected[index]!);
  }
}

function assertRejects(window: RadioAgentProgramWindow, blocked: RegExp): void {
  for (const task of window.candidateTasks) {
    assert.doesNotMatch([task.query, task.reason, task.style, ...(task.negativeConstraints || [])].join(" "), blocked);
  }
}

function contextSnapshot(contract: string): RadioAgentContextSnapshot {
  const memoryFacts: RadioAgentMemory[] = [
    {
      uid: "42",
      key: "artist:SZA",
      kind: "taste_fact",
      value: "Listener has repeated library evidence for SZA.",
      confidence: 0.9,
      evidenceCount: 5,
      evidenceRefs: ["track:sza-1"],
      updatedAt: NOW,
    },
  ];

  return {
    uid: "42",
    sessionId: 7,
    eventType: "queue_low",
    profile: "# User Profile\n- User likes coherent evening radio sessions.",
    now: "# Station Now\nlocal_time_block: evening",
    contract,
    session: "",
    reflection: "",
    repair: "",
    memoryFacts,
    memoryHypotheses: [],
    sessionEvidence: [],
    recentEvents: [],
    currentTrack: null,
    readyQueue: [],
  };
}
