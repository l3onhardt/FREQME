import type { DecisionTrace } from "../radio/radioBrainTypes.js";
import type { SelectionReason, Track } from "../types.js";

export type RadioAgentPriority = "hot" | "warm" | "cold";
export type RadioAgentMode = "shadow" | "assisted" | "active";
export type RadioAgentCapabilityState = "available" | "degraded" | "disabled";

export type RadioAgentEventType =
  | "login_completed"
  | "session_restored"
  | "library_scan_requested"
  | "library_scan_completed"
  | "radio_agent_library_scan_failed"
  | "profile_artifacts_refreshed"
  | "station_context_refreshed"
  | "playback_started"
  | "playback_progress"
  | "track_completed"
  | "track_skipped"
  | "queue_low"
  | "program_track_queued"
  | "program_repair_needed"
  | "playback_recovery_needed"
  | "user_text"
  | "tts_completed"
  | "idle_tick"
  | "weather_updated"
  | "location_updated";

export interface RadioAgentEvent {
  id?: number;
  uid: string | null;
  sessionId?: number | null;
  type: RadioAgentEventType;
  priority: RadioAgentPriority;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface RadioAgentMemory {
  uid: string;
  key: string;
  kind: string;
  value: string;
  confidence: number;
  evidenceCount: number;
  evidenceRefs: string[];
  updatedAt: string;
}

export interface RadioLibraryPlaylist {
  uid: string;
  playlistId: string;
  name: string;
  raw: Record<string, unknown>;
  scannedAt: string;
}

export interface RadioLibraryTrack {
  uid: string;
  playlistId: string;
  songId: string;
  songName: string;
  artist: string;
  album: string;
  source: Record<string, unknown>;
  scannedAt: string;
}

export interface RadioProfileArtifact {
  uid: string;
  artifactKey: string;
  content: string;
  sourceVersion: string;
  updatedAt: string;
}

export interface RadioHostDecision {
  shouldSpeak: boolean;
  event: string;
  reason: string;
  text?: string;
}

export interface RadioAgentCandidateTask {
  query: string;
  reason: string;
  style: string;
  negativeConstraints: string[];
}

export interface RadioAgentHostIntent {
  shouldSpeak: boolean;
  event:
    | "station_open"
    | "request_ack"
    | "bridge_entered"
    | "return_to_contract"
    | "explanation"
    | "correction"
    | "recovery"
    | "silent";
  reason: string;
  text: string;
}

export interface RadioAgentProgramWindow {
  id: string;
  uid: string | null;
  sessionId: number | null;
  stationBrief: string;
  mainDirection: string;
  allowedAdjacent: string[];
  bridgeBudget: number;
  disallowed: string[];
  returnRequirement: string;
  candidateTasks: RadioAgentCandidateTask[];
  hostIntent: RadioAgentHostIntent;
  currentTrack?: Track | null;
  recentTracks?: Track[];
  readyQueue?: Track[];
  traceBasis: {
    profile: string;
    now: string;
    contract: string;
    session?: string;
    reflection?: string;
    eventType: RadioAgentEventType;
  };
  source: "model" | "deterministic_fallback";
  createdAt: string;
}

export interface RadioAgentPreparedTrack {
  track: Track;
  url: string;
  selectionReason: SelectionReason;
  segueText: string;
  decisionTrace: DecisionTrace;
}

export interface RadioAgentProgramExecutionDiagnostics {
  latestAttemptedQueries(): string[];
}

export interface RadioShadowDecision {
  id: string;
  uid: string | null;
  sessionId?: number | null;
  decisionType: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface RadioAgentReadiness {
  mode: RadioAgentMode;
  planner: RadioAgentCapabilityState;
  speech: RadioAgentCapabilityState;
  summary: string;
}

export interface RadioAgentGovernanceSummary {
  status: "accepted" | "rejected";
  contractId: string | null;
  requestToken: number | null;
  candidateKey: string;
  decision: string;
  evidence: string[];
  fallbackLevel?: string;
}

export interface RadioAgentStatus {
  mode: RadioAgentMode;
  uid: string | null;
  sessionId?: number | null;
  controlsPlayback: boolean;
  readiness: RadioAgentReadiness;
  recentEvents: RadioAgentEvent[];
  recentDecisions: RadioShadowDecision[];
  artifacts: Record<string, { updatedAt: string; sourceVersion: string }>;
  explainability?: {
    contract?: {
      stationGoal: string;
      allowedMoves: string[];
      blockedMoves: string[];
    };
    journal?: {
      observation: string;
      interpretation: string;
      action: string;
      nextCheck: string;
    };
    repair?: {
      issue: string;
      correction: string;
      nextAttempt: string;
    };
  };
  governance?: {
    lastAccepted?: RadioAgentGovernanceSummary;
    lastRejected?: RadioAgentGovernanceSummary;
  };
}

export interface RadioAgentHandleResult {
  controlsPlayback: boolean;
  event: RadioAgentEvent;
  hostDecision?: RadioHostDecision;
  programWindow?: RadioAgentProgramWindow;
}

export interface RadioAgentContextSnapshot {
  uid: string | null;
  sessionId: number | null;
  eventType: RadioAgentEventType;
  profile: string;
  now: string;
  contract: string;
  session: string;
  reflection: string;
  repair: string;
  memoryFacts: RadioAgentMemory[];
  memoryHypotheses: RadioAgentMemory[];
  sessionEvidence: RadioAgentMemory[];
  recentEvents: RadioAgentEvent[];
  currentTrack: Track | null;
  recentTracks: Track[];
  readyQueue: Track[];
}

const HOT_EVENTS = new Set<RadioAgentEventType>([
  "login_completed",
  "session_restored",
  "user_text",
  "track_skipped",
]);

const WARM_EVENTS = new Set<RadioAgentEventType>([
  "playback_started",
  "track_completed",
  "queue_low",
  "program_track_queued",
  "program_repair_needed",
  "playback_recovery_needed",
  "tts_completed",
  "weather_updated",
  "location_updated",
  "library_scan_completed",
  "radio_agent_library_scan_failed",
  "profile_artifacts_refreshed",
  "station_context_refreshed",
]);

const COLD_EVENTS = new Set<RadioAgentEventType>([
  "library_scan_requested",
  "playback_progress",
  "idle_tick",
]);

const EVENT_TYPES = new Set<RadioAgentEventType>([
  ...HOT_EVENTS,
  ...WARM_EVENTS,
  ...COLD_EVENTS,
]);

export function priorityForRadioAgentEvent(type: RadioAgentEventType): RadioAgentPriority {
  if (HOT_EVENTS.has(type)) return "hot";
  if (WARM_EVENTS.has(type)) return "warm";
  return "cold";
}

export function isRadioAgentEventType(value: unknown): value is RadioAgentEventType {
  return typeof value === "string" && EVENT_TYPES.has(value as RadioAgentEventType);
}

export function normalizeRadioAgentEvent(input: Record<string, unknown>): RadioAgentEvent {
  const type = isRadioAgentEventType(input.type) ? input.type : "idle_tick";
  const uid = typeof input.uid === "string" && input.uid.trim() ? input.uid : null;
  const rawSessionId = input.sessionId ?? input.session_id;
  const sessionId = typeof rawSessionId === "number" && Number.isFinite(rawSessionId) ? rawSessionId : null;
  const createdAt = typeof input.createdAt === "string" && input.createdAt ? input.createdAt : new Date().toISOString();
  const nestedPayload = isRecord(input.payload) ? input.payload : {};
  const payload: Record<string, unknown> = { ...nestedPayload };

  for (const [key, value] of Object.entries(input)) {
    if (["type", "uid", "sessionId", "session_id", "priority", "createdAt", "payload"].includes(key)) continue;
    payload[key] = value;
  }

  return {
    uid,
    sessionId,
    type,
    priority: priorityForRadioAgentEvent(type),
    payload,
    createdAt,
  };
}

export interface RadioTrackContext {
  currentTrack?: Track | null;
  recentTracks: Track[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
