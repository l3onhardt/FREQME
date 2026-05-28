import type { MemoryPack, TasteProfile, UserSettings, DJDecision } from "../types.js";
import type { MemoryStore } from "../storage/memoryStore.js";
import { compactText, normalizeMatchText } from "../utils/text.js";

export class DJMemoryManager {
  constructor(private readonly store: MemoryStore) {}

  buildContextPack(args: {
    uid: string | null;
    sessionId: number | null;
    requestText: string;
    profile: TasteProfile | null;
    userSettings: Partial<UserSettings>;
    playbackContext: Record<string, unknown>;
    recentTurns: Array<Record<string, unknown>>;
  }): MemoryPack {
    const retrieved = args.uid ? this.retrieveRelevantMemories(args.uid, args.requestText) : [];
    const sessionMemory =
      args.uid && args.sessionId ? this.store.getDjSessionMemory(args.uid, args.sessionId) : {};
    return {
      userProfileDigest: this.profileDigest(args.profile),
      sessionWorkingMemory: sessionMemory,
      recentTurns: args.recentTurns.slice(-6),
      retrievedMemories: retrieved,
      playbackContext: args.playbackContext,
      userSettings: args.userSettings,
      hardConstraints: [
        "不要暴露系统、算法、画像或内部字段。",
        "除非用户文本本身就是标准歌名，否则不要搜索用户原句。",
        "点歌失败时要音乐化地恢复，不要把用户原句当失败搜索词复读。",
      ],
    };
  }

  applyDecisionUpdate(uid: string | null, sessionId: number | null, requestText: string, decision: DJDecision): void {
    if (!uid) return;
    this.store.logDjMemoryEvent({
      uid,
      sessionId,
      eventType: "user_request",
      rawText: requestText,
      payload: {
        understoodIntent: decision.understoodIntent,
        musicTask: decision.musicTask,
        memoryUpdate: decision.memoryUpdate,
      },
      importance: decision.action === "negative_feedback" ? 0.85 : 0.62,
    });

    if (sessionId) {
      const existing = this.store.getDjSessionMemory(uid, sessionId);
      const activeMode =
        decision.queuePolicy.continueDirection && decision.queuePolicy.durationTracks > 1
          ? {
              label:
                decision.musicTask.styleHint ||
                decision.musicTask.primaryEntities.map((entity) => entity.name).join(" / ") ||
                decision.understoodIntent,
              understoodIntent: decision.understoodIntent,
              expiresAfterTracks: decision.queuePolicy.durationTracks,
              constraints: decision.musicTask.negativeConstraints,
              seedTask: decision.musicTask,
            }
          : (existing.activeMode as Record<string, unknown> | undefined);
      const currentConstraints = [
        ...((existing.currentConstraints as string[] | undefined) || []),
        ...decision.musicTask.negativeConstraints,
        ...decision.memoryUpdate.negativeConstraints,
      ].slice(-12);
      this.store.saveDjSessionMemory(uid, sessionId, {
        ...existing,
        activeMode,
        currentConstraints,
        lastSuccessfulRequest: requestText,
        updatedAt: new Date().toISOString(),
      });
    }

    for (const item of decision.memoryUpdate.possibleLongTermPreference.slice(0, 3)) {
      const text = compactText(item, 180);
      if (!text) continue;
      const key = normalizeMatchText(text).slice(0, 80);
      this.store.upsertDjUserMemory({
        uid,
        memoryKey: key,
        memoryText: text,
        confidence: 0.55,
        evidenceCount: 1,
        tags: ["preference"],
      });
    }
  }

  logPlaybackEvent(
    eventType: string,
    options: {
      uid?: string | null;
      songId?: string | null;
      reason?: string;
      payload?: Record<string, unknown>;
    } = {},
  ): void {
    this.store.logPlaybackEvent(eventType, options);
  }

  private retrieveRelevantMemories(uid: string, requestText: string): Array<Record<string, unknown>> {
    const memories = this.store.getDjUserMemories(uid, [], 8);
    const normalizedRequest = normalizeMatchText(requestText);
    if (!normalizedRequest) return memories.slice(0, 5);
    return memories
      .sort((left, right) => {
        const l = normalizeMatchText(String(left.memoryText || ""));
        const r = normalizeMatchText(String(right.memoryText || ""));
        const lHit = l && normalizedRequest.includes(l) ? 1 : 0;
        const rHit = r && normalizedRequest.includes(r) ? 1 : 0;
        return rHit - lHit;
      })
      .slice(0, 5);
  }

  private profileDigest(profile: TasteProfile | null): string {
    if (!profile) return "";
    const parts = [
      profile.radioInsights.tasteSummary,
      `熟悉区：${profile.radioInsights.comfortZone.slice(0, 5).join("、")}`,
      `可扩展方向：${profile.radioInsights.discoveryDirection.slice(0, 5).join("、")}`,
      `最近/锚点：${[...profile.anchorTracks.slice(0, 5), ...profile.recentTracks.slice(0, 3)]
        .map((track) => `${track.artist} ${track.name}`.trim())
        .join("、")}`,
      profile.learned.avoidedStyles.length ? `避雷：${profile.learned.avoidedStyles.join("、")}` : "",
    ];
    return compactText(parts.filter(Boolean).join("\n"), 1000);
  }
}

