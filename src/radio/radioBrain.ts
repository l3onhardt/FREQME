import type { MemoryPack, SelectionReason, StationEnvironment, TasteProfile, Track, UserSettings } from "../types.js";
import type { DecisionTraceStore } from "./decisionTraceStore.js";
import type { EpisodePlanner } from "./episodePlanner.js";
import type { HostResponder } from "./hostResponder.js";
import type { IntentRouter } from "./intentRouter.js";
import { PlaybackQueue, type QueueItem } from "./playbackQueue.js";
import { assessProfileQuality } from "./profileQuality.js";
import type { QueueWarmer } from "./queueWarmer.js";
import type { ReflectionLoop, ReflectionMemory } from "./reflectionLoop.js";
import type { ListeningIntentDecision, RadioEpisode, StationContract } from "./radioBrainTypes.js";

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
  traceStore: Pick<DecisionTraceStore, "latestForSession" | "latestForTrack">;
  reflectionLoop: Pick<ReflectionLoop, "record">;
  contractManager?: { update(existing: StationContract | null | undefined, intent: ListeningIntentDecision): StationContract };
  bridgePicker?: (uid: string | null, profile: TasteProfile | null) => Promise<BridgePick | null>;
  onBackgroundPlanFailure?: (failure: {
    uid: string | null;
    sessionId: number | null;
    createdFrom: RadioEpisode["createdFrom"];
    intentType: ListeningIntentDecision["type"] | "autoplay";
    message: string;
    error: unknown;
  }) => void;
}

type PlanAndWarmArgs = RadioBrainArgs & {
  intent: ListeningIntentDecision;
  createdFrom: RadioEpisode["createdFrom"];
  intentType: ListeningIntentDecision["type"] | "autoplay";
  generation: number;
  state: RadioBrainSessionState;
  stateLocator: RadioBrainStateLocator;
  stationContract?: StationContract;
};

interface RadioBrainSessionState {
  generation: number;
  reflectionMemory?: ReflectionMemory;
  stationContract?: StationContract;
}

type RadioBrainStateLocator =
  | { type: "keyed"; key: string }
  | { type: "queue"; queue: PlaybackQueue };

const REFLECTION_EVENT_TYPES = new Set<ListeningIntentDecision["type"]>([
  "correction",
  "negative_feedback",
  "preference_update",
]);

class GenerationGuardedQueue extends PlaybackQueue {
  constructor(
    private readonly realQueue: PlaybackQueue,
    private readonly isCurrent: () => boolean,
  ) {
    super();
  }

  override readyItems(): QueueItem[] {
    return this.realQueue.readyItems();
  }

  override current(): QueueItem | undefined {
    return this.realQueue.current();
  }

  override prewarmNeeded(): number {
    return this.realQueue.prewarmNeeded();
  }

  override addReady(track: Track, url: string, selectionReason: SelectionReason, options: { segueText?: string; ttsHash?: string } = {}): void {
    if (this.isCurrent()) {
      this.realQueue.addReady(track, url, selectionReason, options);
    }
  }

  override promoteNext(previousEvent = "played"): QueueItem | null {
    return this.isCurrent() ? this.realQueue.promoteNext(previousEvent) : null;
  }

  override markCurrent(status: "played" | "skipped"): void {
    if (this.isCurrent()) {
      this.realQueue.markCurrent(status);
    }
  }

  override clearReady(): void {
    if (this.isCurrent()) {
      this.realQueue.clearReady();
    }
  }

  override removeReadyWhere(predicate: (item: QueueItem) => boolean): number {
    return this.isCurrent() ? this.realQueue.removeReadyWhere(predicate) : 0;
  }

  override readyDepth(): number {
    return this.realQueue.readyDepth();
  }
}

export class RadioBrain {
  private static readonly maxKeyedStates = 256;

  private readonly keyedStates = new Map<string, RadioBrainSessionState>();
  private readonly queueStates = new WeakMap<PlaybackQueue, RadioBrainSessionState>();

  constructor(private readonly deps: RadioBrainDeps) {}

