import assert from "node:assert/strict";
import test from "node:test";

import { AIStationDirector } from "../../src/radio/stationDirector.js";
import type {
  DJDecision,
  MemoryPack,
  MusicTask,
  SearchVerification,
  StationEnvironment,
  TasteProfile,
  Track,
} from "../../src/types.js";

const profile: TasteProfile = {
  uid: "42",
  musicDna: {
    genres: { "alt-pop": 0.8, emo: 0.7 },
    languageBias: { English: 0.7 },
    energyLevel: "低",
    vocalPreference: "intimate vocals",
  },
  personality: {
    traits: ["late-night melancholy"],
    emotionalResonance: "夜晚情绪陪伴",
  },
  radioInsights: {
    tasteSummary: "偏爱夜晚、低能量、带一点失落感的人声作品。",
    comfortZone: ["Phoebe Bridgers", "Mitski", "The 1975"],
    discoveryDirection: ["slowcore", "indie emo", "sad alt-pop"],
    emotionalHooks: ["Moon Song", "I Know The End"],
    djTalkingPoints: ["说情绪落点，不讲算法。"],
  },
  anchorTracks: [
    { id: "anchor-1", name: "Moon Song", artist: "Phoebe Bridgers" },
    { id: "anchor-2", name: "Your Best American Girl", artist: "Mitski" },
  ],
  recentTracks: [{ id: "recent-1", name: "About You", artist: "The 1975" }],
  likedTrackIds: ["anchor-1", "anchor-2"],
  learned: {
    avoidedLanguages: [],
    avoidedStyles: ["dubstep"],
    skippedTrackIds: [],
    negativeFeedbackCount: 0,
  },
  updatedAt: "2026-06-01T00:00:00.000Z",
};

const environment: StationEnvironment = {
  scene: "深夜",
  localTimeBlock: "late_night",
  timezoneName: "Asia/Shanghai",
  locale: "zh-CN",
  regionHint: "Shanghai",
  weather: {
    condition: "小雨",
    temperatureC: 19,
    windKph: 9,
  },
  summary: "深夜，上海，小雨，19C",
};

const memoryPack: MemoryPack = {
  userProfileDigest: "偏爱夜晚、低能量、带一点失落感的人声作品；避开 dubstep。",
  sessionWorkingMemory: {},
  recentTurns: [{ user: "刚才有点太炸了", result: "skip" }],
  retrievedMemories: [{ memoryText: "晚上更喜欢 emo / sad alt-pop，不要 EDM。" }],
  playbackContext: {},
  userSettings: { localTimeBlock: "late_night", regionHint: "Shanghai" },
  hardConstraints: ["AI owns station planning; tools only execute verified tracks."],
};

class PlanningLlm {
  calls: Array<{ prompt: string; options: Record<string, unknown> }> = [];

  async chat(prompt: string, options: Record<string, unknown>): Promise<string> {
    this.calls.push({ prompt, options });
    assert.match(prompt, /Station Director/);
    return JSON.stringify({
      station_brief: "深夜小雨里的低能量 emo / sad alt-pop，不回到 EDM 或 dubstep。",
      mode_label: "rainy late-night emo",
      duration_tracks: 5,
      negative_constraints: ["EDM", "dubstep", "high BPM club tracks"],
      items: [
        {
          query: "Phoebe Bridgers Moon Song",
          reason: "先用熟悉但不直接糊弄的夜晚情绪锚点接住用户。",
          style: "low-energy emo folk",
        },
        {
          query: "Mitski Your Best American Girl",
          reason: "继续 emo 主线，保持低能量和人声情绪。",
          style: "indie emo",
        },
      ],
      dj_response: "我把电台往深夜小雨里的 emo 收，不再往炸的电子走。",
    });
  }
}

