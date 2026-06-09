import type { Track } from "../types.js";

const USER_PROFILE_FACT_LIMIT = 24;
const USER_PROFILE_HYPOTHESIS_LIMIT = 12;
const USER_PROFILE_SESSION_EVIDENCE_LIMIT = 10;

export interface ProfileEvidenceForMarkdown {
  key: string;
  value: string;
  confidence: number;
  evidenceCount: number;
}

export interface BuildUserProfileMarkdownArgs {
  uid: string;
  facts: ProfileEvidenceForMarkdown[];
  hypotheses: ProfileEvidenceForMarkdown[];
  sessionEvidence?: ProfileEvidenceForMarkdown[];
  updatedAt: string;
}

export interface BuildStationNowMarkdownArgs {
  localTimeBlock: string;
  timezoneName: string;
  currentTrack?: Track | null;
  recentTracks: Track[];
  listenerStateHypothesis: string;
  confidence: "low" | "medium" | "high";
}

export interface BuildProgramContractMarkdownArgs {
  stationGoal: string;
  allowedMoves: string[];
  blockedMoves: string[];
  hostStyle: string;
}

export interface BuildListenerSessionMarkdownArgs {
  updatedAt: string;
  activeRequest: string;
  acceptedDirection: string;
  rejectedMoves: string[];
  recentCorrections: string[];
  openHypotheses: string[];
  nextPromise: string;
  hostGuidance: string;
}

export interface BuildSessionReflectionMarkdownArgs {
  updatedAt: string;
  completedTracks: Track[];
  skippedTracks: Track[];
  correctionTexts: string[];
  sessionSignals: string[];
  temporaryAvoids: string[];
  longTermCandidates: string[];
}

export interface BuildAgentJournalMarkdownArgs {
  updatedAt: string;
  eventType: string;
  observation: string;
  interpretation: string;
  action: string;
  guardrails: string[];
  nextCheck: string;
}

export interface BuildAgentRepairMarkdownArgs {
  updatedAt: string;
  eventType: string;
  issue: string;
  evidence: string[];
  correction: string;
  guardrails: string[];
  nextAttempt: string;
}

export function buildUserProfileMarkdown(args: BuildUserProfileMarkdownArgs): string {
  return [
    "# User Profile",
    "",
    `uid: ${args.uid}`,
    `updated: ${args.updatedAt}`,
    "",
    "## Stable Taste Facts",
    ...evidenceLines(args.facts, USER_PROFILE_FACT_LIMIT, "facts"),
    "",
    "## Hypotheses",
    ...evidenceLines(args.hypotheses, USER_PROFILE_HYPOTHESIS_LIMIT, "hypotheses"),
    "",
    "## Recent Session Evidence",
    ...evidenceLines(args.sessionEvidence || [], USER_PROFILE_SESSION_EVIDENCE_LIMIT, "session evidence"),
    "",
    "## Operating Notes",
    "- Treat hypotheses as tentative until repeated behavior confirms them.",
    "- Do not turn a single skip into a permanent dislike.",
    "- Use recent session evidence for this session, but keep it weaker than stable facts.",
    "",
  ].join("\n");
}

export function buildStationNowMarkdown(args: BuildStationNowMarkdownArgs): string {
  const currentTrack = args.currentTrack
    ? `${args.currentTrack.name || "Unknown"} - ${args.currentTrack.artist || "Unknown"} (${args.currentTrack.id})`
    : "none";
  return [
    "# Station Now",
    "",
    `timezone: ${args.timezoneName || "unknown"}`,
    `local_time_block: ${args.localTimeBlock || "unknown"}`,
    `current_track: ${currentTrack}`,
    `listener_state_hypothesis: ${args.listenerStateHypothesis || "unknown"}`,
    `confidence: ${args.confidence}`,
    "",
    "## Recent Tracks",
    ...trackLines(args.recentTracks),
    "",
  ].join("\n");
}

export function buildProgramContractMarkdown(args: BuildProgramContractMarkdownArgs): string {
  return [
    "# Program Contract",
    "",
    `station_goal: ${args.stationGoal}`,
    "",
    "## Allowed Moves",
    ...listLines(args.allowedMoves),
    "",
    "## Blocked Moves",
    ...listLines(args.blockedMoves),
    "",
    "## Host Style",
    `- ${args.hostStyle}`,
    "- Keep internal planning terms out of listener-facing speech.",
    "- Prefer silence over filler when there is nothing useful to say.",
    "",
  ].join("\n");
}

