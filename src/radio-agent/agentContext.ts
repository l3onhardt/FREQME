import type { Track } from "../types.js";
import type {
  RadioAgentContextSnapshot,
  RadioAgentEvent,
  RadioAgentEventType,
  RadioAgentMemory,
} from "./types.js";

const ARTIFACT_LIMIT = 4000;
const PAYLOAD_STRING_LIMIT = 1000;
const TRUNCATION_MARKER = "... truncated for agent context";

export interface BuildRadioAgentContextSnapshotArgs {
  uid: string | null;
  sessionId: number | null;
  eventType: RadioAgentEventType;
  artifacts: Record<string, string | undefined>;
  recentEvents: RadioAgentEvent[];
  memories: RadioAgentMemory[];
  currentTrack?: Track | null;
  recentTracks?: Track[];
  readyQueue: Track[];
}

export function buildRadioAgentContextSnapshot(
  args: BuildRadioAgentContextSnapshotArgs,
): RadioAgentContextSnapshot {
  return {
    uid: args.uid,
    sessionId: args.sessionId,
    eventType: args.eventType,
    profile: compactArtifact(args.artifacts["user_profile.md"]),
    now: compactArtifact(args.artifacts["station_now.md"]),
    contract: compactArtifact(args.artifacts["program_contract.md"]),
    session: compactArtifact(args.artifacts["listener_session.md"]),
    reflection: compactArtifact(args.artifacts["session_reflection.md"]),
    repair: compactArtifact(args.artifacts["agent_repair.md"]),
    memoryFacts: args.memories.filter((memory) => memory.kind === "taste_fact"),
    memoryHypotheses: args.memories.filter((memory) => memory.kind === "taste_hypothesis"),
    sessionEvidence: args.memories.filter((memory) => memory.kind === "session_evidence"),
    recentEvents: args.recentEvents.slice(0, 20).map(sanitizeEvent),
    currentTrack: sanitizeTrack(args.currentTrack ?? null),
    recentTracks: (args.recentTracks || []).map((track) => sanitizeTrack(track)).filter((track) => track !== null),
    readyQueue: args.readyQueue.map((track) => sanitizeTrack(track)).filter((track) => track !== null),
  };
}

function compactArtifact(content: string | undefined): string {
  if (!content) return "";
  if (content.length <= ARTIFACT_LIMIT) return content;

  return `${content.slice(0, ARTIFACT_LIMIT - TRUNCATION_MARKER.length)}${TRUNCATION_MARKER}`;
}

function sanitizeEvent(event: RadioAgentEvent): RadioAgentEvent {
  return {
    id: event.id,
    uid: event.uid,
    sessionId: event.sessionId,
    type: event.type,
    priority: event.priority,
    payload: sanitizePayload(event.payload),
    createdAt: event.createdAt,
  };
}

function sanitizeTrack(track: Track | null): Track | null {
  if (!track) return null;

  const safeTrack: Track = {
    id: capPayloadString(track.id),
    name: capPayloadString(track.name),
    artist: capPayloadString(track.artist),
  };

  if (typeof track.album === "string") safeTrack.album = capPayloadString(track.album);
  if (typeof track.source === "string") safeTrack.source = capPayloadString(track.source);
  if (typeof track.language === "string") safeTrack.language = capPayloadString(track.language);
  if (Array.isArray(track.aliases)) {
    const aliases = track.aliases.filter((alias): alias is string => typeof alias === "string").map(capPayloadString);
    if (aliases.length > 0) safeTrack.aliases = aliases;
  }
  if (track.selectionReason) {
    safeTrack.selectionReason = sanitizeSelectionReason(track.selectionReason);
  }

  return safeTrack;
}

function sanitizeSelectionReason(selectionReason: Track["selectionReason"]): Track["selectionReason"] {
  if (!selectionReason) return undefined;

  const safeSelectionReason: NonNullable<Track["selectionReason"]> = {
    type: capPayloadString(selectionReason.type),
    text: capPayloadString(selectionReason.text),
  };

  if (typeof selectionReason.understoodIntent === "string") {
    safeSelectionReason.understoodIntent = capPayloadString(selectionReason.understoodIntent);
  }
  if (typeof selectionReason.verificationNote === "string") {
    safeSelectionReason.verificationNote = capPayloadString(selectionReason.verificationNote);
  }
  if (typeof selectionReason.episodeId === "string") {
    safeSelectionReason.episodeId = capPayloadString(selectionReason.episodeId);
  }
  if (typeof selectionReason.traceId === "string") {
    safeSelectionReason.traceId = capPayloadString(selectionReason.traceId);
  }
  if (typeof selectionReason.fallbackLevel === "string") {
    safeSelectionReason.fallbackLevel = capPayloadString(selectionReason.fallbackLevel);
  }

  return safeSelectionReason;
}

