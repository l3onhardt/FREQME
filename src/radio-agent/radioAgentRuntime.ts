import type { LibraryCensus, LibraryCensusResult } from "./libraryCensus.js";
import { buildRadioAgentContextSnapshot } from "./agentContext.js";
import {
  buildListenerSessionMarkdown,
  buildProgramContractMarkdown,
  buildSessionReflectionMarkdown,
  buildStationNowMarkdown,
  buildUserProfileMarkdown,
} from "./contextArtifacts.js";
import { decideHostSpeech } from "./hostPolicy.js";
import type { RadioAgentProgramDirector } from "./programDirector.js";
import { distillTasteFacts, type TasteEvidenceItem } from "./tasteDistiller.js";
import {
  normalizeRadioAgentEvent,
  type RadioAgentEvent,
  type RadioAgentHandleResult,
  type RadioAgentMemory,
  type RadioAgentMode,
  type RadioAgentStatus,
  type RadioHostDecision,
  type RadioLibraryPlaylist,
  type RadioLibraryTrack,
  type RadioShadowDecision,
} from "./types.js";
import type { RadioAgentArtifactRecord } from "../storage/radioAgentStore.js";
import type { Track } from "../types.js";

const DEFAULT_LIBRARY_SCAN_FRESHNESS_MS = 6 * 60 * 60 * 1000;
const COMPACT_PROFILE_SOURCE_VERSION = "taste-distiller/v3-memory-merge";
const LISTENER_SESSION_SOURCE_VERSION = "listener-session/v1";
const SESSION_REFLECTION_SOURCE_VERSION = "session-reflection/v1";

interface RadioAgentRuntimeStore {
  appendEvent(event: RadioAgentEvent): number;
  recentEvents(uid: string | null, sessionId: number | null, limit: number): RadioAgentEvent[];
  upsertMemory(memory: RadioAgentMemory): void;
  memories(uid: string, kind: string, limit: number): RadioAgentMemory[];
  playlists?(uid: string, limit: number): RadioLibraryPlaylist[];
  libraryTracks?(uid: string, limit: number): RadioLibraryTrack[];
  saveArtifact(uid: string, artifactKey: string, content: string, sourceVersion: string): void;
  artifact(uid: string, artifactKey: string): RadioAgentArtifactRecord | null;
  saveShadowDecision(decision: RadioShadowDecision): void;
  latestShadowDecisions(uid: string | null, sessionId: number | null, limit: number): RadioShadowDecision[];
}

export interface RadioAgentRuntimeDeps {
  mode: RadioAgentMode;
  store: RadioAgentRuntimeStore;
  census?: Pick<LibraryCensus, "scan">;
  programDirector?: Pick<RadioAgentProgramDirector, "plan">;
  libraryScanFreshnessMs?: number;
  now?: () => string;
}

export class RadioAgentRuntime {
  private readonly now: () => string;
  private readonly libraryScanFreshnessMs: number;
  private readonly activeLibraryScans = new Set<string>();
  private readonly backgroundWork = new Set<Promise<unknown>>();
  private sequence = 0;

  constructor(private readonly deps: RadioAgentRuntimeDeps) {
    this.now = deps.now ?? (() => new Date().toISOString());
    this.libraryScanFreshnessMs = deps.libraryScanFreshnessMs ?? DEFAULT_LIBRARY_SCAN_FRESHNESS_MS;
  }

  async handle(input: Record<string, unknown>): Promise<RadioAgentHandleResult> {
    const event = normalizeRadioAgentEvent({ ...input, createdAt: input.createdAt || this.now() });
    const id = this.deps.store.appendEvent(event);
    const persistedEvent = { ...event, id };

    if (event.type === "login_completed" && event.uid) {
      this.maybeStartLibraryScan(event);
    }

    if (event.type === "track_skipped") {
      this.saveSessionEvidence(event, "skip", "Single skip recorded as session evidence, not a permanent dislike.");
    }

    if (shouldRefreshProfileFromBehavior(persistedEvent)) {
      this.refreshProfileArtifacts(persistedEvent);
    }

    if (
      event.type === "session_restored" ||
      event.type === "playback_started" ||
      event.type === "track_completed" ||
      event.type === "track_skipped" ||
      event.type === "user_text"
    ) {
      this.refreshStationArtifacts(persistedEvent);
    }

    const programWindow = shouldPlanProgramWindow(persistedEvent) ? await this.planProgramWindow(persistedEvent) : undefined;
    const hostDecision = this.decideHost(persistedEvent);
    this.saveDecision(event, "host", { ...hostDecision });

    return {
      controlsPlayback: false,
      event: persistedEvent,
      hostDecision,
      programWindow,
    };
  }

