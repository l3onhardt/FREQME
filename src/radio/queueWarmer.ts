import type { MemoryPack, MusicTask, StationEnvironment } from "../types.js";
import { dedupe, normalizeMatchText } from "../utils/text.js";
import type { BoundaryGuard } from "./boundaryGuard.js";
import type { DecisionTraceStore } from "./decisionTraceStore.js";
import type { HostNarrationLayer, QueueNarrationResult } from "./hostNarrationLayer.js";
import type { PlaybackQueue } from "./playbackQueue.js";
import type {
  DecisionTrace,
  HostNarration,
  ListeningIntentType,
  ProfileQuality,
  RadioEpisode,
  RadioEpisodeItem,
  StationContract,
} from "./radioBrainTypes.js";
import type { SearchVerifyAgent } from "./searchVerifyAgent.js";

export interface QueueWarmArgs {
  queue: PlaybackQueue;
  episode: RadioEpisode;
  uid: string | null;
  sessionId: number | null;
  intentType: ListeningIntentType | "autoplay";
  profileQuality: ProfileQuality;
  environment: StationEnvironment;
  targetReady: number;
  contextPack: MemoryPack;
  stationContract?: StationContract;
  isCurrent?: () => boolean;
}

export class QueueWarmer {
  private readonly cursors = new Map<string, number>();
  private readonly inFlight = new Map<string, Promise<void>>();

  constructor(
    private readonly verifier: SearchVerifyAgent,
    private readonly traceStore: DecisionTraceStore,
    private readonly boundaryGuard?: Pick<BoundaryGuard, "evaluate">,
    private readonly narrator?: Pick<HostNarrationLayer, "forQueueItem">,
  ) {}

  async warm(args: QueueWarmArgs): Promise<number> {
    if (!this.isCurrent(args)) return 0;
    const previous = this.inFlight.get(args.episode.id) || Promise.resolve();
    const run = previous.then(
      () => this.warmEpisode(args),
      () => this.warmEpisode(args),
    );
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    this.inFlight.set(args.episode.id, tail);
    try {
      return await run;
    } finally {
      if (this.inFlight.get(args.episode.id) === tail) {
        this.inFlight.delete(args.episode.id);
      }
    }
  }

  private async warmEpisode(args: QueueWarmArgs): Promise<number> {
    if (!this.isCurrent(args)) return 0;
    let added = 0;
    let cursor = this.cursors.get(args.episode.id) || 0;
    while (args.queue.readyDepth() < args.targetReady && cursor < args.episode.items.length) {
      if (!this.isCurrent(args)) return added;
      const item = args.episode.items[cursor];
      cursor += 1;
      if (!item) continue;
      const queued = await this.tryItem(args, item);
      if (queued) added += 1;
    }
    if (cursor >= args.episode.items.length) {
      this.cursors.delete(args.episode.id);
    } else {
      this.cursors.set(args.episode.id, cursor);
    }
    return added;
  }

