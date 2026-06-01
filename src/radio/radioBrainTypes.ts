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

export type DriftState = "on_contract" | "adjacent" | "bridge" | "off_contract";

export interface StationContract {
  id: string;
  mainDirection: string;
  rawUserText: string;
  allowedAdjacent: string[];
  softBridge: string[];
  disallowed: string[];
  positiveSeeds: string[];
  negativeConstraints: string[];
  driftBudget: number;
  bridgeCount: number;
  mustReturnToContract: boolean;
  hostStyle: "quiet" | "standard" | "companion";
  createdAt: string;
  updatedAt: string;
}

export type BoundaryDecisionStatus =
  | "accept"
  | "accept_as_adjacent"
  | "accept_as_bridge"
  | "reject_off_contract"
  | "reject_entity_mismatch"
  | "reject_low_confidence";

export interface BoundaryDecision {
  status: BoundaryDecisionStatus;
  reason: string;
  contractId?: string;
}

export interface HostNarration {
  event:
    | "station_open"
    | "request_ack"
    | "direction_changed"
    | "bridge_entered"
    | "return_to_contract"
    | "track_explanation"
    | "drift_corrected"
    | "still_planning"
    | "recovery";
  text: string;
  ttsHash?: string;
  spoken: boolean;
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
  contractFit?: string;
  returnPlan?: string;
  narrationCue?: string;
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
  boundaryDecision?: BoundaryDecision;
  narration?: HostNarration;
  createdAt: string;
}
