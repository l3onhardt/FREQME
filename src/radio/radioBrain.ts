import type { MemoryPack, StationEnvironment, TasteProfile, Track, UserSettings } from "../types.js";
import type { DecisionTraceStore } from "./decisionTraceStore.js";
import type { EpisodePlanner } from "./episodePlanner.js";
import type { HostResponder } from "./hostResponder.js";
import type { IntentRouter } from "./intentRouter.js";
import type { PlaybackQueue, QueueItem } from "./playbackQueue.js";
import { assessProfileQuality } from "./profileQuality.js";
import type { QueueWarmer } from "./queueWarmer.js";
import type { ReflectionLoop, ReflectionMemory } from "./reflectionLoop.js";
import type { ListeningIntentDecision, RadioEpisode } from "./radioBrainTypes.js";

export type RadioBrainResultStatus = "bridge_ready" | "explained" | "acknowledged" | "queued" | "not_found";

export interface RadioBrainResult {
  status: RadioBrainResultStatus;
  hostText: string;
}

export interface BridgePick {
  track: Track;
  url: string;
  reason: string;
}

export interface RadioBrainArgs {
  queue: PlaybackQueue;
  uid: string | null;
  sessionId: number | null;
  profile: TasteProfile | null;
  settings: Partial<UserSettings>;
  environment: StationEnvironment;
  currentTrack: Track | null;
  playedTracks: Track[];
  recentTurns: Array<Record<string, unknown>>;
  contextPack: MemoryPack;
}

export interface UserTextArgs extends RadioBrainArgs {
  text: string;
}

export interface RadioBrainDeps {
  intentRouter: Pick<IntentRouter, "classify">;
  planner?: Pick<EpisodePlanner, "plan">;
  warmer?: Pick<QueueWarmer, "warm">;
  responder: Pick<HostResponder, "acknowledge" | "explainCurrentTrack">;
  traceStore: Pick<DecisionTraceStore, "latestForSession">;
  reflectionLoop: Pick<ReflectionLoop, "record">;
  bridgePicker?: (uid: string | null, profile: TasteProfile | null) => Promise<BridgePick | null>;
}

type PlanAndWarmArgs = RadioBrainArgs & {
  intent: ListeningIntentDecision;
  createdFrom: RadioEpisode["createdFrom"];
  intentType: ListeningIntentDecision["type"] | "autoplay";
  generation: number;
};

const REFLECTION_EVENT_TYPES = new Set<ListeningIntentDecision["type"]>([
  "correction",
  "negative_feedback",
  "preference_update",
]);

export class RadioBrain {
  private generation = 0;
  private reflectionMemoryState: ReflectionMemory = {};

  constructor(private readonly deps: RadioBrainDeps) {}

  async startSession(args: RadioBrainArgs): Promise<RadioBrainResult> {
    if (args.queue.readyDepth() === 0 && this.deps.bridgePicker) {
      const bridge = await this.deps.bridgePicker(args.uid, args.profile);
      if (bridge) {
        args.queue.addReady(bridge.track, bridge.url, {
          type: "startup_bridge",
          text: bridge.reason,
        });
      }
    }

    this.startBackgroundPlan({
      ...args,
      intent: this.startupIntent(),
      createdFrom: "startup",
      intentType: "autoplay",
      generation: this.generation,
    });

    return { status: "bridge_ready", hostText: "" };
  }

  async handleUserText(args: UserTextArgs): Promise<RadioBrainResult> {
    const intent = this.deps.intentRouter.classify(args.text);

    if (intent.shouldExplain) {
      const trace = this.deps.traceStore.latestForSession(args.uid, args.sessionId);
      return {
        status: "explained",
        hostText: this.deps.responder.explainCurrentTrack(intent, trace),
      };
    }

    if (intent.shouldClearQueue || intent.shouldReplan) {
      this.generation += 1;
    }

    if (intent.shouldClearQueue) {
      this.clearConflictingReady(args.queue, intent);
    }

    this.recordReflection(args, intent);
    const hostText = this.deps.responder.acknowledge(intent);

    if (intent.shouldReplan) {
      this.startBackgroundPlan({
        ...args,
        intent,
        createdFrom: intent.type === "correction" ? "correction" : "user_request",
        intentType: intent.type,
        generation: this.generation,
      });
    }

    return { status: "acknowledged", hostText };
  }

