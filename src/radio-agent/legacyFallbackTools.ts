import type { SelectionReason, Track } from "../types.js";
import type { AgentActionContract, FallbackLevel, RadioAgentAction } from "./agentActions.js";
import type { PlaybackGovernorResult } from "./playbackGovernor.js";

export type LegacyFallbackSource = "opening" | "request" | "correction" | "track_end" | "queue_low" | "continuation";

export interface LegacyFallbackCandidate {
  track: Track;
  url: string;
  reason: SelectionReason;
  hostText?: string;
}

export interface LegacyFallbackContext {
  source: LegacyFallbackSource;
  level: FallbackLevel;
  reason: string;
  requestText?: string;
  activeRequestToken?: number | null;
  expectedRequestToken?: number | null;
  contract: AgentActionContract | null;
  currentTrack: Track | null;
  recentTracks: Track[];
  readyQueue: Track[];
}

export type LegacyFallbackResult =
  | { status: "action"; action: RadioAgentAction }
  | { status: "empty"; reason: string }
  | { status: "stale" };

export interface LegacyFallbackToolsDeps {
  candidateSource(context: LegacyFallbackContext): Promise<LegacyFallbackCandidate | null>;
  governCandidate(args: {
    context: LegacyFallbackContext;
    candidate: Track;
    url: string;
    fallbackLevel: FallbackLevel;
    hostText?: string;
  }): Promise<PlaybackGovernorResult>;
}

export interface LegacyFallbackTools {
  fallbackToAction(context: LegacyFallbackContext): Promise<LegacyFallbackResult>;
}

export function createLegacyFallbackTools(deps: LegacyFallbackToolsDeps): LegacyFallbackTools {
  return {
    async fallbackToAction(context) {
      if (
        context.expectedRequestToken != null &&
        context.activeRequestToken != null &&
        context.expectedRequestToken !== context.activeRequestToken
      ) {
        return { status: "stale" };
      }

      const candidate = await deps.candidateSource(context);
      if (!candidate) return { status: "empty", reason: context.reason };

      const governed = await deps.governCandidate({
        context,
        candidate: candidate.track,
        url: candidate.url,
        fallbackLevel: context.level,
        hostText: candidate.hostText,
      });

      if (governed.status === "accepted") {
        return {
          status: "action",
          action: {
            type: "play_now",
            track: governed.track,
            url: governed.url,
            reason: candidate.reason,
            ...(candidate.hostText ? { hostText: candidate.hostText } : {}),
            governanceTrace: governed.trace,
          },
        };
      }

      return {
        status: "action",
        action: {
          type: "honest_not_found",
          contract: context.contract,
          reason: governed.reason,
          searchedQueries: [],
          governanceTrace: governed.trace,
        },
      };
    },
  };
}
