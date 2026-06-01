import assert from "node:assert/strict";
import test from "node:test";

import { EpisodePlanner } from "../../src/radio/episodePlanner.js";
import { EPISODE_PLANNER_TIMEOUT_MS } from "../../src/radio/radioBrainTimings.js";
import type { ListeningIntentDecision, ProfileQuality } from "../../src/radio/radioBrainTypes.js";
import type { StationEnvironment, TasteProfile } from "../../src/types.js";

class FakeLlm {
  calls: Array<{ prompt: string; options: Record<string, unknown> }> = [];

  async chat(prompt: string, options: Record<string, unknown>): Promise<string> {
    this.calls.push({ prompt, options });
    return JSON.stringify({
      brief: "安静无人声的专注工作流。",
      mode_label: "focus instrumental",
      arc: "从极简钢琴到轻微推进的器乐电子。",
      duration_tracks: 4,
      positive_constraints: ["安静", "无人声", "专注"],
      negative_constraints: ["emo", "EDM", "dubstep", "人声"],
      items: [
        {
          primary_query: "Nils Frahm Says",
          backup_queries: ["Max Richter On The Nature Of Daylight", "Olafur Arnalds Near Light"],
          reason: "无人声但有推进感。",
          style: "instrumental focus",
          energy: "low-medium",
          vocality: "instrumental",
          fit_to_profile: "接近用户古典与氛围锚点。",
          fit_to_context: "适合夜晚工作。",
          avoid_because: ["EDM"],
        },
        {
          primary_query: "Ryuichi Sakamoto Energy Flow",
          backup_queries: ["Brian Eno An Ending Ascent"],
          reason: "继续安静器乐线。",
          style: "minimal piano",
          energy: "low",
          vocality: "instrumental",
          fit_to_profile: "贴近钢琴锚点。",
          fit_to_context: "不打断专注。",
          avoid_because: ["人声"],
        },
      ],
      fallback_policy: "Use backups, then profile anchors.",
      host_notes: ["少说话，解释选择时强调无人声和专注。"],
    });
  }
}

class ManyItemsFakeLlm {
  async chat(): Promise<string> {
    return JSON.stringify({
      brief: "Longer flow.",
      mode_label: "capped flow",
      arc: "Keep it steady.",
      duration_tracks: 9,
      positive_constraints: ["steady"],
      negative_constraints: [],
      items: Array.from({ length: 6 }, (_, index) => ({
        primary_query: `Track ${index + 1}`,
        backup_queries: [`Backup ${index + 1}`],
        reason: "fits",
        style: "focus",
        energy: "low",
        vocality: "instrumental",
        fit_to_profile: "ok",
        fit_to_context: "ok",
        avoid_because: [],
      })),
      fallback_policy: "Use backups.",
      host_notes: [],
    });
  }
}

class StaticJsonFakeLlm {
  calls: Array<{ prompt: string; options: Record<string, unknown> }> = [];

  constructor(private readonly data: Record<string, unknown>) {}

  async chat(prompt: string, options: Record<string, unknown>): Promise<string> {
    this.calls.push({ prompt, options });
    return JSON.stringify(this.data);
  }
}

class ThrowingFakeLlm {
  async chat(): Promise<string> {
    throw new Error("planner provider aborted");
  }
}

const intent: ListeningIntentDecision = {
  type: "correction",
  rawText: "不是这种，太电了；我要没有人声的安静专注背景",
  query: "",
  positiveSeeds: ["安静专注工作流"],
  negativeConstraints: ["人声", "EDM", "emo"],
  shouldReplan: true,
  shouldClearQueue: true,
  shouldExplain: false,
  confidence: "high",
  ackText: "懂了。",
};

const environment: StationEnvironment = { scene: "夜晚", localTimeBlock: "night", summary: "夜晚" };
const profile = null as TasteProfile | null;
const profileQuality: ProfileQuality = { level: "low_confidence", score: 0.2, reasons: ["missing_genres"] };

