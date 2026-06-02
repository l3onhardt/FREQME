import type { Track } from "../types.js";
import type {
  RadioAgentContextSnapshot,
  RadioAgentEvent,
  RadioAgentEventType,
  RadioAgentMemory,
} from "./types.js";

const ARTIFACT_LIMIT = 4000;
const TRUNCATION_MARKER = "... truncated for agent context";

export interface BuildRadioAgentContextSnapshotArgs {
  uid: string | null;
  sessionId: number | null;
  eventType: RadioAgentEventType;
  artifacts: Record<string, string | undefined>;
  recentEvents: RadioAgentEvent[];
  memories: RadioAgentMemory[];
  currentTrack?: Track | null;
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
    memoryFacts: args.memories.filter((memory) => memory.kind === "taste_fact"),
    memoryHypotheses: args.memories.filter((memory) => memory.kind === "taste_hypothesis"),
    recentEvents: args.recentEvents.slice(-12),
    currentTrack: args.currentTrack ?? null,
    readyQueue: args.readyQueue.slice(),
  };
}

function compactArtifact(content: string | undefined): string {
  if (!content) return "";
  if (content.length <= ARTIFACT_LIMIT) return content;

  return `${content.slice(0, ARTIFACT_LIMIT - TRUNCATION_MARKER.length)}${TRUNCATION_MARKER}`;
}