  async startSession(args: RadioBrainArgs): Promise<RadioBrainResult> {
    const state = this.stateFor(args);
    this.stationContract(args.contextPack, state);
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
      generation: state.generation,
      state,
      stateLocator: this.stateLocatorFor(args),
      stationContract: state.stationContract,
    });

    return { status: "bridge_ready", hostText: "" };
  }

  async handleUserText(args: UserTextArgs): Promise<RadioBrainResult> {
    const state = this.stateFor(args);
    this.stationContract(args.contextPack, state);
    const intent = this.deps.intentRouter.classify(args.text);

    if (intent.shouldExplain) {
      const trace =
        this.deps.traceStore.latestForTrack(args.uid, args.sessionId, args.currentTrack?.id || "") ||
        this.deps.traceStore.latestForSession(args.uid, args.sessionId);
      return {
        status: "explained",
        hostText: this.deps.responder.explainCurrentTrack(intent, trace),
      };
    }

    if (intent.shouldClearQueue || intent.shouldReplan) {
      state.generation += 1;
    }

    if (intent.shouldClearQueue) {
      this.clearConflictingReady(args.queue, intent);
    }

    if (this.deps.contractManager && intent.shouldReplan) {
      state.stationContract = this.deps.contractManager.update(state.stationContract, intent);
      args.contextPack.sessionWorkingMemory.stationContract = state.stationContract;
    }

    this.recordReflection(args, intent);
    const hostText = this.deps.responder.acknowledge(intent);

    if (intent.shouldReplan) {
      this.startBackgroundPlan({
        ...args,
        intent,
        createdFrom: intent.type === "correction" ? "correction" : "user_request",
        intentType: intent.type,
        generation: state.generation,
        state,
        stateLocator: this.stateLocatorFor(args),
        stationContract: state.stationContract,
      });
    }

    return { status: "acknowledged", hostText };
  }

  private startBackgroundPlan(args: PlanAndWarmArgs): void {
    void this.planAndWarm(args).catch((error) => {
      this.deps.onBackgroundPlanFailure?.({
        uid: args.uid,
        sessionId: args.sessionId,
        createdFrom: args.createdFrom,
        intentType: args.intentType,
        message: error instanceof Error ? error.message : String(error),
        error,
      });
    });
  }

  private async planAndWarm(args: PlanAndWarmArgs): Promise<void> {
    if (!this.deps.planner || !this.deps.warmer) return;
    if (!this.isCurrent(args)) return;

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
      stationContract: args.stationContract,
    });
    if (!this.isCurrent(args)) return;

    await this.deps.warmer.warm({
      queue: new GenerationGuardedQueue(args.queue, () => this.isCurrent(args)),
      episode,
      uid: args.uid,
      sessionId: args.sessionId,
      intentType: args.intentType,
      profileQuality,
      environment: args.environment,
      targetReady: 2,
      contextPack: args.contextPack,
      stationContract: args.stationContract,
      isCurrent: () => this.isCurrent(args),
    });
  }

  private isCurrent(args: Pick<PlanAndWarmArgs, "generation" | "state" | "stateLocator">): boolean {
    if (args.stateLocator.type === "keyed") {
      return this.keyedStates.get(args.stateLocator.key) === args.state && args.generation === args.state.generation;
    }
    return this.queueStates.get(args.stateLocator.queue) === args.state && args.generation === args.state.generation;
  }

  private clearConflictingReady(queue: PlaybackQueue, intent: ListeningIntentDecision): void {
    if (intent.type === "music_direction_request") {
      queue.clearReady();
      return;
    }
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

    const state = this.stateFor(args);
    const existing = this.reflectionMemory(args.contextPack, state);
    const updated = this.deps.reflectionLoop.record({
      existing,
      event: intent.type as "correction" | "negative_feedback" | "preference_update",
      track: args.currentTrack,
      rawText: intent.rawText,
      constraints: intent.negativeConstraints,
    });
    state.reflectionMemory = updated;
    args.contextPack.sessionWorkingMemory.reflectionMemory = updated;
  }

  private reflectionMemory(contextPack: MemoryPack, state: RadioBrainSessionState): ReflectionMemory {
    if (state.reflectionMemory) return state.reflectionMemory;
    const memory = contextPack.sessionWorkingMemory.reflectionMemory;
    if (memory && typeof memory === "object" && !Array.isArray(memory)) return memory as ReflectionMemory;
    return {};
  }

  private stationContract(contextPack: MemoryPack, state: RadioBrainSessionState): StationContract | undefined {
    if (state.stationContract) return state.stationContract;
    const contract = contextPack.sessionWorkingMemory.stationContract;
    if (!contract || typeof contract !== "object" || Array.isArray(contract)) return undefined;
    state.stationContract = contract as StationContract;
    return state.stationContract;
  }

  private stateFor(args: Pick<RadioBrainArgs, "uid" | "sessionId" | "queue">): RadioBrainSessionState {
    const key = this.stableSessionKey(args);
    if (key) {
      const existing = this.keyedStates.get(key);
      if (existing) {
        this.queueStates.delete(args.queue);
        return existing;
      }
      const state = this.queueStates.get(args.queue) || { generation: 0 };
      this.keyedStates.set(key, state);
      this.queueStates.delete(args.queue);
      this.evictOldKeyedStates();
      return state;
    }

    const existing = this.queueStates.get(args.queue);
    if (existing) return existing;
    const state: RadioBrainSessionState = { generation: 0 };
    this.queueStates.set(args.queue, state);
    return state;
  }

  private stableSessionKey(args: Pick<RadioBrainArgs, "uid" | "sessionId">): string | null {
    if (args.uid && args.sessionId !== null) return `${args.uid}/${args.sessionId}`;
    return null;
  }

  private stateLocatorFor(args: Pick<RadioBrainArgs, "uid" | "sessionId" | "queue">): RadioBrainStateLocator {
    const key = this.stableSessionKey(args);
    if (key) return { type: "keyed", key };
    return { type: "queue", queue: args.queue };
  }

  private evictOldKeyedStates(): void {
    while (this.keyedStates.size > RadioBrain.maxKeyedStates) {
      const oldestKey = this.keyedStates.keys().next().value;
      if (!oldestKey) return;
      this.keyedStates.delete(oldestKey);
    }
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
