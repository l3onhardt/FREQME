import type { DJMemoryManager } from "./djMemory.js";
import type { DJRequestAgent } from "./djRequestAgent.js";
import type { PlaybackQueue } from "./playbackQueue.js";
import type { SearchVerifyAgent } from "./searchVerifyAgent.js";
import type { DJDecision, TasteProfile, Track, UserSettings } from "../types.js";

export interface QueueDirectorResult {
  status: "queued" | "ask" | "needs_recovery";
  djText: string;
  nextSong?: Track;
  url?: string;
  decision?: DJDecision;
  verification?: Record<string, unknown>;
  recoveryOptions?: Array<Record<string, unknown>>;
}

const playableActions = new Set([
  "play_now",
  "set_direction_and_play",
  "revise_mode_and_play",
  "soft_confirm_and_play",
  "continue_current_mode",
  "negative_feedback",
]);

export class QueueDirector {
  constructor(
    private readonly djAgent: DJRequestAgent,
    private readonly verifier: SearchVerifyAgent,
    private readonly memoryManager: DJMemoryManager,
  ) {}

  async handleSongRequest(args: {
    requestText: string;
    playbackQueue: PlaybackQueue;
    uid: string | null;
    sessionId: number | null;
    profile: TasteProfile | null;
    userSettings: Partial<UserSettings>;
    playbackContext: Record<string, unknown>;
    recentTurns: Array<Record<string, unknown>>;
  }): Promise<QueueDirectorResult> {
    const contextPack = this.memoryManager.buildContextPack(args);
    let decision: DJDecision;
    try {
      decision = await this.djAgent.decide(args.requestText, contextPack);
    } catch {
      return {
        status: "needs_recovery",
        djText: "这句我没接稳，先不乱切歌。",
      };
    }
    this.memoryManager.applyDecisionUpdate(args.uid, args.sessionId, args.requestText, decision);

    if (decision.action === "ask_clarifying_question") {
      return {
        status: "ask",
        djText: this.safeDjText(decision.djResponse.speakNow, "你想听某个歌手，还是这种氛围？"),
        decision,
      };
    }

    if (!playableActions.has(decision.action)) {
      return {
        status: "ask",
        djText: "我需要先确认一下这个方向。",
        decision,
      };
    }

    args.playbackQueue.clearReady();
    if (!this.hasExecutableTask(decision)) {
      return {
        status: "needs_recovery",
        djText: this.recoveryText(decision),
        decision,
      };
    }

    const verification = await this.verifier.verify(decision.musicTask, args.uid, args.requestText, contextPack);
    if (verification.status !== "verified" || !verification.selectedSong || !verification.url) {
      this.memoryManager.logPlaybackEvent("song_request_not_found", {
        uid: args.uid,
        reason: args.requestText,
        payload: {
          requestText: args.requestText,
          failureReason: verification.failureReason || "",
          usedQuery: verification.usedQuery || "",
          diagnostics: verification.diagnostics || {},
        },
      });
      return {
        status: "needs_recovery",
        djText: this.recoveryText(decision),
        decision,
        verification: verification as unknown as Record<string, unknown>,
        recoveryOptions: verification.recoveryOptions,
      };
    }

    const note = verification.verification.versionNote || decision.understoodIntent || "已确认可播放版本。";
    args.playbackQueue.addReady(verification.selectedSong, verification.url, {
      type: "dj_agent_verified",
      text: note,
      understoodIntent: decision.understoodIntent,
      verificationNote: verification.verification.versionNote,
    });
    return {
      status: "queued",
      djText: this.safeDjText(decision.djResponse.speakNow, "接住了，我先放一首确认过的版本。"),
      nextSong: verification.selectedSong,
      url: verification.url,
      decision,
      verification: verification as unknown as Record<string, unknown>,
    };
  }

  private hasExecutableTask(decision: DJDecision): boolean {
    const task = decision.musicTask;
    return Boolean(
      task.searchGoals.length ||
        task.primaryEntities.length ||
        task.workHint ||
        task.styleHint ||
        task.negativeConstraints.length,
    );
  }

  private safeDjText(text: string, fallback: string): string {
    const clean = String(text || "").trim();
    return clean ? clean.slice(0, 240) : fallback;
  }

  private recoveryText(decision: DJDecision): string {
    if (["artist_direction", "artist_work_direction", "specific_track"].includes(decision.musicTask.type)) {
      return "我没拿到足够稳的可播放版本，先不乱放。";
    }
    return "这个方向我没确认到合适的可播放版本，先不硬切。";
  }
}
