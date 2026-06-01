import type { MusicTask, StationEnvironment, Track } from "../types.js";

export type ListeningIntentType =
  | "music_direction_request"
  | "specific_track_request"
  | "correction"
  | "negative_feedback"
  | "explanation_question"
  | "preference_update"
  | "continuation"
  | "small_talk";

export interface ListeningIntentDecision {
  type: ListeningIntentType;
  rawText: string;
  query: string;
  positiveSeeds: string[];
  negativeConstraints: string[];
  shouldReplan: boolean;
  shouldClearQueue: boolean;
  shouldExplain: boolean;
  confidence: "low" | "medium" | "high";
  ackText: string;
}

export interface ProfileQuality {
  level: "low_confidence" | "usable" | "strong";
  score: number;
  reasons: string[];
}

export interface RadioEpisodeItem {
  primaryQuery: string;
  backupQueries: string[];
  reason: string;
  style: string;
  energy: string;
  vocality: string;
  fitToProfile: string;
  fitToContext: string;
  avoidBecause: string[];
  musicTask?: MusicTask;
}

export interface RadioEpisode {
  id: string;
  brief: string;
  modeLabel: string;
  arc: string;
  durationTracks: number;
  positiveConstraints: string[];
  negativeConstraints: string[];
  items: RadioEpisodeItem[];
  fallbackPolicy: string;
  hostNotes: string[];
  createdFrom: "startup" | "autoplay" | "user_request" | "correction" | "reflection" | "context_change";
  createdAt: string;
}

export interface DecisionTrace {
  id: string;
  uid: string | null;
  sessionId: number | null;
  episodeId: string;
  intentType: ListeningIntentType | "autoplay";
  profileQuality: ProfileQuality;
  environment: StationEnvironment;
  selectedTrack: Track;
  reason: string;
  rejectedCandidates: string[];
  verificationAttempts: string[];
  fallbackLevel: "episode_primary" | "episode_backup" | "last_episode" | "profile_anchor" | "recent_verified" | "scheduler";
  latencyMs: Record<string, number>;
  hostText: string;
  createdAt: string;
}
