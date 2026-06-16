import type { DecisionTrace } from "../radio/radioBrainTypes.js";
import type { MemoryPack, MusicTask, SearchVerification, SelectionReason, StationEnvironment, Track } from "../types.js";
import { compactText, dedupe } from "../utils/text.js";
import type {
  RadioAgentCandidateTask,
  RadioAgentPreparedTrack,
  RadioAgentProgramExecutionDiagnostics,
  RadioAgentProgramWindow,
} from "./types.js";

export interface ProgramVerifier {
  verify(task: MusicTask, uid?: string | null, context?: string, contextPack?: MemoryPack): Promise<SearchVerification>;
}

const MAX_PROGRAM_CANDIDATES = 5;
const INTERNAL_LISTENER_TERMS =
  /\b(model|json|candidate|trace|prompt|verification|shadow\s+mode|tool\s+call|deterministic|contract)\b|radio memory|listener has|library evidence|playlist titles repeatedly/i;
const TRACK_SEPARATOR = /\s[-\u2013\u2014:]\s/u;
const GENERIC_REASON = "Selected for the current radio program.";

export class RadioAgentProgramExecutor implements RadioAgentProgramExecutionDiagnostics {
  private attemptedQueries: string[] = [];

  constructor(
    private readonly verifier: ProgramVerifier,
    private readonly traceId: () => string = () => `radio-agent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  latestAttemptedQueries(): string[] {
    return [...this.attemptedQueries];
  }

  async prepareFirstPlayable(window: RadioAgentProgramWindow, options: { skipCandidates?: number } = {}): Promise<RadioAgentPreparedTrack | null> {
    this.attemptedQueries = [];
    const traceId = this.traceId();
    const rejectedCandidates: string[] = [];
    const verificationAttempts: string[] = [];
    const candidates = window.candidateTasks.slice(Math.max(0, options.skipCandidates || 0), MAX_PROGRAM_CANDIDATES);

    for (let index = 0; index < candidates.length; index += 1) {
      const candidate = candidates[index];
      if (!candidate) continue;

      const musicTask = musicTaskForCandidate(window, candidate);
      const verification = await this.verifier.verify(musicTask, window.uid, verifierContext(window), verifierMemoryPack(window)).catch(() => null);
      const attemptedQueries = attemptedQueriesForVerification(verification, candidate.query);
      this.attemptedQueries = dedupe([...this.attemptedQueries, ...attemptedQueries]);
      const attemptedQuery = attemptedQueries[0] || compactText(candidate.query, 120);
      if (attemptedQuery) verificationAttempts.push(attemptedQuery);

      if (!isPlayableVerification(verification)) {
        if (attemptedQuery) rejectedCandidates.push(attemptedQuery);
        continue;
      }

      const fallbackLevel: DecisionTrace["fallbackLevel"] = index === 0 ? "episode_primary" : "episode_backup";
      const reasonText = selectionText(candidate, window);
      const selectionReason: SelectionReason = {
        type: "radio_agent_program",
        text: reasonText,
        understoodIntent: sanitizedListenerText(window.stationBrief, 240) || GENERIC_REASON,
        verificationNote: sanitizedListenerText(verification.verification.versionNote || "", 180),
        episodeId: window.id,
        traceId,
        fallbackLevel,
      };
      const track: Track = { ...verification.selectedSong, selectionReason };
      const segueText = window.hostIntent.shouldSpeak ? sanitizedListenerText(window.hostIntent.text, 180) : "";

      const decisionTrace: DecisionTrace = {
        id: traceId,
        uid: window.uid,
        sessionId: window.sessionId,
        episodeId: window.id,
        intentType: "autoplay",
        profileQuality: {
          level: "strong",
          score: confidenceScore(verification),
          reasons: ["radio agent program window"],
        },
        environment: environmentFromWindow(window),
        selectedTrack: track,
        reason: decisionReason(candidate, window),
        rejectedCandidates,
        verificationAttempts,
        fallbackLevel,
        latencyMs: { radioAgent: 0 },
        hostText: segueText,
        createdAt: this.now(),
      };

      return {
        track,
        url: verification.url,
        selectionReason,
        segueText,
        decisionTrace,
      };
    }

    return null;
  }
}

function verifierMemoryPack(window: RadioAgentProgramWindow): MemoryPack {
  return {
    userProfileDigest: window.traceBasis.profile || "",
    sessionWorkingMemory: {
      stationBrief: window.stationBrief,
      mainDirection: window.mainDirection,
      returnRequirement: window.returnRequirement,
    },
    recentTurns: [],
    retrievedMemories: [],
    playbackContext: {
      currentTrack: window.currentTrack || null,
      recentTracks: window.recentTracks || [],
      readyQueue: window.readyQueue || [],
      scene: window.mainDirection,
    },
    userSettings: {},
    hardConstraints: window.disallowed || [],
  };
}

function attemptedQueriesForVerification(verification: SearchVerification | null, fallbackQuery: string): string[] {
  return dedupe([
    ...(verification?.diagnostics?.searchedQueries || []),
    verification?.usedQuery || "",
    fallbackQuery,
  ].map((query) => compactText(query, 120)).filter(Boolean));
}

function musicTaskForCandidate(window: RadioAgentProgramWindow, candidate: RadioAgentCandidateTask): MusicTask {
  const query = compactText(candidate.query, 160);
  const specificTrack = looksSpecificArtistTitlePair(query);
  const styleHint = dedupe([candidate.style, window.mainDirection].filter(Boolean)).join(" / ");

  return {
    type: specificTrack ? "specific_track" : "scene_genre_direction",
    primaryEntities: primaryEntitiesForCandidate(window, candidate, specificTrack),
    workHint: specificTrack ? workHintForQuery(query) : "",
    styleHint,
    negativeConstraints: dedupe([...(candidate.negativeConstraints || []), ...(window.disallowed || [])]),
    searchGoals: [query],
    mustNotSearchLiteralUserSentence: true,
  };
}

function primaryEntitiesForCandidate(
  window: RadioAgentProgramWindow,
  candidate: RadioAgentCandidateTask,
  specificTrack: boolean,
): MusicTask["primaryEntities"] {
  const query = compactText(candidate.query, 160);
  if (specificTrack) {
    const artist = artistHintForQuery(query);
    const work = workHintForQuery(query);
    return [
      artist ? { role: "artist", name: artist } : null,
      work ? { role: "work", name: work } : null,
    ].filter((entity): entity is MusicTask["primaryEntities"][number] => entity !== null);
  }

  const entities: MusicTask["primaryEntities"] = [];
  const style = compactText(candidate.style, 120);
  const direction = compactText(window.mainDirection, 120);
  if (style) entities.push({ role: "genre", name: style });
  if (direction) entities.push({ role: "scene", name: direction });
  return entities;
}

function looksSpecificArtistTitlePair(query: string): boolean {
  if (!query) return false;
  const explicit = explicitTrackShapeIsSpecific(query);
  if (explicit !== null) return explicit;
  if (hasExplicitTrackShape(query) && !looksUtilityDirection(query)) return true;
  if (looksSceneOrGenreDirection(query)) return false;
  if (/\s[-–—:]\s/u.test(query)) return true;
  if (/\bby\b/i.test(query)) return true;
  if (/\b(playlist|radio|mix|sleep|study|focus|genre|mood|vibe|direction|discovery)\b/i.test(query)) return false;
  const asciiTokens = query.match(/[A-Za-z0-9][A-Za-z0-9'.+&-]*/gu) || [];
  if (asciiTokens.length < 2) return false;
  if (isAcronymArtistToken(asciiTokens[0] || "")) return true;
  return query.includes("+") && asciiTokens.length >= 4 && asciiTokens.slice(0, 2).every((token) => /^[A-Z0-9]/u.test(token));
}

function hasExplicitTrackShape(query: string): boolean {
  return TRACK_SEPARATOR.test(query) || /\bby\b/i.test(query);
}

function explicitTrackShapeIsSpecific(query: string): boolean | null {
  const separated = query.split(TRACK_SEPARATOR).map((part) => part.trim()).filter(Boolean);
  if (separated.length >= 2) {
    const left = separated[0] || "";
    const right = separated.slice(1).join(" ");
    return !(looksSceneOrGenreDirection(left) && looksSceneOrGenreDirection(right));
  }

  const byMatch = query.match(/^(.+?)\s+by\s+(.+)$/iu);
  if (byMatch) {
    const title = byMatch[1]?.trim() || "";
    const artist = byMatch[2]?.trim() || "";
    return Boolean(artist) && !(looksSceneOrGenreDirection(title) && looksSceneOrGenreDirection(artist));
  }

  return null;
}

function looksUtilityDirection(query: string): boolean {
  return /\b(study|focus|sleep|playlist|mix|radio)\b/i.test(query);
}

function looksSceneOrGenreDirection(query: string): boolean {
  const normalized = query.toLowerCase();
  const directionTerms = [
    "ambient",
    "alt r&b",
    "alt-r&b",
    "city pop",
    "classical",
    "discovery",
    "edm",
    "electronic",
    "focus music",
    "genre",
    "jazz",
    "late night",
    "late-night",
    "mellow",
    "mix",
    "mood",
    "neo soul",
    "piano",
    "playlist",
    "r&b",
    "radio",
    "scene",
    "sleep",
    "soul",
    "study",
    "vibe",
    "vocal",
  ];
  return directionTerms.some((term) => normalized.includes(term));
}

function isAcronymArtistToken(token: string): boolean {
  const normalized = token.replace(/[^A-Za-z0-9]/g, "");
  return normalized.length >= 2 && normalized === normalized.toUpperCase();
}

function artistHintForQuery(query: string): string {
  const separated = query.split(TRACK_SEPARATOR);
  if (separated.length >= 2) return compactText(separated[0], 80);
  const byMatch = query.match(/^(.+?)\s+by\s+(.+)$/iu);
  if (byMatch) return compactText(byMatch[2], 80);
  const tokens = query.split(/\s+/u).filter(Boolean);
  return compactText(tokens[0] || "", 80);
}

function workHintForQuery(query: string): string {
  const separated = query.split(TRACK_SEPARATOR);
  if (separated.length >= 2) return compactText(separated.slice(1).join(" "), 120);
  const byMatch = query.match(/^(.+?)\s+by\s+(.+)$/iu);
  if (byMatch) return compactText(byMatch[1], 120);
  const tokens = query.split(/\s+/u).filter(Boolean);
  return compactText(tokens.slice(1).join(" "), 120);
}

function verifierContext(window: RadioAgentProgramWindow): string {
  return [
    `Station brief: ${window.stationBrief}`,
    `Main direction: ${window.mainDirection}`,
    `Return requirement: ${window.returnRequirement}`,
    window.traceBasis.contract ? `Contract: ${window.traceBasis.contract}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function isPlayableVerification(
  verification: SearchVerification | null,
): verification is SearchVerification & { selectedSong: Track; url: string } {
  return Boolean(verification?.status === "verified" && verification.selectedSong && verification.url);
}

function selectionText(candidate: RadioAgentCandidateTask, window: RadioAgentProgramWindow): string {
  return sanitizedListenerText(candidate.reason, 180) || sanitizedListenerText(window.stationBrief, 180) || GENERIC_REASON;
}

function decisionReason(candidate: RadioAgentCandidateTask, window: RadioAgentProgramWindow): string {
  const reason = sanitizedListenerText(candidate.reason, 180);
  const hostIntent = sanitizedListenerText(window.hostIntent.text, 180);
  const brief = sanitizedListenerText(window.stationBrief, 220);
  const mainDirection = sanitizedListenerText(window.mainDirection, 160);
  const returnRequirement = sanitizedListenerText(window.returnRequirement, 160);
  const parts = dedupe([reason, hostIntent, brief, mainDirection, returnRequirement].filter(Boolean));
  return parts.join(" ") || GENERIC_REASON;
}

function sanitizedListenerText(value: unknown, maxLength: number): string {
  const text = compactText(value, maxLength);
  if (!text || INTERNAL_LISTENER_TERMS.test(text)) return "";
  return text;
}

function confidenceScore(verification: SearchVerification): number {
  const confidence = verification.verification.confidence;
  return typeof confidence === "number" && Number.isFinite(confidence) ? confidence : 0.8;
}

function environmentFromWindow(window: RadioAgentProgramWindow): StationEnvironment {
  const localTimeBlock = localTimeBlockFromNow(window.traceBasis.now);
  const scene = sanitizedListenerText(window.mainDirection, 120) || sanitizedListenerText(window.stationBrief, 120) || "radio program";
  const summary = sanitizedListenerText([window.mainDirection, window.traceBasis.now].filter(Boolean).join(" "), 220) || scene;
  return {
    scene,
    localTimeBlock,
    summary,
  };
}

function localTimeBlockFromNow(nowText: string): string {
  const explicit = nowText.match(/local[_\s-]?time[_\s-]?block\s*[:=]\s*([A-Za-z0-9_-]+)/iu)?.[1];
  if (explicit) return explicit;
  if (/\blate[_\s-]?night\b/iu.test(nowText)) return "late_night";
  if (/\bnight\b/iu.test(nowText)) return "night";
  if (/\bmorning\b/iu.test(nowText)) return "morning";
  if (/\bafternoon\b/iu.test(nowText)) return "afternoon";
  if (/\bevening\b/iu.test(nowText)) return "evening";
  return "unknown";
}
