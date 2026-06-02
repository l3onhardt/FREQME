import type { Track } from "../types.js";

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

export function buildUserProfileMarkdown(args: BuildUserProfileMarkdownArgs): string {
  return [
    "# User Profile",
    "",
    `uid: ${args.uid}`,
    `updated: ${args.updatedAt}`,
    "",
    "## Stable Taste Facts",
    ...evidenceLines(args.facts),
    "",
    "## Hypotheses",
    ...evidenceLines(args.hypotheses),
    "",
    "## Operating Notes",
    "- Treat hypotheses as tentative until repeated behavior confirms them.",
    "- Do not turn a single skip into a permanent dislike.",
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

function evidenceLines(items: ProfileEvidenceForMarkdown[]): string[] {
  if (!items.length) return ["- none"];
  return items.map((item) => `- ${item.key}: ${item.value} (confidence: ${formatConfidence(item.confidence)}, evidence: ${item.evidenceCount})`);
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
