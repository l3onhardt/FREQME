import type { MemoryPack, MusicTask, StationEnvironment } from "../types.js";
import type { DecisionTraceStore } from "./decisionTraceStore.js";
import type { PlaybackQueue } from "./playbackQueue.js";
import type {
  DecisionTrace,
  ListeningIntentType,
  ProfileQuality,
  RadioEpisode,
  RadioEpisodeItem,
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
  isCurrent?: () => boolean;
}

export class QueueWarmer {
  private readonly cursors = new Map<string, number>();
  private readonly inFlight = new Map<string, Promise<void>>();

  constructor(
    private readonly verifier: SearchVerifyAgent,
    private readonly traceStore: DecisionTraceStore,
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
    this.cursors.set(args.episode.id, cursor);
    return added;
  }

  private async tryItem(args: QueueWarmArgs, item: RadioEpisodeItem): Promise<boolean> {
    if (!this.isCurrent(args)) return false;
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
      const traceId = `${args.episode.id}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const hostText = item.reason || args.episode.brief;
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
        latencyMs: { verification: Date.now() - startedAt },
        hostText,
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
      });
      return true;
    }
    return false;
  }

  private isCurrent(args: QueueWarmArgs): boolean {
    return args.isCurrent ? args.isCurrent() : true;
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
}
