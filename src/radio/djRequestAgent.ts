import type { DJDecision, MemoryPack, MusicTask } from "../types.js";
import type { LLMRouter } from "../services/llmRouter.js";
import { asStringList, compactText, extractJsonObject } from "../utils/text.js";

const allowedActions = new Set<DJDecision["action"]>([
  "play_now",
  "set_direction_and_play",
  "revise_mode_and_play",
  "soft_confirm_and_play",
  "ask_clarifying_question",
  "negative_feedback",
  "continue_current_mode",
]);

const playableActions = new Set<DJDecision["action"]>([
  "play_now",
  "set_direction_and_play",
  "revise_mode_and_play",
  "soft_confirm_and_play",
  "continue_current_mode",
  "negative_feedback",
]);

const validTaskTypes = new Set<MusicTask["type"]>([
  "specific_track",
  "artist_direction",
  "artist_work_direction",
  "scene_genre_direction",
  "continuation",
  "negative_feedback",
  "unclear",
]);

export class DJRequestAgent {
  constructor(
    private readonly llm: LLMRouter,
    private readonly llmTimeoutMs = 16000,
  ) {}

  async decide(userMessage: string, contextPack: MemoryPack): Promise<DJDecision> {
    const clean = compactText(userMessage, 500);
    if (!clean) return this.safeQuestion(clean, "Empty request.");

    const response = await this.chatJson(this.prompt(clean, contextPack)).catch(() => "");
    const data = extractJsonObject(response);
    if (!Object.keys(data).length) {
      return this.safeQuestion(clean, "The DJ request agent did not return valid JSON.");
    }
    return this.decisionFromData(clean, data);
  }

  private async chatJson(prompt: string): Promise<string> {
    return this.llm.chat(prompt, {
      maxTokens: 650,
      system:
        "You are FREQME's private AI DJ request agent. Understand the listener's music intent from conversation context and return only valid JSON. Do not keyword-match the request.",
      responseFormat: { type: "json_object" },
      timeoutMs: this.llmTimeoutMs,
    });
  }

  private prompt(userMessage: string, contextPack: MemoryPack): string {
    return `The listener just spoke to an AI radio DJ:
${userMessage}

Compact memory/context JSON:
${JSON.stringify(this.promptContext(contextPack))}

Think like a conversational AI DJ with memory. Infer the real music intent, then return one structured decision.

Rules:
- Do not classify by local keywords. Reason from the whole utterance, session memory, recent turns, current track, profile, and constraints.
- Never ask downstream search to search the literal user sentence unless the sentence itself is already a clean canonical song/work title.
- Fuzzy artists, bands, performers, composers, works, scenes, genres, corrections, refusals, and continuation requests must become structured music tasks.
- A genre/style request is actionable by itself. R&B, jazz, hip-hop, city pop, shoegaze, Cantonese pop, or "quiet night music" should become scene_genre_direction, not a clarification.
- Most requests should play or set a direction; ask only when context still cannot resolve the ambiguity.
- For artist or style directions, add concrete NetEase-friendly search_goals when you can, preferably "artist title"; the search verifier may expand them further.
- For negative feedback, capture immediate constraints without turning one skip into a permanent dislike.
- The DJ response should be short, natural Chinese. Do not mention systems, agents, algorithms, prompts, JSON, search, or models.

Return only JSON:
{
  "action": "play_now | set_direction_and_play | revise_mode_and_play | soft_confirm_and_play | ask_clarifying_question | negative_feedback | continue_current_mode",
  "understood_intent": "internal understanding",
  "music_task": {
    "type": "specific_track | artist_direction | artist_work_direction | scene_genre_direction | negative_feedback | continuation",
    "primary_entities": [{"role": "artist|performer|composer|work|genre|scene|music_entity", "name": "canonical or inferred name"}],
    "work_hint": "",
    "style_hint": "",
    "negative_constraints": ["directions to avoid right now"],
    "search_goals": ["concrete query, preferably artist title"],
    "must_not_search_literal_user_sentence": true
  },
  "queue_policy": {"duration_tracks": 1, "continue_direction": false, "avoid_repetition": true},
  "uncertainty": {"level": "low|medium|high", "reason": "", "should_ask_user": false},
  "dj_response": {"speak_now": "short natural Chinese DJ reply", "tone": "warm_confident"},
  "memory_update": {"session_preference": [], "possible_long_term_preference": [], "negative_constraints": []}
}`;
  }

