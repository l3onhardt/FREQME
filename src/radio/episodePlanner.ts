import type { LLMRouter } from "../services/llmRouter.js";
import type { StationEnvironment, TasteProfile, Track } from "../types.js";
import { asStringList, compactText, dedupe, extractJsonObject } from "../utils/text.js";
import type { ListeningIntentDecision, ProfileQuality, RadioEpisode, RadioEpisodeItem } from "./radioBrainTypes.js";

export interface EpisodePlanArgs {
  uid: string | null;
  sessionId: number | null;
  intent: ListeningIntentDecision;
  profile: TasteProfile | null;
  profileQuality: ProfileQuality;
  environment: StationEnvironment;
  currentTrack: Track | null;
  playedTracks: Track[];
  readyTracks: Track[];
  recentTurns: Array<Record<string, unknown>>;
  createdFrom: RadioEpisode["createdFrom"];
}

export class EpisodePlanner {
  constructor(
    private readonly llm: LLMRouter,
    private readonly llmTimeoutMs = 12000,
  ) {}

  async plan(args: EpisodePlanArgs): Promise<RadioEpisode> {
    const response = await this.llm.chat(this.prompt(args), {
      maxTokens: 1100,
      system: "You are FREQME's private AI radio episode planner. Return only valid JSON.",
      responseFormat: { type: "json_object" },
      timeoutMs: this.llmTimeoutMs,
    });
    const data = extractJsonObject(response);
    const items = this.items(this.field(data, "items", "items"));
    const duration = this.durationTracks(this.field(data, "duration_tracks", "durationTracks"), items.length);
    return {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      brief: compactText(this.field(data, "brief", "brief") || args.intent.ackText, 500),
      modeLabel: compactText(this.field(data, "mode_label", "modeLabel") || args.intent.positiveSeeds.join(" / ") || "AI radio", 120),
      arc: compactText(this.field(data, "arc", "arc") || "", 400),
      durationTracks: duration,
      positiveConstraints: dedupe([...args.intent.positiveSeeds, ...asStringList(this.field(data, "positive_constraints", "positiveConstraints"), 10)]),
      negativeConstraints: dedupe([...args.intent.negativeConstraints, ...asStringList(this.field(data, "negative_constraints", "negativeConstraints"), 12)]),
      items: items.slice(0, duration),
      fallbackPolicy: compactText(this.field(data, "fallback_policy", "fallbackPolicy") || "Use item backups, then profile anchors.", 240),
      hostNotes: asStringList(this.field(data, "host_notes", "hostNotes"), 8),
      createdFrom: args.createdFrom,
      createdAt: new Date().toISOString(),
    };
  }

  private prompt(args: EpisodePlanArgs): string {
    return `Create the next FREQME radio episode. Plan 3 to 5 concrete songs with backup queries.

Intent:
${JSON.stringify(args.intent, null, 2)}

Profile quality:
${JSON.stringify(args.profileQuality, null, 2)}

Profile:
${JSON.stringify(args.profile, null, 2)}

Environment:
${JSON.stringify(args.environment, null, 2)}

Playback:
${JSON.stringify({ currentTrack: args.currentTrack, playedTracks: args.playedTracks.slice(-8), readyTracks: args.readyTracks }, null, 2)}

Return only JSON with brief, mode_label, arc, duration_tracks, positive_constraints, negative_constraints, items, fallback_policy, host_notes. Each item must include primary_query and backup_queries.`;
  }

  private items(value: unknown): RadioEpisodeItem[] {
    if (!Array.isArray(value)) return [];
    return value
      .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object" && !Array.isArray(item)))
      .map((item) => ({
        primaryQuery: compactText(this.field(item, "primary_query", "primaryQuery") || item.query || "", 140),
        backupQueries: asStringList(this.field(item, "backup_queries", "backupQueries"), 5),
        reason: compactText(item.reason || "", 240),
        style: compactText(item.style || "", 120),
        energy: compactText(item.energy || "", 80),
        vocality: compactText(item.vocality || "", 80),
        fitToProfile: compactText(this.field(item, "fit_to_profile", "fitToProfile") || "", 220),
        fitToContext: compactText(this.field(item, "fit_to_context", "fitToContext") || "", 220),
        avoidBecause: asStringList(this.field(item, "avoid_because", "avoidBecause"), 8),
      }))
      .filter((item) => item.primaryQuery);
  }

  private durationTracks(value: unknown, itemCount: number): number {
    const parsed = Number(value);
    const requested = Number.isFinite(parsed) ? Math.trunc(parsed) : itemCount || 3;
    const capped = Math.max(3, Math.min(5, requested));
    return itemCount > 0 ? Math.min(capped, itemCount) : capped;
  }

  private field(source: Record<string, unknown>, snake: string, camel: string): unknown {
    return source[snake] ?? source[camel];
  }
}