class EmptyPlanLlm {
  async chat(): Promise<string> {
    return JSON.stringify({
      station_brief: "晚上 emo，避开 EDM 和 dubstep。",
      mode_label: "late-night emo",
      duration_tracks: 4,
      negative_constraints: ["EDM", "dubstep"],
      dj_response: "我先按晚上 emo 的方向继续找，不往电子炸场走。",
    });
  }
}

class RequestDjAgent {
  async decide(): Promise<DJDecision> {
    return {
      action: "set_direction_and_play",
      understoodIntent: "用户想听晚上 emo 的歌，并避开炸场电子。",
      musicTask: {
        type: "scene_genre_direction",
        primaryEntities: [
          { role: "scene", name: "晚上" },
          { role: "genre", name: "emo" },
        ],
        workHint: "",
        styleHint: "晚上 emo",
        negativeConstraints: ["EDM", "dubstep"],
        searchGoals: ["late night emo", "sad alt-pop"],
        mustNotSearchLiteralUserSentence: true,
      },
      queuePolicy: { durationTracks: 5, continueDirection: true, avoidRepetition: true },
      uncertainty: { level: "low", reason: "", shouldAskUser: false },
      djResponse: { speakNow: "懂了，我往晚上 emo 的方向收。", tone: "warm_confident" },
      memoryUpdate: {
        sessionPreference: ["晚上 emo"],
        possibleLongTermPreference: [],
        negativeConstraints: ["EDM", "dubstep"],
      },
      rawText: "我想听晚上 emo 的歌",
    };
  }
}

class FakeVerifier {
  tasks: MusicTask[] = [];
  broadTaskCount = 0;

  async verify(task: MusicTask, uid: string | null, rawUserText: string, contextPack?: MemoryPack): Promise<SearchVerification> {
    this.tasks.push(task);
    assert.equal(uid, "42");
    assert.ok(rawUserText === "autoplay" || rawUserText.includes("emo"));
    assert.equal(contextPack?.userProfileDigest, memoryPack.userProfileDigest);
    assert.equal((contextPack?.playbackContext.environment as StationEnvironment | undefined)?.weather?.condition, "小雨");
    if (task.type === "scene_genre_direction") {
      this.broadTaskCount += 1;
      const track =
        this.broadTaskCount === 1
          ? { id: "emo-1", name: "Funeral", artist: "Phoebe Bridgers", source: "planner recovery" }
          : { id: "emo-2", name: "I Bet on Losing Dogs", artist: "Mitski", source: "planner recovery" };
      return this.verified(track, track.source || "planner recovery");
    }
    const query = task.searchGoals[0] || "";
    if (query === "Phoebe Bridgers Moon Song") {
      return this.verified({ id: "moon", name: "Moon Song", artist: "Phoebe Bridgers", source: query }, query);
    }
    if (query === "Mitski Your Best American Girl") {
      return this.verified({ id: "mitski", name: "Your Best American Girl", artist: "Mitski", source: query }, query);
    }
    return {
      status: "not_found",
      verification: {},
      fallbackCandidates: [],
      recoveryOptions: [],
      failureReason: "unexpected query",
      diagnostics: { searchedQueries: [query] },
    };
  }

  private verified(track: Track, query: string): SearchVerification {
    return {
      status: "verified",
      selectedSong: track,
      url: `/api/radio/audio/${track.id}`,
      verification: {
        confidence: 0.93,
        matchedEntities: ["AI station plan"],
        versionNote: `AI planned ${query}`,
        risk: "",
      },
      fallbackCandidates: [],
      recoveryOptions: [],
      usedQuery: query,
    };
  }
}

class FakeMemoryManager {
  events: Array<{ eventType: string; options: Record<string, unknown> }> = [];
  decisions: Array<{ requestText: string; decision: DJDecision }> = [];

  buildContextPack(args?: { playbackContext?: Record<string, unknown> }): MemoryPack {
    return {
      ...memoryPack,
      playbackContext: args?.playbackContext || memoryPack.playbackContext,
    };
  }

