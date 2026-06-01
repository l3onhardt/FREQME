import type { DJMemoryManager } from "./djMemory.js";
import type { DJRequestAgent } from "./djRequestAgent.js";
import type { SearchVerifyAgent } from "./searchVerifyAgent.js";
import type {
  DJDecision,
  MemoryPack,
  MusicTask,
  StationEnvironment,
  StationPlan,
  StationPlanItem,
  TasteProfile,
  Track,
  UserSettings,
} from "../types.js";
import type { LLMRouter } from "../services/llmRouter.js";
import { asStringList, compactText, dedupe, extractJsonObject, normalizeMatchText } from "../utils/text.js";

export interface StationDirectorState {
  activePlan?: StationPlan;
  cursor: number;
  recentPlans: string[];
  feedbackEvents: Array<Record<string, unknown>>;
}

export interface StationDirectorResult {
  status: "queued" | "ask" | "needs_recovery";
  djText: string;
  track?: Track;
  url?: string;
  plan?: StationPlan;
  decision?: DJDecision;
}

interface BaseArgs {
  state: StationDirectorState;
  uid: string | null;
  sessionId: number | null;
  profile: TasteProfile | null;
  userSettings: Partial<UserSettings>;
  environment: StationEnvironment;
  currentTrack: Track | null;
  playedTracks: Track[];
  readyQueue: Track[];
  recentTurns: Array<Record<string, unknown>>;
}

interface PlanArgs extends BaseArgs {
  requestText?: string;
  decision?: DJDecision;
  contextPack: MemoryPack;
}

export class AIStationDirector {
  constructor(
    private readonly llm: LLMRouter,
    private readonly djAgent: DJRequestAgent,
    private readonly verifier: SearchVerifyAgent,
    private readonly memoryManager: DJMemoryManager,
    private readonly llmTimeoutMs = 14000,
  ) {}

  newSessionState(): StationDirectorState {
    return {
      cursor: 0,
      recentPlans: [],
      feedbackEvents: [],
    };
  }

  async pickNext(args: BaseArgs): Promise<StationDirectorResult> {
    const contextPack = this.contextPack(args, "autoplay");
    if (!args.state.activePlan || args.state.cursor >= args.state.activePlan.items.length) {
      const plan = await this.createPlan({ ...args, contextPack });
      if (!plan) return this.needsRecovery();
      this.activatePlan(args.state, plan);
    }
    return this.pickFromActivePlan(args, contextPack, "autoplay");
  }

  async handleUserRequest(args: BaseArgs & { requestText: string }): Promise<StationDirectorResult> {
    const requestText = compactText(args.requestText, 160);
    const contextPack = this.contextPack(args, requestText);
    let decision: DJDecision;
    try {
      decision = await this.djAgent.decide(requestText, contextPack);
    } catch {
      return {
        status: "needs_recovery",
        djText: "这句我没接稳，先不乱切歌。",
      };
    }
    this.memoryManager.applyDecisionUpdate(args.uid, args.sessionId, requestText, decision);

    if (decision.action === "ask_clarifying_question" || decision.uncertainty.shouldAskUser) {
      return {
        status: "ask",
        djText: compactText(decision.djResponse.speakNow || "你想听某个歌手，还是这种氛围？", 220),
        decision,
      };
    }

    const plan = await this.createPlan({ ...args, requestText, decision, contextPack });
    if (!plan) {
      this.memoryManager.logPlaybackEvent("ai_station_plan_failed", {
        uid: args.uid,
        reason: requestText,
        payload: { decision: this.decisionDiagnostic(decision) },
      });
      return {
        status: "needs_recovery",
        djText: "这个方向我没规划出足够稳的后续，先不硬切。",
        decision,
      };
    }
    this.activatePlan(args.state, plan);
    const picked = await this.pickFromActivePlan(args, contextPack, requestText);
    return {
      ...picked,
      decision,
      djText: picked.djText || plan.djResponse || decision.djResponse.speakNow,
    };
  }

  recordFeedback(state: StationDirectorState, event: Record<string, unknown>): void {
    state.feedbackEvents = [...state.feedbackEvents, { ...event, at: new Date().toISOString() }].slice(-8);
    if (event.type === "skip" || event.type === "negative_feedback") {
      state.activePlan = undefined;
      state.cursor = 0;
    }
  }

