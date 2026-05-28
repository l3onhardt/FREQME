import assert from "node:assert/strict";
import test from "node:test";

import { DJRequestAgent } from "../../src/radio/djRequestAgent.js";
import type { MemoryPack } from "../../src/types.js";

class FakeLlm {
  calls: Array<{ prompt: string; options: Record<string, unknown> }> = [];

  constructor(private readonly response: string) {}

  async chat(prompt: string, options: Record<string, unknown>): Promise<string> {
    this.calls.push({ prompt, options });
    return this.response;
  }
}

class ThrowingLlm {
  async chat(): Promise<string> {
    throw new Error("llm unavailable");
  }
}

const emptyContext: MemoryPack = {
  userProfileDigest: "long profile ".repeat(200),
  sessionWorkingMemory: { activeDirection: "quiet night radio" },
  recentTurns: [{ user: "play something less noisy" }],
  retrievedMemories: [],
  playbackContext: { currentTrack: { name: "Weird Fishes", artist: "Radiohead" } },
  userSettings: {},
  hardConstraints: [],
};

test("DJ request agent delegates fuzzy artist understanding to LLM JSON", async () => {
  const llm = new FakeLlm(
    JSON.stringify({
      action: "set_direction_and_play",
      understood_intent: "listener wants a Radiohead direction",
      music_task: {
        type: "artist_direction",
        primary_entities: [{ role: "artist", name: "Radiohead" }],
        work_hint: "",
        style_hint: "melancholic art rock",
        negative_constraints: [],
        search_goals: ["Radiohead No Surprises", "Radiohead Karma Police"],
        must_not_search_literal_user_sentence: true,
      },
      queue_policy: { duration_tracks: 4, continue_direction: true, avoid_repetition: true },
      uncertainty: { level: "low", reason: "", should_ask_user: false },
      dj_response: { speak_now: "懂了，往 Radiohead 那种冷一点的方向接。", tone: "warm_confident" },
      memory_update: { session_preference: ["Radiohead"], possible_long_term_preference: [], negative_constraints: [] },
    }),
  );
  const agent = new DJRequestAgent(llm as any);
  const decision = await agent.decide("我要听radiohead", emptyContext);

  assert.equal(llm.calls.length, 1);
  assert.match(llm.calls[0].prompt, /我要听radiohead/);
  assert.match(llm.calls[0].prompt, /currentTrack/);
  assert.equal(llm.calls[0].options["timeoutMs"], 16000);
  assert.ok(llm.calls[0].prompt.length < 4500);
  assert.equal(decision.action, "set_direction_and_play");
  assert.equal(decision.musicTask.type, "artist_direction");
  assert.deepEqual(decision.musicTask.searchGoals, ["Radiohead No Surprises", "Radiohead Karma Police"]);
  assert.equal(decision.musicTask.mustNotSearchLiteralUserSentence, true);
});

test("genre requests like R&B are accepted as executable LLM decisions", async () => {
  const llm = new FakeLlm(
    JSON.stringify({
      action: "set_direction_and_play",
      understoodIntent: "listener wants an R&B direction",
      musicTask: {
        type: "genre_direction",
        primaryEntities: [{ role: "genre", name: "R&B" }],
        workHint: "",
        styleHint: "R&B",
        negativeConstraints: [],
        searchGoals: ["SZA Snooze", "Daniel Caesar Best Part"],
        mustNotSearchLiteralUserSentence: true,
      },
      queuePolicy: { durationTracks: 4, continueDirection: true, avoidRepetition: true },
      uncertainty: { level: "low", reason: "Clear genre request.", shouldAskUser: false },
      djResponse: { speakNow: "可以，往 R&B 的律动里接。", tone: "warm_confident" },
      memoryUpdate: { sessionPreference: ["R&B"], possibleLongTermPreference: [], negativeConstraints: [] },
    }),
  );
  const agent = new DJRequestAgent(llm as any);
  const decision = await agent.decide("我要听rnb", emptyContext);

  assert.equal(decision.action, "set_direction_and_play");
  assert.equal(decision.musicTask.type, "scene_genre_direction");
  assert.equal(decision.musicTask.styleHint, "R&B");
  assert.deepEqual(decision.musicTask.searchGoals, ["SZA Snooze", "Daniel Caesar Best Part"]);
  assert.equal(decision.uncertainty.shouldAskUser, false);
});

test("DJ request agent does not invent local artist decisions when LLM is unavailable", async () => {
  const agent = new DJRequestAgent(new ThrowingLlm() as any);
  const decision = await agent.decide("我要听radiohead", emptyContext);

  assert.equal(decision.action, "ask_clarifying_question");
  assert.equal(decision.musicTask.type, "unclear");
  assert.deepEqual(decision.musicTask.searchGoals, []);
});

test("negative feedback is also interpreted through LLM JSON and remains session-scoped", async () => {
  const llm = new FakeLlm(
    JSON.stringify({
      action: "negative_feedback",
      understood_intent: "listener dislikes the current Chinese pop direction right now",
      music_task: {
        type: "negative_feedback",
        primary_entities: [],
        work_hint: "",
        style_hint: "",
        negative_constraints: ["avoid Chinese pop for this session", "avoid overly commercial ballads"],
        search_goals: ["Massive Attack Teardrop", "Portishead Roads"],
        must_not_search_literal_user_sentence: true,
      },
      queue_policy: { duration_tracks: 5, continue_direction: true, avoid_repetition: true },
      uncertainty: { level: "low", reason: "", should_ask_user: false },
      dj_response: { speak_now: "收到，这个方向先避开，我换得更收一点。", tone: "warm_confident" },
      memory_update: {
        session_preference: [],
        possible_long_term_preference: [],
        negative_constraints: ["avoid Chinese pop for this session"],
      },
    }),
  );
  const agent = new DJRequestAgent(llm as any);
  const decision = await agent.decide("不要这些中文口水歌了", emptyContext);

  assert.equal(decision.action, "negative_feedback");
  assert.equal(decision.musicTask.type, "negative_feedback");
  assert.match(decision.musicTask.negativeConstraints.join(" "), /Chinese pop/);
  assert.deepEqual(decision.memoryUpdate.possibleLongTermPreference, []);
});