test("episode planner creates an episode shape with backups", async () => {
  const llm = new FakeLlm();
  const planner = new EpisodePlanner(llm as any);

  const episode = await planner.plan({
    uid: "42",
    sessionId: 7,
    intent,
    profile,
    profileQuality,
    environment,
    currentTrack: null,
    playedTracks: [],
    readyTracks: [],
    recentTurns: [],
    createdFrom: "correction",
  });

  assert.equal(episode.modeLabel, "focus instrumental");
  assert.equal(episode.durationTracks, episode.items.length);
  assert.equal(episode.negativeConstraints.includes("EDM"), true);
  assert.equal(episode.items[0]?.primaryQuery, "Nils Frahm Says");
  assert.deepEqual(episode.items[0]?.backupQueries.slice(0, 2), [
    "Max Richter On The Nature Of Daylight",
    "Olafur Arnalds Near Light",
  ]);
  assert.match(llm.calls[0]?.prompt || "", /low_confidence/);
  assert.equal(llm.calls[0]?.options["timeoutMs"], EPISODE_PLANNER_TIMEOUT_MS);
});

test("episode planner includes station contract and parses contract item metadata", async () => {
  const llm = new StaticJsonFakeLlm({
    brief: "Keep the late-night lane.",
    mode_label: "late-night R&B",
    duration_tracks: 3,
    items: [
      {
        primary_query: "SZA Broken Clocks",
        backup_queries: ["H.E.R. Focus"],
        reason: "Keeps the nocturnal R&B tone.",
        contract_fit: "on_contract",
        return_plan: "stay close to late-night R&B",
        narration_cue: "keep the voice low and unhurried",
      },
    ],
  });
  const planner = new EpisodePlanner(llm as any);
  const stationContract = {
    id: "contract-1",
    mainDirection: "late-night R&B",
    rawUserText: "放点深夜听的rnb",
    allowedAdjacent: ["alt-R&B"],
    softBridge: ["ambient electronic"],
    disallowed: ["classical chamber music"],
    positiveSeeds: ["R&B"],
    negativeConstraints: [],
    driftBudget: 1,
    bridgeCount: 0,
    mustReturnToContract: false,
    hostStyle: "standard" as const,
    createdAt: "2026-06-02T00:00:00.000Z",
    updatedAt: "2026-06-02T00:00:00.000Z",
  };

  const episode = await planner.plan({
    uid: "42",
    sessionId: 7,
    intent,
    profile,
    profileQuality,
    environment,
    currentTrack: null,
    playedTracks: [],
    readyTracks: [],
    recentTurns: [],
    createdFrom: "correction",
    stationContract,
  } as any);

  assert.match(llm.calls[0]?.prompt || "", /Station contract:/);
  assert.match(llm.calls[0]?.prompt || "", /late-night R&B/);
  assert.equal((episode.items[0] as any)?.contractFit, "on_contract");
  assert.equal((episode.items[0] as any)?.returnPlan, "stay close to late-night R&B");
  assert.equal((episode.items[0] as any)?.narrationCue, "keep the voice low and unhurried");
});

test("episode planner caps duration and item count at five tracks", async () => {
  const planner = new EpisodePlanner(new ManyItemsFakeLlm() as any);

  const episode = await planner.plan({
    uid: "42",
    sessionId: 7,
    intent,
    profile,
    profileQuality,
    environment,
    currentTrack: null,
    playedTracks: [],
    readyTracks: [],
    recentTurns: [],
    createdFrom: "correction",
  });

  assert.equal(episode.durationTracks, 5);
  assert.equal(episode.items.length, 5);
});