  private async tryItem(args: QueueWarmArgs, item: RadioEpisodeItem): Promise<boolean> {
    if (!this.isCurrent(args)) return false;
    if (this.itemViolatesNegativeConstraints(args.episode, item)) return false;
    const queries = [item.primaryQuery, ...item.backupQueries].filter(Boolean);
    const rejectedCandidates: string[] = [];
    const verificationAttempts: string[] = [];
    const startedAt = Date.now();

    for (let index = 0; index < queries.length; index += 1) {
      if (!this.isCurrent(args)) return false;
      const query = queries[index] || "";
      verificationAttempts.push(query);
      const task = this.taskForQuery(args.episode, item, query);
      const verification = await this.verifier.verify(task, args.uid, "", args.contextPack).catch(() => null);
      if (!this.isCurrent(args)) return false;
      if (!verification || verification.status !== "verified" || !verification.selectedSong || !verification.url) {
        rejectedCandidates.push(query);
        continue;
      }
      if (args.queue.readyDepth() >= args.targetReady) return false;
      if (!this.isCurrent(args)) return false;

      const fallbackLevel: DecisionTrace["fallbackLevel"] = index === 0 ? "episode_primary" : "episode_backup";
      const boundaryDecision = this.boundaryGuard?.evaluate({
        contract: args.stationContract,
        query,
        candidate: verification.selectedSong,
        fallbackLevel,
        itemStyle: item.style,
      }) || { status: "accept" as const, reason: "No boundary guard configured." };
      if (boundaryDecision.status.startsWith("reject_")) {
        rejectedCandidates.push(`${query}: ${boundaryDecision.reason}`);
        continue;
      }

      const traceId = `${args.episode.id}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const hostText = item.reason || args.episode.brief;
      const verificationLatencyMs = Date.now() - startedAt;
      const narrationStartedAt = Date.now();
      const narration = await this.queueNarration(args, boundaryDecision, verification.selectedSong, hostText);
      const narrationLatencyMs = Date.now() - narrationStartedAt;
      if (!this.isCurrent(args)) return false;
      if (args.queue.readyDepth() >= args.targetReady) return false;
      const trace: DecisionTrace = {
        id: traceId,
        uid: args.uid,
        sessionId: args.sessionId,
        episodeId: args.episode.id,
        intentType: args.intentType,
        profileQuality: args.profileQuality,
        environment: args.environment,
        selectedTrack: verification.selectedSong,
        reason: hostText,
        rejectedCandidates,
        verificationAttempts,
        fallbackLevel,
        latencyMs: { verification: verificationLatencyMs, narration: narrationLatencyMs },
        hostText,
        boundaryDecision,
        narration,
        createdAt: new Date().toISOString(),
      };
      this.traceStore.save(trace);
      args.queue.addReady(verification.selectedSong, verification.url, {
        type: "ai_radio_episode",
        text: hostText,
        understoodIntent: args.episode.brief,
        verificationNote: verification.verification.versionNote,
        episodeId: args.episode.id,
        traceId,
        fallbackLevel,
      }, {
        segueText: narration?.text || "",
      });
      this.applyBoundaryDecision(args, boundaryDecision);
      return true;
    }
    return false;
  }

  private isCurrent(args: QueueWarmArgs): boolean {
    return args.isCurrent ? args.isCurrent() : true;
  }

  private async queueNarration(
    args: QueueWarmArgs,
    boundaryDecision: DecisionTrace["boundaryDecision"],
    track: DecisionTrace["selectedTrack"],
    reason: string,
  ): Promise<HostNarration | undefined> {
    if (!this.narrator) return undefined;
    let result: QueueNarrationResult | null = null;
    try {
      result = await this.narrator.forQueueItem({
        stationContract: args.stationContract,
        boundaryDecision,
        track,
        reason,
        recentNarrationCount: 0,
      });
    } catch {
      return undefined;
    }
    if (!result?.shouldSpeak || !result.text) return undefined;
    return {
      event: result.event || "bridge_entered",
      text: result.text,
      spoken: false,
    };
  }

  private applyBoundaryDecision(args: QueueWarmArgs, decision: DecisionTrace["boundaryDecision"]): void {
    if (!args.stationContract) return;
    if (decision?.status === "accept_as_bridge") {
      args.stationContract.bridgeCount += 1;
      args.stationContract.mustReturnToContract = args.stationContract.bridgeCount >= args.stationContract.driftBudget;
      return;
    }
    if (decision?.status === "accept") {
      args.stationContract.bridgeCount = 0;
      args.stationContract.mustReturnToContract = false;
    }
  }

  private taskForQuery(episode: RadioEpisode, item: RadioEpisodeItem, query: string): MusicTask {
    return {
      type: "specific_track",
      primaryEntities: [],
      workHint: "",
      styleHint: item.style || episode.modeLabel,
      negativeConstraints: episode.negativeConstraints,
      searchGoals: [query],
      mustNotSearchLiteralUserSentence: true,
    };
  }

  private itemViolatesNegativeConstraints(episode: RadioEpisode, item: RadioEpisodeItem): boolean {
    const searchable = normalizeMatchText(
      [
        item.primaryQuery,
        item.reason,
        item.style,
        item.energy,
        item.vocality,
      ].join(" "),
    );
    if (!searchable) return false;
    return this.negativeConstraintTokens(episode.negativeConstraints).some((token) => searchable.includes(token));
  }

  private negativeConstraintTokens(constraints: string[]): string[] {
    const tokens: string[] = [];
    for (const constraint of constraints) {
      const normalized = normalizeMatchText(constraint);
      if (!normalized) continue;
      if (normalized === "edm" || normalized === "electronicdancemusic") {
        tokens.push(
          "edm",
          "electronicdancemusic",
          "dubstep",
          "brostep",
          "deephouse",
          "house",
          "futurebass",
          "drumandbass",
          "liquiddrumandbass",
          "dnb",
          "trap",
          "techno",
          "trance",
        );
        continue;
      }
      if (normalized === "dubstep") {
        tokens.push("dubstep", "brostep");
        continue;
      }
      tokens.push(normalized);
    }
    return dedupe(tokens);
  }
}