export function buildListenerSessionMarkdown(args: BuildListenerSessionMarkdownArgs): string {
  return [
    "# Listener Session",
    "",
    `updated: ${args.updatedAt}`,
    `active_request: ${args.activeRequest || "unknown"}`,
    `accepted_direction: ${args.acceptedDirection || "unknown"}`,
    `next_promise: ${args.nextPromise || "Keep the current direction until the listener changes it."}`,
    "",
    "## Rejected Moves",
    ...listLines(args.rejectedMoves),
    "",
    "## Recent Corrections",
    ...listLines(args.recentCorrections),
    "",
    "## Open Hypotheses",
    ...listLines(args.openHypotheses),
    "",
    "## DJ Stance",
    `- ${args.hostGuidance || "Speak only when it helps the listener understand the next move."}`,
    "- Treat session requests as active operating constraints, not permanent taste facts.",
    "- Do not promote one skip or one correction into a durable dislike without repeated evidence.",
    "- Do not read internal planning, model, trace, or artifact terms aloud.",
    "",
  ].join("\n");
}

export function buildSessionReflectionMarkdown(args: BuildSessionReflectionMarkdownArgs): string {
  return [
    "# Session Reflection",
    "",
    `updated: ${args.updatedAt}`,
    "",
    "## Completed Tracks",
    ...trackLines(args.completedTracks),
    "",
    "## Skipped Tracks",
    ...trackLines(args.skippedTracks),
    "",
    "## Corrections",
    ...listLines(args.correctionTexts),
    "",
    "## Session Signals",
    ...listLines(args.sessionSignals),
    "",
    "## Temporary Avoids",
    ...listLines(args.temporaryAvoids),
    "",
    "## Long-Term Candidates",
    ...listLines(args.longTermCandidates),
    "",
    "## Reflection Rules",
    "- Completed tracks are positive session evidence, especially when repeated.",
    "- Do not turn a single skip into a permanent dislike.",
    "- Promote a long-term preference only after repeated evidence across requests or sessions.",
    "",
  ].join("\n");
}

export function buildAgentJournalMarkdown(args: BuildAgentJournalMarkdownArgs): string {
  return [
    "# Agent Journal",
    "",
    `updated: ${args.updatedAt}`,
    `event: ${cleanJournalLine(args.eventType) || "unknown"}`,
    "",
    "## Observation",
    `- ${cleanJournalLine(args.observation) || "No strong listener-facing signal yet."}`,
    "",
    "## Interpretation",
    `- ${cleanJournalLine(args.interpretation) || "Keep the station coherent while gathering more evidence."}`,
    "",
    "## Action",
    `- ${cleanJournalLine(args.action) || "Continue with a conservative next track."}`,
    "",
    "## Guardrails",
    ...listLines(args.guardrails.map(cleanJournalLine).filter(Boolean)),
    "",
    "## Next Check",
    `- ${cleanJournalLine(args.nextCheck) || "Watch the next skip, completion, or direct request before updating memory."}`,
    "",
  ].join("\n");
}

export function buildAgentRepairMarkdown(args: BuildAgentRepairMarkdownArgs): string {
  return [
    "# Agent Repair",
    "",
    `updated: ${args.updatedAt}`,
    `event: ${cleanAgentNoteLine(args.eventType) || "unknown"}`,
    "",
    "## Issue",
    `- ${cleanAgentNoteLine(args.issue) || "The planned move needed correction before playback."}`,
    "",
    "## Evidence",
    ...listLines(args.evidence.map(cleanAgentNoteLine).filter(Boolean)),
    "",
    "## Correction",
    `- ${cleanAgentNoteLine(args.correction) || "Return to the current station direction."}`,
    "",
    "## Guardrails",
    ...listLines(args.guardrails.map(cleanAgentNoteLine).filter(Boolean)),
    "",
    "## Next Attempt",
    `- ${cleanAgentNoteLine(args.nextAttempt) || "Choose a conservative station-safe track."}`,
    "",
  ].join("\n");
}

function evidenceLines(items: ProfileEvidenceForMarkdown[], limit: number, label: string): string[] {
  if (!items.length) return ["- none"];
  const shown = items
    .slice(0, limit)
    .map((item) => `- ${item.key}: ${item.value} (confidence: ${formatConfidence(item.confidence)}, evidence: ${item.evidenceCount})`);
  const omitted = items.length - shown.length;
  if (omitted > 0) {
    shown.push(`- ${omitted} additional ${label} omitted from compact context.`);
  }
  return shown;
}

function trackLines(tracks: Track[]): string[] {
  if (!tracks.length) return ["- none"];
  return tracks.map((track) => `- ${track.name || "Unknown"} - ${track.artist || "Unknown"} (${track.id})`);
}

function listLines(items: string[]): string[] {
  if (!items.length) return ["- none"];
  return items.map((item) => `- ${item}`);
}

function formatConfidence(value: number): string {
  return Number.isFinite(value) ? value.toFixed(2) : "0.00";
}

function cleanJournalLine(value: string): string {
  return cleanAgentNoteLine(value);
}

function cleanAgentNoteLine(value: string): string {
  return value
    .replace(/\b(model|prompt|JSON|tool call|shadow decision|decision trace|trace basis|trace|verification|contract)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180);
}