test("episode planner handles nonnumeric duration with two valid items", async () => {
  const planner = new EpisodePlanner(
    new StaticJsonFakeLlm({
      brief: "Broken duration.",
      mode_label: "finite flow",
      arc: "Keep the usable songs.",
      duration_tracks: "four",
      items: [
        { primary_query: "Nils Frahm Says", backup_queries: ["Nils Frahm Some"], reason: "fits" },
        { primary_query: "Ryuichi Sakamoto Energy Flow", backup_queries: ["Ryuichi Sakamoto Merry Christmas"], reason: "fits" },
      ],
    }) as any,
  );

  const episode = await planner.plan({
    uid: "42",
    sessionId: 7,
    intent,
    profile,
    profileQuality,
    environment,
    currentTrack: null,
    playedTracks: [],
    readyTracks: [],
    recentTurns: [],
    createdFrom: "correction",
  });

  assert.equal(Number.isFinite(episode.durationTracks), true);
  assert.equal(episode.durationTracks, 2);
  assert.deepEqual(
    episode.items.map((item) => item.primaryQuery),
    ["Nils Frahm Says", "Ryuichi Sakamoto Energy Flow"],
  );
});

test("episode planner does not let invalid items inflate duration", async () => {
  const planner = new EpisodePlanner(
    new StaticJsonFakeLlm({
      brief: "Some invalid items.",
      mode_label: "filtered flow",
      arc: "Only usable songs count.",
      duration_tracks: 4,
      items: [
        { primary_query: "Nils Frahm Says", backup_queries: ["Nils Frahm Some"], reason: "fits" },
        { primary_query: "   ", backup_queries: ["Blank"], reason: "missing query" },
        { backup_queries: ["No primary"], reason: "missing query" },
        { primary_query: "Ryuichi Sakamoto Energy Flow", backup_queries: ["Ryuichi Sakamoto Merry Christmas"], reason: "fits" },
      ],
    }) as any,
  );

  const episode = await planner.plan({
    uid: "42",
    sessionId: 7,
    intent,
    profile,
    profileQuality,
    environment,
    currentTrack: null,
    playedTracks: [],
    readyTracks: [],
    recentTurns: [],
    createdFrom: "correction",
  });

  assert.equal(episode.items.length, 2);
  assert.equal(episode.durationTracks, 2);
});

test("episode planner recovers empty LLM item lists with concrete intent-aware songs", async () => {
  const planner = new EpisodePlanner(
    new StaticJsonFakeLlm({
      brief: "The LLM understood the request but forgot concrete items.",
      mode_label: "focus instrumental",
      duration_tracks: 4,
      negative_constraints: ["EDM", "dubstep", "emo"],
      items: [],
    }) as any,
  );

  const episode = await planner.plan({
    uid: "42",
    sessionId: 7,
    intent,
    profile,
    profileQuality,
    environment,
    currentTrack: null,
    playedTracks: [],
    readyTracks: [],
    recentTurns: [],
    createdFrom: "correction",
  });

  assert.equal(episode.items.length, 4);
  assert.deepEqual(
    episode.items.map((item) => item.primaryQuery),
    [
      "Nils Frahm Says",
      "Ryuichi Sakamoto Energy Flow",
      "Max Richter On The Nature Of Daylight",
      "Olafur Arnalds Near Light",
    ],
  );
  assert.ok(episode.negativeConstraints.includes("EDM"));
});

test("episode planner recovers provider failure with a concrete fallback episode", async () => {
  const planner = new EpisodePlanner(new ThrowingFakeLlm() as any);

  const episode = await planner.plan({
    uid: "42",
    sessionId: 7,
    intent,
    profile,
    profileQuality,
    environment,
    currentTrack: null,
    playedTracks: [],
    readyTracks: [],
    recentTurns: [],
    createdFrom: "correction",
  });

  assert.equal(episode.modeLabel, "安静专注工作流");
  assert.equal(episode.items.length, 3);
  assert.deepEqual(
    episode.items.map((item) => item.primaryQuery),
    ["Nils Frahm Says", "Ryuichi Sakamoto Energy Flow", "Max Richter On The Nature Of Daylight"],
  );
  assert.match(episode.fallbackPolicy, /planner unavailable/);
});