  applyDecisionUpdate(uid: string | null, sessionId: number | null, requestText: string, decision: DJDecision): void {
    assert.equal(uid, "42");
    assert.equal(sessionId, 7);
    this.decisions.push({ requestText, decision });
  }

  logPlaybackEvent(eventType: string, options: Record<string, unknown>): void {
    this.events.push({ eventType, options });
  }
}

function basePickArgs(state: ReturnType<AIStationDirector["newSessionState"]>) {
  return {
    state,
    uid: "42",
    sessionId: 7,
    profile,
    userSettings: { localTimeBlock: "late_night", regionHint: "Shanghai" },
    environment,
    currentTrack: null,
    playedTracks: [],
    readyQueue: [],
    recentTurns: [],
  };
}

test("AI station director owns autoplay planning with profile, time, location, and weather context", async () => {
  const llm = new PlanningLlm();
  const verifier = new FakeVerifier();
  const director = new AIStationDirector(llm as any, new RequestDjAgent() as any, verifier as any, new FakeMemoryManager() as any);
  const state = director.newSessionState();

  const first = await director.pickNext(basePickArgs(state));
  const second = await director.pickNext(basePickArgs(state));

  assert.equal(first.status, "queued");
  assert.equal(first.track?.name, "Moon Song");
  assert.equal(first.track?.selectionReason?.type, "ai_station_director");
  assert.equal(second.status, "queued");
  assert.equal(second.track?.name, "Your Best American Girl");
  assert.match(llm.calls[0].prompt, /上海|Shanghai/);
  assert.match(llm.calls[0].prompt, /小雨/);
  assert.match(llm.calls[0].prompt, /低能量/);
  assert.ok(verifier.tasks.every((task) => task.negativeConstraints.includes("dubstep")));
});

test("AI station director replans a user request as a multi-track direction instead of a one-song request", async () => {
  const llm = new PlanningLlm();
  const verifier = new FakeVerifier();
  const memory = new FakeMemoryManager();
  const director = new AIStationDirector(llm as any, new RequestDjAgent() as any, verifier as any, memory as any);
  const state = director.newSessionState();

  const requested = await director.handleUserRequest({
    ...basePickArgs(state),
    requestText: "我想听晚上 emo 的歌",
  });
  const continued = await director.pickNext(basePickArgs(state));

  assert.equal(requested.status, "queued");
  assert.equal(requested.track?.name, "Moon Song");
  assert.equal(requested.djText, "我把电台往深夜小雨里的 emo 收，不再往炸的电子走。");
  assert.equal(continued.status, "queued");
  assert.equal(continued.track?.name, "Your Best American Girl");
  assert.deepEqual(memory.decisions.map((item) => item.requestText), ["我想听晚上 emo 的歌"]);
  assert.ok(verifier.tasks.every((task) => task.searchGoals.every((query) => !/edm|dubstep/i.test(query))));
  assert.ok(state.activePlan?.negativeConstraints.includes("EDM"));
});

test("AI station director keeps ownership with request-agent music task when station window JSON has no items", async () => {
  const verifier = new FakeVerifier();
  const director = new AIStationDirector(new EmptyPlanLlm() as any, new RequestDjAgent() as any, verifier as any, new FakeMemoryManager() as any);
  const state = director.newSessionState();

  const requested = await director.handleUserRequest({
    ...basePickArgs(state),
    requestText: "我想听晚上 emo 的歌",
  });
  const continued = await director.pickNext(basePickArgs(state));

  assert.equal(requested.status, "queued");
  assert.equal(requested.track?.name, "Funeral");
  assert.equal(continued.status, "queued");
  assert.equal(continued.track?.name, "I Bet on Losing Dogs");
  assert.equal(verifier.tasks[0]?.type, "scene_genre_direction");
  assert.equal(verifier.tasks[1]?.type, "scene_genre_direction");
  assert.ok(verifier.tasks.every((task) => task.negativeConstraints.includes("dubstep")));
});