  private decisionFromData(rawText: string, data: Record<string, unknown>): DJDecision {
    const action = allowedActions.has(data.action as DJDecision["action"])
      ? (data.action as DJDecision["action"])
      : "ask_clarifying_question";
    const musicTask = this.normalizeMusicTask(this.field(data, "music_task", "musicTask"));
    if (playableActions.has(action) && !this.isExecutable(musicTask)) {
      return this.safeQuestion(rawText, "The agent returned a playable action without an executable music task.");
    }
    return {
      action,
      understoodIntent: compactText(this.field(data, "understood_intent", "understoodIntent") || "", 300),
      musicTask,
      queuePolicy: this.normalizeQueuePolicy(this.field(data, "queue_policy", "queuePolicy"), action),
      uncertainty: this.normalizeUncertainty(data.uncertainty, action),
      djResponse: this.normalizeDjResponse(this.field(data, "dj_response", "djResponse")),
      memoryUpdate: this.normalizeMemoryUpdate(this.field(data, "memory_update", "memoryUpdate")),
      rawText,
    };
  }

  private safeQuestion(rawText: string, reason = ""): DJDecision {
    return {
      action: "ask_clarifying_question",
      understoodIntent: "The request was not clear enough to safely choose music.",
      musicTask: {
        type: "unclear",
        primaryEntities: [],
        workHint: "",
        styleHint: "",
        negativeConstraints: [],
        searchGoals: [],
        mustNotSearchLiteralUserSentence: true,
      },
      queuePolicy: { durationTracks: 0, continueDirection: false, avoidRepetition: true },
      uncertainty: { level: "high", reason, shouldAskUser: true },
      djResponse: { speakNow: "这句我没接稳，你是想听某个歌手，还是这种氛围？", tone: "warm_clarifying" },
      memoryUpdate: { sessionPreference: [], possibleLongTermPreference: [], negativeConstraints: [] },
      rawText,
    };
  }

  private normalizeMusicTask(value: unknown): MusicTask {
    const source = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
    const rawType = this.normalizeTaskType(compactText(source.type || "unclear", 40));
    const rawEntities = this.field(source, "primary_entities", "primaryEntities");
    const entities = Array.isArray(rawEntities)
      ? rawEntities
          .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object" && !Array.isArray(item)))
          .map((item) => ({
            role: compactText(item.role || "music_entity", 40) as MusicTask["primaryEntities"][number]["role"],
            name: compactText(item.name || "", 120),
          }))
          .filter((item) => item.name)
          .slice(0, 5)
      : [];
    return {
      type: validTaskTypes.has(rawType) ? rawType : "unclear",
      primaryEntities: entities,
      workHint: compactText(this.field(source, "work_hint", "workHint") || "", 160),
      styleHint: compactText(this.field(source, "style_hint", "styleHint") || "", 180),
      negativeConstraints: asStringList(this.field(source, "negative_constraints", "negativeConstraints"), 10),
      searchGoals: asStringList(this.field(source, "search_goals", "searchGoals"), 8),
      mustNotSearchLiteralUserSentence: true,
    };
  }

