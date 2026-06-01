import type { Track } from "../types.js";
import { compactText, dedupe } from "../utils/text.js";

export interface ReflectionMemory {
  currentConstraints?: string[];
  temporaryRejectedTrackIds?: string[];
  correctionCount?: number;
  preferenceEvidence?: Record<string, number>;
  longTermCandidates?: string[];
  updatedAt?: string;
}

export interface ReflectionEvent {
  existing: ReflectionMemory;
  event: "started" | "played" | "skip" | "correction" | "negative_feedback" | "preference_update";
  track?: Track | null;
  rawText?: string;
  constraints?: string[];
}

export class ReflectionLoop {
  record(args: ReflectionEvent): ReflectionMemory {
    const existing = args.existing || {};
    const currentConstraints = dedupe([...(existing.currentConstraints || []), ...(args.constraints || [])]).slice(-12);
    const temporaryRejectedTrackIds = [...(existing.temporaryRejectedTrackIds || [])];
    if (args.event === "skip" && args.track?.id && !temporaryRejectedTrackIds.includes(args.track.id)) {
      temporaryRejectedTrackIds.unshift(args.track.id);
    }
    const preferenceEvidence = { ...(existing.preferenceEvidence || {}) };
    if (args.event === "preference_update") {
      for (const constraint of args.constraints || []) {
        const key = compactText(constraint, 80);
        preferenceEvidence[key] = (preferenceEvidence[key] || 0) + 1;
      }
    }
    const longTermCandidates = dedupe([
      ...(existing.longTermCandidates || []),
      ...Object.entries(preferenceEvidence)
        .filter(([, count]) => count >= 2)
        .map(([key]) => key),
    ]);
    return {
      ...existing,
      currentConstraints,
      temporaryRejectedTrackIds: temporaryRejectedTrackIds.slice(0, 20),
      correctionCount:
        (existing.correctionCount || 0) + (args.event === "correction" || args.event === "negative_feedback" ? 1 : 0),
      preferenceEvidence,
      longTermCandidates,
      updatedAt: new Date().toISOString(),
    };
  }
}
