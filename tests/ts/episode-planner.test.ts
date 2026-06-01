import assert from "node:assert/strict";
import test from "node:test";

import { EpisodePlanner } from "../../src/radio/episodePlanner.js";
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

test("episode planner creates a 3 to 5 track episode shape with backups", async () => {
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
  assert.equal(episode.durationTracks >= 3 && episode.durationTracks <= 5, true);
  assert.equal(episode.negativeConstraints.includes("EDM"), true);
  assert.equal(episode.items[0]?.primaryQuery, "Nils Frahm Says");
  assert.deepEqual(episode.items[0]?.backupQueries.slice(0, 2), [
    "Max Richter On The Nature Of Daylight",
    "Olafur Arnalds Near Light",
  ]);
  assert.match(llm.calls[0]?.prompt || "", /low_confidence/);
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