  private async createPlan(args: PlanArgs): Promise<StationPlan | null> {
    const response = await this.llm
      .chat(this.planPrompt(args), {
        maxTokens: 780,
        system:
          "You are FREQME's AI Station Director. You own all radio planning. Return only valid JSON and never describe internal systems.",
        responseFormat: { type: "json_object" },
        timeoutMs: this.llmTimeoutMs,
      })
      .catch(() => "");
    const data = extractJsonObject(response);
    let items = this.planItems(data.items);
    const negative = dedupe([
      ...asStringList(this.field(data, "negative_constraints", "negativeConstraints"), 12),
      ...(args.decision?.musicTask.negativeConstraints || []),
      ...(args.profile?.learned.avoidedStyles || []),
    ]);
    const stationBrief = compactText(this.field(data, "station_brief", "stationBrief") || args.decision?.understoodIntent || "", 500);
    const modeLabel = compactText(this.field(data, "mode_label", "modeLabel") || args.decision?.musicTask.styleHint || stationBrief || "AI station", 120);
    const duration = Number(this.field(data, "duration_tracks", "durationTracks") || args.decision?.queuePolicy.durationTracks || items.length);
    if (!items.length) {
      items = this.recoveryItemsFromDecision(args.decision, Math.max(1, Math.min(8, Number.isFinite(duration) ? Math.floor(duration) : 4)), negative);
    }
    if (!items.length) return null;
    const plan: StationPlan = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      stationBrief: stationBrief || modeLabel,
      modeLabel,
      durationTracks: Math.max(1, Math.min(8, Number.isFinite(duration) ? Math.floor(duration) : items.length)),
      negativeConstraints: negative,
      items: items.slice(0, 8),
      djResponse: compactText(this.field(data, "dj_response", "djResponse") || args.decision?.djResponse.speakNow || "", 240),
      source: "ai",
      createdAt: new Date().toISOString(),
    };
    this.memoryManager.logPlaybackEvent("ai_station_plan_created", {
      uid: args.uid,
      reason: args.requestText || "autoplay",
      payload: {
        stationBrief: plan.stationBrief,
        modeLabel: plan.modeLabel,
        durationTracks: plan.durationTracks,
        negativeConstraints: plan.negativeConstraints,
        queries: plan.items.map((item) => item.query),
      },
    });
    return plan;
  }

  private async pickFromActivePlan(args: BaseArgs, contextPack: MemoryPack, rawUserText: string): Promise<StationDirectorResult> {
    const plan = args.state.activePlan;
    if (!plan) return this.needsRecovery();
    const usedQueries = new Set<string>();
    while (args.state.cursor < plan.items.length) {
      const item = plan.items[args.state.cursor];
      args.state.cursor += 1;
      if (!item || usedQueries.has(normalizeMatchText(item.query))) continue;
      usedQueries.add(normalizeMatchText(item.query));
      const task = this.musicTaskForPlanItem(item, plan);
      const verification = await this.verifier.verify(task, args.uid, rawUserText, contextPack);
      if (verification.status !== "verified" || !verification.selectedSong || !verification.url) {
        this.memoryManager.logPlaybackEvent("ai_station_plan_item_failed", {
          uid: args.uid,
          reason: item.query,
          payload: { stationBrief: plan.stationBrief, diagnostics: verification.diagnostics || {} },
        });
        continue;
      }
      const track: Track = {
        ...verification.selectedSong,
        selectionReason: {
          type: "ai_station_director",
          text: item.reason || plan.stationBrief,
          understoodIntent: plan.stationBrief,
          verificationNote: verification.verification.versionNote,
        },
      };
      return {
        status: "queued",
        djText: plan.djResponse,
        track,
        url: verification.url,
        plan,
      };
    }
    args.state.activePlan = undefined;
    args.state.cursor = 0;
    return this.needsRecovery();
  }

  private activatePlan(state: StationDirectorState, plan: StationPlan): void {
    state.activePlan = plan;
    state.cursor = 0;
    state.recentPlans = [plan.stationBrief, ...state.recentPlans.filter((item) => item !== plan.stationBrief)].slice(0, 5);
  }

  private musicTaskForPlanItem(item: StationPlanItem, plan: StationPlan): MusicTask {
    if (item.musicTask) {
      return {
        ...item.musicTask,
        styleHint: item.musicTask.styleHint || item.style || plan.modeLabel || plan.stationBrief,
        negativeConstraints: dedupe([...item.musicTask.negativeConstraints, ...plan.negativeConstraints]),
        mustNotSearchLiteralUserSentence: true,
      };
    }
    return {
      type: "specific_track",
      primaryEntities: [],
      workHint: "",
      styleHint: item.style || plan.modeLabel || plan.stationBrief,
      negativeConstraints: plan.negativeConstraints,
      searchGoals: [item.query],
      mustNotSearchLiteralUserSentence: true,
    };
  }

  private contextPack(args: BaseArgs, requestText: string): MemoryPack {
    return this.memoryManager.buildContextPack({
      uid: args.uid,
      sessionId: args.sessionId,
      requestText,
      profile: args.profile,
      userSettings: args.userSettings,
      playbackContext: {
        currentTrack: args.currentTrack,
        recentTracks: args.playedTracks.slice(-10),
        readyQueue: args.readyQueue.slice(0, 5),
        scene: args.environment.scene,
        environment: args.environment,
      },
      recentTurns: args.recentTurns,
    });
  }

  private planPrompt(args: PlanArgs): string {
    const decision = args.decision ? this.decisionDiagnostic(args.decision) : null;
    const profile = args.profile
      ? {
          tasteSummary: args.profile.radioInsights.tasteSummary,
          comfortZone: args.profile.radioInsights.comfortZone.slice(0, 8),
          discoveryDirection: args.profile.radioInsights.discoveryDirection.slice(0, 8),
          emotionalHooks: args.profile.radioInsights.emotionalHooks.slice(0, 8),
          learned: args.profile.learned,
          recentTracks: args.profile.recentTracks.slice(0, 8),
          anchorTracks: args.profile.anchorTracks.slice(0, 10),
        }
      : null;
    return `Station Director task: create the next AI-owned FREQME radio window.

Product rule:
- AI owns what plays, the style arc, and when to replan.
- NetEase/search/audio tools only execute and verify concrete tracks.
- The listener's liked songs and playlists are taste evidence, not the default playback pool.
- Every item must fit the current brief, environment, profile, and recent feedback.
- If the listener asks for a direction, keep the next several tracks inside that direction unless feedback changes it.
- Use time, location, weather, scene, profile, current track, recent tracks, and session memory to infer what should play.
- Avoid random playlist buckets, bare genres, utility audio, sleep/study mixes, and sudden style resets.

User request:
${args.requestText || "No explicit request; infer a station direction from context."}

Request decision:
${JSON.stringify(decision, null, 2)}

Environment:
${JSON.stringify(args.environment, null, 2)}

Taste profile:
${JSON.stringify(profile, null, 2)}

Memory/context:
${JSON.stringify(
  {
    memory: {
      profileDigest: args.contextPack.userProfileDigest,
      session: args.contextPack.sessionWorkingMemory,
      retrieved: args.contextPack.retrievedMemories,
      recentTurns: args.contextPack.recentTurns,
    },
    playback: {
      currentTrack: args.currentTrack,
      playedTracks: args.playedTracks.slice(-8),
      readyQueue: args.readyQueue.slice(0, 5),
      feedbackEvents: args.state.feedbackEvents,
      recentPlans: args.state.recentPlans,
    },
    settings: args.userSettings,
  },
  null,
  2,
)}

Return only JSON:
{
  "station_brief": "one concrete sentence describing the active radio direction",
  "mode_label": "short label",
  "duration_tracks": 4,
  "negative_constraints": ["styles/sounds to avoid now"],
  "items": [
    {"query": "artist title", "reason": "why this exact next song fits", "style": "specific sound"}
  ],
  "dj_response": "short Chinese line the DJ can say now"
}`;
  }

  private planItems(value: unknown): StationPlanItem[] {
    if (!Array.isArray(value)) return [];
    return value
      .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object" && !Array.isArray(item)))
      .map((item) => ({
        query: compactText(item.query || [item.artist, item.title].filter(Boolean).join(" "), 140),
        reason: compactText(item.reason || "", 240),
        style: compactText(item.style || "", 120),
      }))
      .filter((item) => item.query && !this.looksUnsafeQuery(item.query))
      .slice(0, 8);
  }

  private recoveryItemsFromDecision(decision: DJDecision | undefined, count: number, negativeConstraints: string[]): StationPlanItem[] {
    if (!decision || !this.isExecutableTask(decision.musicTask)) return [];
    const label =
      decision.musicTask.styleHint ||
      decision.musicTask.searchGoals[0] ||
      decision.musicTask.primaryEntities.map((entity) => entity.name).join(" / ") ||
      decision.understoodIntent;
    const musicTask: MusicTask = {
      ...decision.musicTask,
      negativeConstraints: dedupe([...decision.musicTask.negativeConstraints, ...negativeConstraints]),
      mustNotSearchLiteralUserSentence: true,
    };
    return Array.from({ length: Math.max(1, count) }, (_, index) => ({
      query: compactText(label || decision.rawText || `AI direction ${index + 1}`, 140),
      reason: index === 0 ? decision.understoodIntent || "AI 已理解当前点歌方向。" : `继续沿着 ${label || "当前 AI 方向"} 走。`,
      style: decision.musicTask.styleHint,
      musicTask,
    }));
  }

  private isExecutableTask(task: MusicTask): boolean {
    return Boolean(
      task.searchGoals.length ||
        task.primaryEntities.length ||
        task.workHint.trim() ||
        task.styleHint.trim() ||
        task.negativeConstraints.length,
    );
  }

  private looksUnsafeQuery(query: string): boolean {
    const normalized = normalizeMatchText(query);
    if (!normalized) return true;
    if (/^(我想听|想听|我要听|来点|放点|播放|please|play|i want)/iu.test(query)) return true;
    if (/(歌单|playlist|合集|睡眠|study|白噪音|sound effect)/iu.test(query)) return true;
    const ascii = query.match(/[A-Za-z0-9][A-Za-z0-9'.+&-]*/gu) || [];
    const cjk = query.match(/[\u4e00-\u9fff]+/gu) || [];
    return ascii.length + cjk.length < 2;
  }

  private decisionDiagnostic(decision: DJDecision): Record<string, unknown> {
    return {
      action: decision.action,
      understoodIntent: decision.understoodIntent,
      musicTask: decision.musicTask,
      queuePolicy: decision.queuePolicy,
      uncertainty: decision.uncertainty,
    };
  }

  private needsRecovery(): StationDirectorResult {
    return {
      status: "needs_recovery",
      djText: "我还没拿到足够稳的下一首，先不乱放。",
    };
  }

  private field(source: Record<string, unknown>, snake: string, camel: string): unknown {
    return source[snake] ?? source[camel];
  }
}