function sanitizePayload(payload: Record<string, unknown>): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(payload)) {
    if (isRawLikeKey(key, value)) continue;
    if (key === "track" || key === "currentTrack") {
      sanitized[key] = sanitizeUnknownTrack(value);
      continue;
    }
    if (key === "readyQueue" && Array.isArray(value)) {
      sanitized[key] = value.map(sanitizeUnknownTrack).filter((track) => track !== null);
      continue;
    }
    if (key === "governanceTrace") {
      const trace = sanitizeGovernanceTrace(value);
      if (trace) sanitized[key] = trace;
      continue;
    }

    const safeValue = sanitizePayloadValue(value);
    if (safeValue !== undefined) sanitized[key] = safeValue;
  }

  return sanitized;
}

function sanitizePayloadValue(value: unknown): unknown {
  if (typeof value === "string") return capPayloadString(value);
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (Array.isArray(value)) {
    return value.map(sanitizePayloadValue).filter((item) => item !== undefined);
  }
  if (isRecord(value)) {
    const sanitized: Record<string, unknown> = {};
    for (const [key, childValue] of Object.entries(value)) {
      if (isRawLikeKey(key, childValue)) continue;
      const safeChild = sanitizePayloadValue(childValue);
      if (safeChild !== undefined) sanitized[key] = safeChild;
    }
    return sanitized;
  }

  return undefined;
}

function sanitizeUnknownTrack(value: unknown): Track | null {
  if (!isRecord(value)) return null;
  const id = typeof value.id === "string" ? value.id : "";
  const name = typeof value.name === "string" ? value.name : "";
  const artist = typeof value.artist === "string" ? value.artist : "";
  return sanitizeTrack({
    id,
    name,
    artist,
    album: typeof value.album === "string" ? value.album : undefined,
    aliases: Array.isArray(value.aliases) ? value.aliases.filter((alias): alias is string => typeof alias === "string") : undefined,
    source: typeof value.source === "string" ? value.source : undefined,
    language: typeof value.language === "string" ? value.language : undefined,
    selectionReason: isSelectionReasonLike(value.selectionReason) ? value.selectionReason : undefined,
  });
}

function capPayloadString(value: string): string {
  if (value.length <= PAYLOAD_STRING_LIMIT) return value;
  return `${value.slice(0, PAYLOAD_STRING_LIMIT - TRUNCATION_MARKER.length)}${TRUNCATION_MARKER}`;
}

function sanitizeGovernanceTrace(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  const status = stringField(value.status);
  const candidateKey = stringField(value.candidateKey);
  const decision = stringField(value.decision);
  if ((status !== "accepted" && status !== "rejected") || !candidateKey || !decision) return null;

  const trace: Record<string, unknown> = {
    status,
    contractId: stringField(value.contractId) || null,
    requestToken: typeof value.requestToken === "number" && Number.isFinite(value.requestToken) ? value.requestToken : null,
    candidateKey: capPayloadString(candidateKey),
    decision: capPayloadString(decision),
    evidence: safeGovernanceEvidence(value.evidence),
  };
  const fallbackLevel = stringField(value.fallbackLevel);
  if (fallbackLevel) trace.fallbackLevel = capPayloadString(fallbackLevel);
  return trace;
}

function safeGovernanceEvidence(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map(capPayloadString)
    .filter((item) => item && !/\b(prompt|json|tool call|raw|secret|trace basis|decision trace|verification)\b/i.test(item))
    .slice(0, 5);
}

function stringField(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function isRawLikeKey(key: string, value: unknown): boolean {
  const normalized = key.replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
  if (normalized.includes("raw")) return true;
  return normalized.includes("sourcejson") || (normalized === "source" && isRecord(value));
}

function isSelectionReasonLike(value: unknown): value is NonNullable<Track["selectionReason"]> {
  return isRecord(value) && typeof value.type === "string" && typeof value.text === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