  status(uid: string | null, sessionId: number | null = null): RadioAgentStatus {
    const artifacts: RadioAgentStatus["artifacts"] = {};
    if (uid) {
      for (const key of ["user_profile.md", "station_now.md", "program_contract.md", "listener_session.md", "session_reflection.md"]) {
        const artifact = this.deps.store.artifact(uid, key);
        if (artifact) {
          artifacts[key] = {
            updatedAt: artifact.updatedAt,
            sourceVersion: artifact.sourceVersion,
          };
        }
      }
    }

    return {
      mode: this.deps.mode,
      uid,
      sessionId,
      controlsPlayback: false,
      recentEvents: this.deps.store.recentEvents(uid, sessionId, 20),
      recentDecisions: this.deps.store.latestShadowDecisions(uid, sessionId, 20),
      artifacts,
    };
  }

  async flushBackgroundWork(): Promise<void> {
    await Promise.allSettled([...this.backgroundWork]);
  }

  private maybeStartLibraryScan(event: RadioAgentEvent): void {
    if (!event.uid) return;
    if (this.activeLibraryScans.has(event.uid)) return;
    if (this.hasFreshLibraryScan(event.uid)) {
      this.refreshProfileArtifactsIfNeeded(event);
      return;
    }
    if (!this.deps.census) return;

    const scanEvent: RadioAgentEvent = {
      uid: event.uid,
      sessionId: event.sessionId,
      type: "library_scan_requested",
      priority: "cold",
      payload: { reason: "login_completed" },
      createdAt: this.now(),
    };
    this.deps.store.appendEvent(scanEvent);
    this.startLibraryScan(scanEvent);
  }

  private refreshProfileArtifactsIfNeeded(event: RadioAgentEvent): void {
    if (!event.uid) return;
    const artifact = this.deps.store.artifact(event.uid, "user_profile.md");
    if (artifact?.sourceVersion.startsWith(COMPACT_PROFILE_SOURCE_VERSION)) return;
    this.refreshProfileArtifacts(event);
  }

  private startLibraryScan(event: RadioAgentEvent): void {
    if (!event.uid || !this.deps.census) return;
    this.activeLibraryScans.add(event.uid);
    const work = this.deps.census
      .scan(event.uid)
      .then((result) => this.recordScanCompleted(event, result))
      .catch((error: unknown) => this.recordScanFailed(event, error))
      .finally(() => {
        this.backgroundWork.delete(work);
        if (event.uid) this.activeLibraryScans.delete(event.uid);
      });
    this.backgroundWork.add(work);
  }

  private hasFreshLibraryScan(uid: string): boolean {
    if (this.libraryScanFreshnessMs <= 0) return false;
    const nowMs = Date.parse(this.now());
    if (!Number.isFinite(nowMs)) return false;

    return this.deps.store.recentEvents(uid, null, 20).some((event) => {
      if (event.type !== "library_scan_completed") return false;
      if (scanCompletedWithFailures(event)) return false;
      const completedAt = Date.parse(event.createdAt);
      return Number.isFinite(completedAt) && completedAt <= nowMs && nowMs - completedAt <= this.libraryScanFreshnessMs;
    });
  }

  private recordScanCompleted(event: RadioAgentEvent, result: LibraryCensusResult): void {
    this.deps.store.appendEvent({
      uid: event.uid,
      sessionId: event.sessionId,
      type: "library_scan_completed",
      priority: "warm",
      payload: { result },
      createdAt: this.now(),
    });
    this.refreshProfileArtifacts(event);
  }