  private startBackgroundPlan(args: PlanAndWarmArgs): void {
    void this.planAndWarm(args).catch(() => undefined);
  }

  private async planAndWarm(args: PlanAndWarmArgs): Promise<void> {
    if (!this.deps.planner || !this.deps.warmer) return;
    if (args.generation !== this.generation) return;

    const profileQuality = assessProfileQuality(args.profile);
    const episode = await this.deps.planner.plan({
      uid: args.uid,
      sessionId: args.sessionId,
      intent: args.intent,
      profile: args.profile,
      profileQuality,
      environment: args.environment,
      currentTrack: args.currentTrack,
      playedTracks: args.playedTracks,
      readyTracks: args.queue.readyItems().map((item) => item.track),
      recentTurns: args.recentTurns,
      createdFrom: args.createdFrom,
    });
    if (args.generation !== this.generation) return;

    await this.deps.warmer.warm({
      queue: args.queue,
      episode,
      uid: args.uid,
      sessionId: args.sessionId,
      intentType: args.intentType,
      profileQuality,
      environment: args.environment,
      targetReady: 2,
      contextPack: args.contextPack,
    });
  }

  private clearConflictingReady(queue: PlaybackQueue, intent: ListeningIntentDecision): void {
    const normalizedConstraints = intent.negativeConstraints.map((constraint) => constraint.trim().toLocaleLowerCase()).filter(Boolean);
    if (!normalizedConstraints.length) {
      if (intent.type === "correction" || intent.type === "negative_feedback") {
        queue.clearReady();
      }
      return;
    }

    queue.removeReadyWhere((item) => this.conflictsWithConstraints(item, normalizedConstraints));
  }

  private conflictsWithConstraints(item: QueueItem, normalizedConstraints: string[]): boolean {
    const reason = item.selectionReason;
    const searchable = [reason.text, reason.understoodIntent, reason.fallbackLevel]
      .filter((value): value is string => Boolean(value))
      .join(" ")
      .toLocaleLowerCase();

    return normalizedConstraints.some((constraint) => this.matchesConstraint(searchable, constraint));
  }

  private matchesConstraint(searchable: string, constraint: string): boolean {
    if (/^[a-z0-9]+$/i.test(constraint)) {
      return new RegExp(`(?<![a-z0-9])${this.escapeRegExp(constraint)}(?![a-z0-9])`, "i").test(searchable);
    }
    return searchable.includes(constraint);
  }

  private escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  private recordReflection(args: RadioBrainArgs, intent: ListeningIntentDecision): void {
    if (!REFLECTION_EVENT_TYPES.has(intent.type)) return;

    const existing = this.reflectionMemory(args.contextPack);
    const updated = this.deps.reflectionLoop.record({
      existing,
      event: intent.type as "correction" | "negative_feedback" | "preference_update",
      track: args.currentTrack,
      rawText: intent.rawText,
      constraints: intent.negativeConstraints,
    });
    this.reflectionMemoryState = updated;
    args.contextPack.sessionWorkingMemory.reflectionMemory = updated;
  }

  private reflectionMemory(contextPack: MemoryPack): ReflectionMemory {
    if (Object.keys(this.reflectionMemoryState).length) return this.reflectionMemoryState;
    const memory = contextPack.sessionWorkingMemory.reflectionMemory;
    if (memory && typeof memory === "object" && !Array.isArray(memory)) return memory as ReflectionMemory;
    return {};
  }

  private startupIntent(): ListeningIntentDecision {
    return {
      type: "continuation",
      rawText: "",
      query: "",
      positiveSeeds: [],
      negativeConstraints: [],
      shouldReplan: true,
      shouldClearQueue: false,
      shouldExplain: false,
      confidence: "medium",
      ackText: "",
    };
  }
}