  private normalizeQueuePolicy(value: unknown, action: DJDecision["action"]): DJDecision["queuePolicy"] {
    const source = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
    const duration = Number(this.field(source, "duration_tracks", "durationTracks") ?? (action === "play_now" ? 1 : 4));
    const continueDirection = this.field(source, "continue_direction", "continueDirection");
    const avoidRepetition = this.field(source, "avoid_repetition", "avoidRepetition");
    return {
      durationTracks: Math.max(0, Math.min(8, Number.isFinite(duration) ? Math.floor(duration) : 1)),
      continueDirection: typeof continueDirection === "boolean" ? continueDirection : action !== "play_now",
      avoidRepetition: typeof avoidRepetition === "boolean" ? avoidRepetition : true,
    };
  }

  private normalizeUncertainty(value: unknown, action: DJDecision["action"]): DJDecision["uncertainty"] {
    const source = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
    const level = source.level === "low" || source.level === "high" ? source.level : "medium";
    const shouldAskUser = this.field(source, "should_ask_user", "shouldAskUser");
    return {
      level,
      reason: compactText(source.reason || "", 160),
      shouldAskUser: typeof shouldAskUser === "boolean" ? shouldAskUser : action === "ask_clarifying_question",
    };
  }

  private normalizeDjResponse(value: unknown): DJDecision["djResponse"] {
    const source = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
    return {
      speakNow: compactText(this.field(source, "speak_now", "speakNow") || "我先按我理解到的方向接上。", 180),
      tone: compactText(source.tone || "warm_confident", 60),
    };
  }

  private normalizeMemoryUpdate(value: unknown): DJDecision["memoryUpdate"] {
    const source = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
    return {
      sessionPreference: asStringList(this.field(source, "session_preference", "sessionPreference"), 8),
      possibleLongTermPreference: asStringList(this.field(source, "possible_long_term_preference", "possibleLongTermPreference"), 8),
      negativeConstraints: asStringList(this.field(source, "negative_constraints", "negativeConstraints"), 8),
    };
  }

  private isExecutable(task: MusicTask): boolean {
    return Boolean(
      task.searchGoals.length ||
        task.primaryEntities.length ||
        task.workHint.trim() ||
        task.styleHint.trim() ||
        task.negativeConstraints.length,
    );
  }

  private promptContext(contextPack: MemoryPack): Record<string, unknown> {
    const playback = contextPack.playbackContext || {};
    const settings = contextPack.userSettings || {};
    return {
      profile: compactText(contextPack.userProfileDigest, 650),
      session: this.compactJson(contextPack.sessionWorkingMemory, 650),
      recentTurns: contextPack.recentTurns.slice(-4),
      memories: contextPack.retrievedMemories.slice(0, 4),
      playback: {
        currentTrack: (playback as Record<string, unknown>).currentTrack,
        recentTracks: Array.isArray((playback as Record<string, unknown>).recentTracks)
          ? ((playback as Record<string, unknown>).recentTracks as unknown[]).slice(-5)
          : [],
        scene: (playback as Record<string, unknown>).scene,
      },
      settings: {
        currentMode: settings.currentMode,
        musicNotes: compactText(settings.musicNotes || "", 220),
        timezoneName: settings.timezoneName,
        locale: settings.locale,
        regionHint: settings.regionHint,
        localTimeBlock: settings.localTimeBlock,
      },
      constraints: contextPack.hardConstraints.slice(0, 5),
    };
  }

  private compactJson(value: unknown, maxLength: number): string {
    return compactText(JSON.stringify(value ?? {}), maxLength);
  }

  private field(source: Record<string, unknown>, snake: string, camel: string): unknown {
    return source[snake] ?? source[camel];
  }

  private normalizeTaskType(value: string): MusicTask["type"] {
    const aliases: Record<string, MusicTask["type"]> = {
      genre_direction: "scene_genre_direction",
      style_direction: "scene_genre_direction",
      mood_direction: "scene_genre_direction",
      scene_direction: "scene_genre_direction",
      artist: "artist_direction",
      track: "specific_track",
      song: "specific_track",
    };
    return (aliases[value] || value) as MusicTask["type"];
  }
}