  private recordScanFailed(event: RadioAgentEvent, error: unknown): void {
    this.deps.store.appendEvent({
      uid: event.uid,
      sessionId: event.sessionId,
      type: "radio_agent_library_scan_failed",
      priority: "warm",
      payload: { reason: error instanceof Error ? error.message : String(error) },
      createdAt: this.now(),
    });
  }

  private saveSessionEvidence(event: RadioAgentEvent, evidenceType: string, note: string): void {
    this.saveDecision(event, "session_evidence", {
      shouldSpeak: false,
      event: evidenceType,
      reason: note,
    });
  }

  private refreshProfileArtifacts(event: RadioAgentEvent): void {
    if (!event.uid || !this.deps.store.playlists || !this.deps.store.libraryTracks) return;

    const playlists = this.deps.store.playlists(event.uid, 500);
    const libraryTracks = this.deps.store.libraryTracks(event.uid, 10000);
    const recentEvents = this.profileEvidenceEvents(event);
    const existingMemories = [
      ...this.deps.store.memories(event.uid, "taste_fact", 24),
      ...this.deps.store.memories(event.uid, "taste_hypothesis", 24),
    ];
    const result = distillTasteFacts({
      uid: event.uid,
      libraryTracks,
      playlists,
      recentEvents,
      existingMemories,
    });
    const updatedAt = this.now();
    const evidenceItems = [...result.facts, ...result.hypotheses, ...result.sessionEvidence];
    if (!evidenceItems.length) return;

    for (const item of evidenceItems) {
      this.deps.store.upsertMemory({
        uid: event.uid,
        key: item.key,
        kind: item.kind,
        value: item.value,
        confidence: item.confidence,
        evidenceCount: item.evidenceCount,
        evidenceRefs: item.evidenceRefs,
        updatedAt,
      });
    }

    this.deps.store.saveArtifact(
      event.uid,
      "user_profile.md",
      buildUserProfileMarkdown({
        uid: event.uid,
        facts: result.facts,
        hypotheses: result.hypotheses,
        sessionEvidence: result.sessionEvidence,
        updatedAt,
      }),
      `${COMPACT_PROFILE_SOURCE_VERSION} tracks=${libraryTracks.length} playlists=${playlists.length} facts=${result.facts.length} hypotheses=${result.hypotheses.length} sessionEvidence=${result.sessionEvidence.length}`,
    );
    this.deps.store.appendEvent({
      uid: event.uid,
      sessionId: event.sessionId,
      type: "profile_artifacts_refreshed",
      priority: "warm",
      payload: {
        facts: result.facts.length,
        hypotheses: result.hypotheses.length,
        sessionEvidence: result.sessionEvidence.length,
        tracks: libraryTracks.length,
        playlists: playlists.length,
      },
      createdAt: updatedAt,
    });
  }

