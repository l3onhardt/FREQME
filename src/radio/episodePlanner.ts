import type { LLMRouter } from "../services/llmRouter.js";
import type { StationEnvironment, TasteProfile, Track } from "../types.js";
import { asStringList, compactText, dedupe, extractJsonObject } from "../utils/text.js";
import type { ListeningIntentDecision, ProfileQuality, RadioEpisode, RadioEpisodeItem } from "./radioBrainTypes.js";
import { EPISODE_PLANNER_TIMEOUT_MS } from "./radioBrainTimings.js";

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
    private readonly llmTimeoutMs = EPISODE_PLANNER_TIMEOUT_MS,
  ) {}

  async plan(args: EpisodePlanArgs): Promise<RadioEpisode> {
    let plannerUnavailable = false;
    const response = await this.llm
      .chat(this.prompt(args), {
        maxTokens: 1100,
        system: "You are FREQME's private AI radio episode planner. Return only valid JSON.",
        responseFormat: { type: "json_object" },
        timeoutMs: this.llmTimeoutMs,
      })
      .catch(() => {
        plannerUnavailable = true;
        return "";
      });
    const data = response ? extractJsonObject(response) : {};
    const negativeConstraints = dedupe([...args.intent.negativeConstraints, ...asStringList(this.field(data, "negative_constraints", "negativeConstraints"), 12)]);
    let items = this.items(this.field(data, "items", "items"));
    if (!items.length) {
      items = this.fallbackItems(args, negativeConstraints);
    }
    const duration = this.durationTracks(plannerUnavailable ? 3 : this.field(data, "duration_tracks", "durationTracks"), items.length);
    return {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      brief: compactText(this.field(data, "brief", "brief") || args.intent.ackText, 500),
      modeLabel: compactText(this.field(data, "mode_label", "modeLabel") || args.intent.positiveSeeds.join(" / ") || "AI radio", 120),
      arc: compactText(this.field(data, "arc", "arc") || "", 400),
      durationTracks: duration,
      positiveConstraints: dedupe([...args.intent.positiveSeeds, ...asStringList(this.field(data, "positive_constraints", "positiveConstraints"), 10)]),
      negativeConstraints,
      items: items.slice(0, duration),
      fallbackPolicy: compactText(
        plannerUnavailable
          ? "planner unavailable; use conservative local seeds, then item backups."
          : this.field(data, "fallback_policy", "fallbackPolicy") || "Use item backups, then profile anchors.",
        240,
      ),
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

  private fallbackItems(args: EpisodePlanArgs, negativeConstraints: string[]): RadioEpisodeItem[] {
    const direction = [
      args.intent.rawText,
      args.intent.query,
      ...args.intent.positiveSeeds,
      args.environment.scene,
      args.environment.localTimeBlock,
    ]
      .join(" ")
      .toLocaleLowerCase();
    const negative = negativeConstraints.join(" ").toLocaleLowerCase();
    const blocks = (term: string): boolean => negative.includes(term.toLocaleLowerCase());
    const useEmo = /\bemo\b|伤感|难过|丧|情绪/u.test(direction) && !blocks("emo");
    const useRnb = /\br\s*&?\s*b\b|\brnb\b/iu.test(direction) && !blocks("rnb") && !blocks("r&b");
    const queries = useEmo
      ? [
          "Phoebe Bridgers Funeral",
          "Mitski I Bet on Losing Dogs",
          "Lord Huron The Night We Met",
          "Cigarettes After Sex Apocalypse",
          "Daughter Youth",
        ]
      : useRnb
        ? [
            "Daniel Caesar Japanese Denim",
            "Frank Ocean Pink + White",
            "SZA Broken Clocks",
            "H.E.R. Focus",
            "Brent Faiyaz Clouded",
          ]
        : [
            "Nils Frahm Says",
            "Ryuichi Sakamoto Energy Flow",
            "Max Richter On The Nature Of Daylight",
            "Olafur Arnalds Near Light",
            "Brian Eno An Ending Ascent",
          ];

    return queries
      .filter((query) => !this.queryViolatesNegative(query, negativeConstraints))
      .slice(0, 5)
      .map((query, index, list) => ({
        primaryQuery: query,
        backupQueries: list.filter((item) => item !== query).slice(0, 2),
        reason: index === 0 ? args.intent.ackText || "先用一个稳的 AI 兜底方向接住。" : "延续当前 AI 电台方向。",
        style: useEmo ? "late-night emo" : useRnb ? "low-key R&B" : "instrumental focus",
        energy: useEmo ? "low" : "low-medium",
        vocality: useEmo || useRnb ? "vocal" : "mostly instrumental",
        fitToProfile: "LLM episode returned no concrete items, so the host uses a conservative verified seed.",
        fitToContext: args.environment.summary,
        avoidBecause: negativeConstraints,
      }));
  }

  private queryViolatesNegative(query: string, negativeConstraints: string[]): boolean {
    const normalized = query.toLocaleLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/gu, "");
    return negativeConstraints.some((constraint) => {
      const token = constraint.toLocaleLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/gu, "");
      return Boolean(token && normalized.includes(token));
    });
  }

  private field(source: Record<string, unknown>, snake: string, camel: string): unknown {
    return source[snake] ?? source[camel];
  }
}