  private profileEvidenceEvents(event: RadioAgentEvent): RadioAgentEvent[] {
    if (!event.uid) return [];
    const sessionEvents = this.deps.store.recentEvents(event.uid, event.sessionId ?? null, 200);
    if (event.sessionId == null) return sessionEvents;

    const globalEvents = this.deps.store.recentEvents(event.uid, null, 100);
    const seen = new Set<string>();
    const merged: RadioAgentEvent[] = [];
    for (const item of [...sessionEvents, ...globalEvents]) {
      const key = item.id == null ? `${item.type}:${item.createdAt}` : `id:${item.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(item);
    }
    return merged;
  }

  private refreshStationArtifacts(event: RadioAgentEvent): void {
    if (!event.uid) return;

    const recentEvents = this.deps.store.recentEvents(event.uid, event.sessionId ?? null, 20);
    const sessionEvent = recentEvents.find((recentEvent) => recentEvent.type === "session_restored");
    const playbackEvents = recentEvents.filter((recentEvent) => recentEvent.type === "playback_started");
    const currentTrack = extractTrack(event.payload.track) || extractTrack(event.payload.currentTrack) || extractTrack(playbackEvents[0]?.payload.track);
    const recentTracks = playbackEvents.map((recentEvent) => extractTrack(recentEvent.payload.track)).filter(isTrack).slice(0, 5);
    const timezoneName = stringValue(event.payload.timezoneName) || stringValue(sessionEvent?.payload.timezoneName);
    const localTimeBlock = stringValue(event.payload.localTimeBlock) || stringValue(sessionEvent?.payload.localTimeBlock);
    const listenerStateHypothesis = listenerStateForEvent(event);
    const activeDirection = currentSessionDirection(recentEvents);

    this.deps.store.saveArtifact(
      event.uid,
      "station_now.md",
      buildStationNowMarkdown({
        localTimeBlock,
        timezoneName,
        currentTrack,
        recentTracks,
        listenerStateHypothesis,
        confidence: currentTrack || localTimeBlock ? "medium" : "low",
      }),
      `station-context/v1 session=${event.sessionId ?? "none"}`,
    );

    const sessionSummary = listenerSessionFromEvents(recentEvents, activeDirection, this.now());
    this.deps.store.saveArtifact(
      event.uid,
      "listener_session.md",
      buildListenerSessionMarkdown(sessionSummary),
      `${LISTENER_SESSION_SOURCE_VERSION} session=${event.sessionId ?? "none"}`,
    );

    const reflectionSummary = sessionReflectionFromEvents(recentEvents);
    this.deps.store.saveArtifact(
      event.uid,
      "session_reflection.md",
      buildSessionReflectionMarkdown({ ...reflectionSummary, updatedAt: this.now() }),
      `${SESSION_REFLECTION_SOURCE_VERSION} session=${event.sessionId ?? "none"}`,
    );

    const tasteFacts = this.deps.store.memories(event.uid, "taste_fact", 5);
    const tasteHypotheses = this.deps.store.memories(event.uid, "taste_hypothesis", 5);
    this.deps.store.saveArtifact(
      event.uid,
      "program_contract.md",
      buildProgramContractMarkdown({
        stationGoal: activeDirection?.stationGoal || stationGoalFromMemory(tasteFacts, localTimeBlock),
        allowedMoves: activeDirection?.allowedMoves || allowedMovesFromMemory(tasteFacts, tasteHypotheses),
        blockedMoves: [
          "Do not drift without a deliberate bridge.",
          "Do not treat one skip as permanent long-term dislike.",
          ...(activeDirection?.blockedMoves || []),
        ],
        hostStyle: "short, warm, low-interruption, and grounded in real listening evidence",
      }),
      `program-contract/v1 session=${event.sessionId ?? "none"}`,
    );
    this.deps.store.appendEvent({
      uid: event.uid,
      sessionId: event.sessionId,
      type: "station_context_refreshed",
      priority: "warm",
      payload: {
        currentTrack: currentTrack ? { id: currentTrack.id, name: currentTrack.name, artist: currentTrack.artist } : null,
        localTimeBlock,
        timezoneName,
      },
      createdAt: this.now(),
    });
  }

  private decideHost(event: RadioAgentEvent): RadioHostDecision {
    const recentDecisions = this.deps.store.latestShadowDecisions(event.uid, event.sessionId ?? null, 5);
    const recentHostLines = recentDecisions
      .filter((decision) => decision.decisionType === "host")
      .map((decision) => (typeof decision.payload.text === "string" ? decision.payload.text : ""))
      .filter(Boolean);
    return decideHostSpeech({
      eventType: event.type,
      recentHostLines,
      profileReady: Boolean(event.uid && this.deps.store.artifact(event.uid, "user_profile.md")),
      lowInterruption: event.type === "track_completed" || event.type === "playback_started",
      userText: typeof event.payload.text === "string" ? event.payload.text : "",
    });
  }

  private async planProgramWindow(event: RadioAgentEvent) {
    if (!this.deps.programDirector || !event.uid) return undefined;

    try {
      const memories = [
        ...this.deps.store.memories(event.uid, "taste_fact", 12),
        ...this.deps.store.memories(event.uid, "taste_hypothesis", 12),
      ];
      const artifacts = {
        "user_profile.md": this.deps.store.artifact(event.uid, "user_profile.md")?.content,
        "station_now.md": this.deps.store.artifact(event.uid, "station_now.md")?.content,
        "program_contract.md": this.deps.store.artifact(event.uid, "program_contract.md")?.content,
        "listener_session.md": this.deps.store.artifact(event.uid, "listener_session.md")?.content,
        "session_reflection.md": this.deps.store.artifact(event.uid, "session_reflection.md")?.content,
      };
      const currentTrack = extractTrack(event.payload.currentTrack) || extractTrack(event.payload.track);
      const readyQueue = extractReadyQueue(event.payload.readyQueue);
      const snapshot = buildRadioAgentContextSnapshot({
        uid: event.uid,
        sessionId: event.sessionId ?? null,
        eventType: event.type,
        artifacts,
        recentEvents: this.deps.store.recentEvents(event.uid, event.sessionId ?? null, 20),
        memories,
        currentTrack,
        readyQueue,
      });
      const window = await this.deps.programDirector.plan(snapshot);
      this.saveDecision(event, "program_window", { window });
      return window;
    } catch {
      return undefined;
    }
  }

  private saveDecision(event: RadioAgentEvent, decisionType: string, payload: Record<string, unknown>): void {
    this.deps.store.saveShadowDecision({
      id: this.nextDecisionId(decisionType),
      uid: event.uid,
      sessionId: event.sessionId,
      decisionType,
      payload,
      createdAt: this.now(),
    });
  }

  private nextDecisionId(type: string): string {
    this.sequence += 1;
    return `${type}-${this.now()}-${this.sequence}`;
  }
}

function scanCompletedWithFailures(event: RadioAgentEvent): boolean {
  const result = event.payload.result;
  if (!isRecord(result)) return false;
  return Array.isArray(result.failures) && result.failures.length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function extractTrack(value: unknown): Track | null {
  if (!isRecord(value)) return null;
  const id = stringValue(value.id || value.songId);
  const name = stringValue(value.name || value.songName);
  const artist = stringValue(value.artist);
  if (!id && !name) return null;
  return { id, name, artist };
}

function isTrack(value: Track | null): value is Track {
  return value !== null;
}

function extractReadyQueue(value: unknown): Track[] {
  if (!Array.isArray(value)) return [];
  return value.map(extractTrack).filter(isTrack);
}

function shouldRefreshProfileFromBehavior(event: RadioAgentEvent): boolean {
  return event.type === "track_completed" || event.type === "track_skipped" || event.type === "user_text";
}

function shouldPlanProgramWindow(event: RadioAgentEvent): boolean {
  if (event.type === "queue_low") return true;
  if (event.type !== "track_completed") return false;
  if (event.payload.queueLow === true) return true;

  const readyQueueCount = readyQueueCountFromPayload(event.payload);
  return readyQueueCount === 0;
}

function readyQueueCountFromPayload(payload: Record<string, unknown>): number | null {
  if (Array.isArray(payload.readyQueue)) return payload.readyQueue.length;
  if (typeof payload.readyQueueCount === "number" && Number.isFinite(payload.readyQueueCount)) return payload.readyQueueCount;
  if (typeof payload.readyQueueSize === "number" && Number.isFinite(payload.readyQueueSize)) return payload.readyQueueSize;
  return null;
}

function stringValue(value: unknown): string {
  return value == null ? "" : String(value).trim();
}

function listenerStateForEvent(event: RadioAgentEvent): string {
  if (event.type === "playback_started") return "music is active; keep interruption low unless a meaningful transition appears";
  if (event.type === "track_completed") return "ordinary continuation; speak only for a deliberate bridge or recovery";
  if (event.type === "session_restored") return "fresh or restored session; profile and context should warm in the background";
  return "unknown";
}

function currentSessionDirection(events: RadioAgentEvent[]): { stationGoal: string; allowedMoves: string[]; blockedMoves: string[] } | null {
  const explicit = events.find((event) => {
    if (event.type !== "user_text") return false;
    const text = stringValue(event.payload.text);
    return isRnbRequest(text);
  });
  if (!explicit) return null;

  return {
    stationGoal: "Keep the current radio session centered on R&B until the listener asks to move elsewhere.",
    allowedMoves: [
      "Prefer verified R&B, alt-R&B, neo-soul, and soft vocal tracks.",
      "Only use adjacent electronic color when the track is explicitly R&B, alt-R&B, or neo-soul.",
    ],
    blockedMoves: [
      "Do not fall back to EDM, classical, ambient piano, or old profile anchors unless they clearly support the R&B request.",
    ],
  };
}

function listenerSessionFromEvents(
  events: RadioAgentEvent[],
  activeDirection: { stationGoal: string; allowedMoves: string[]; blockedMoves: string[] } | null,
  updatedAt: string,
): Parameters<typeof buildListenerSessionMarkdown>[0] {
  const explicitUserText = events.find((event) => event.type === "user_text" && isRnbRequest(stringValue(event.payload.text)));
  const explicitText = stringValue(explicitUserText?.payload.text);
  const rejectedMoves = explicitText ? rejectedMovesFromText(explicitText) : [];
  const skipCorrections = events
    .filter((event) => event.type === "track_skipped")
    .map((event) => {
      const track = extractTrack(event.payload.track) || extractTrack(event.payload.currentTrack);
      return track ? `Skipped ${track.name || "unknown track"} - ${track.artist || "unknown artist"} as session evidence only.` : "";
    })
    .filter(Boolean)
    .slice(0, 4);
  const userCorrections = events
    .filter((event) => event.type === "user_text")
    .map((event) => stringValue(event.payload.text))
    .filter(Boolean)
    .slice(0, 4)
    .map((text) => `User said: ${text}`);

  if (activeDirection) {
    return {
      updatedAt,
      activeRequest: "R&B",
      acceptedDirection: "Keep the current session centered on R&B vocals, groove, and closely related soul textures.",
      rejectedMoves: dedupeStrings([
        ...rejectedMoves,
        "generic electronic",
        "EDM",
        "classical chamber music",
        "ambient piano",
        "old electronic/classical profile anchors unless they clearly support R&B",
      ]),
      recentCorrections: [...userCorrections, ...skipCorrections].slice(0, 6),
      openHypotheses: [
        "The listener wants the current session to stay in R&B; this is an active session constraint.",
        "Do not treat this request as a permanent dislike of electronic, classical, or ambient music.",
      ],
      nextPromise: "Stay in R&B until the listener asks to move elsewhere.",
      hostGuidance: "Acknowledge the R&B lane naturally; keep vocals and groove forward, and avoid vague filler.",
    };
  }

  return {
    updatedAt,
    activeRequest: explicitText || "none",
    acceptedDirection: "Keep the station coherent while stronger listener intent emerges.",
    rejectedMoves,
    recentCorrections: [...userCorrections, ...skipCorrections].slice(0, 6),
    openHypotheses: [
      "Use recent behavior as session evidence until repeated patterns justify long-term memory updates.",
    ],
    nextPromise: "Keep the current direction stable unless the listener corrects it.",
    hostGuidance: "Prefer a short concrete handoff over generic atmosphere talk; stay silent when there is nothing useful to add.",
  };
}

function sessionReflectionFromEvents(events: RadioAgentEvent[]): Omit<Parameters<typeof buildSessionReflectionMarkdown>[0], "updatedAt"> {
  const completedTracks = events
    .filter((event) => event.type === "track_completed")
    .map((event) => extractTrack(event.payload.track) || extractTrack(event.payload.currentTrack))
    .filter(isTrack)
    .slice(0, 8);
  const skippedTracks = events
    .filter((event) => event.type === "track_skipped")
    .map((event) => extractTrack(event.payload.track) || extractTrack(event.payload.currentTrack))
    .filter(isTrack)
    .slice(0, 8);
  const correctionTexts = events
    .filter((event) => event.type === "user_text")
    .map((event) => stringValue(event.payload.text))
    .filter((text) => looksReflectiveCorrection(text))
    .slice(0, 6);
  const distilled = distillTasteFacts({
    uid: events.find((event) => event.uid)?.uid || "",
    libraryTracks: [],
    playlists: [],
    recentEvents: events,
  });

  return {
    completedTracks,
    skippedTracks,
    correctionTexts,
    sessionSignals: dedupeStrings([
      ...distilled.hypotheses.map((item) => `${item.key}: ${item.value}`),
      ...distilled.sessionEvidence.map((item) => `${item.key}: ${item.value}`),
    ]).slice(0, 12),
    temporaryAvoids: dedupeStrings([
      ...skippedTracks.map((track) => track.id).filter(Boolean),
      ...correctionTexts.flatMap(rejectedMovesFromText),
    ]).slice(0, 12),
    longTermCandidates: distilled.hypotheses
      .filter((item) => item.evidenceCount >= 2)
      .map((item) => item.key)
      .slice(0, 8),
  };
}

function rejectedMovesFromText(text: string): string[] {
  const moves: string[] = [];
  if (/电子|electronic|edm|techno|trance|ambient/i.test(text)) moves.push("generic electronic");
  if (/古典|classical|chamber|concerto|sonata|quartet/i.test(text)) moves.push("classical chamber music");
  if (/氛围|ambient|piano/i.test(text)) moves.push("ambient piano");
  return dedupeStrings(moves);
}

function looksReflectiveCorrection(text: string): boolean {
  return /不要|别|不想|更喜欢|喜欢|想听|avoid|less|more|skip|prefer/i.test(text);
}

function dedupeStrings(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function isRnbRequest(text: string): boolean {
  return /\br\s*&?\s*b\b|\brnb\b/i.test(text);
}

function stationGoalFromMemory(facts: RadioAgentMemory[], localTimeBlock: string): string {
  const anchors = facts.slice(0, 3).map(memoryLabel).filter(Boolean);
  if (!anchors.length) return `Build a coherent ${localTimeBlock || "current"} radio session while profile confidence warms.`;
  return `Keep the radio close to familiar anchors like ${humanList(anchors)} while shaping a coherent ${
    localTimeBlock || "current"
  } session.`;
}

function allowedMovesFromMemory(facts: RadioAgentMemory[], hypotheses: RadioAgentMemory[]): string[] {
  const moves = [...facts.slice(0, 3), ...hypotheses.slice(0, 2)].map(listenerFacingMoveFromMemory).filter(Boolean);
  return moves.length ? moves : ["Stay close to the current track until stronger profile evidence is available."];
}

function listenerFacingMoveFromMemory(memory: RadioAgentMemory): string {
  const label = memoryLabel(memory);
  if (!label) return "";
  if (memory.key.startsWith("artist:")) return `Use ${label} as a familiar artist anchor when it fits the moment.`;
  if (memory.key.startsWith("album:")) return `Use ${label} as a familiar album texture when it fits the moment.`;
  if (memory.key.startsWith("theme:")) return `Treat ${label} as a tentative listening theme and verify it against the current session.`;
  return `Keep ${label} available as a soft programming clue.`;
}

function memoryLabel(memory: RadioAgentMemory): string {
  const keyed = memory.key.includes(":") ? memory.key.split(":").slice(1).join(":") : "";
  if (keyed.trim()) return keyed.replace(/-/g, " ").trim();

  const value = memory.value.trim();
  const forMatch = value.match(/\bfor\s+([^.;]+)/i);
  if (forMatch?.[1]) return forMatch[1].trim();
  const fromMatch = value.match(/\bfrom\s+([^.;]+)/i);
  if (fromMatch?.[1]) return fromMatch[1].trim();
  const mentionMatch = value.match(/\b(?:mention|suggest)\s+([^.;]+)/i);
  if (mentionMatch?.[1]) return mentionMatch[1].trim();
  return value.replace(/\bListener has\b/gi, "").replace(/\blibrary evidence\b/gi, "").trim();
}

function humanList(items: string[]): string {
  const unique = Array.from(new Set(items.map((item) => item.trim()).filter(Boolean)));
  if (unique.length <= 2) return unique.join(" and ");
  return `${unique.slice(0, -1).join(", ")} and ${unique[unique.length - 1]}`;
}
