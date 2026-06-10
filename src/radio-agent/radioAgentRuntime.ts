import type { LibraryCensus, LibraryCensusResult } from "./libraryCensus.js";
import { buildRadioAgentContextSnapshot } from "./agentContext.js";
import {
  buildAgentJournalMarkdown,
  buildAgentRepairMarkdown,
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
  type RadioAgentReadiness,
  type RadioAgentMode,
  type RadioAgentProgramWindow,
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
const AGENT_JOURNAL_SOURCE_VERSION = "agent-journal/v1";
const AGENT_REPAIR_SOURCE_VERSION = "agent-repair/v1";

interface ActiveSessionDirection {
  activeRequest: string;
  stationGoal: string;
  acceptedDirection: string;
  allowedMoves: string[];
  blockedMoves: string[];
  rejectedMoves?: string[];
  openHypotheses: string[];
  nextPromise: string;
  hostGuidance: string;
}

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
  readiness?: Partial<Pick<RadioAgentReadiness, "planner" | "speech">> & { reason?: string };
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

    if (event.type === "program_repair_needed" || event.type === "playback_recovery_needed") {
      this.saveExecutionRepair(persistedEvent);
    }

    if (event.type === "program_track_queued") {
      this.saveProgramTrackQueued(persistedEvent);
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
      controlsPlayback: this.deps.mode === "active" && Boolean(programWindow),
      event: persistedEvent,
      hostDecision,
      programWindow,
    };
  }

  status(uid: string | null, sessionId: number | null = null): RadioAgentStatus {
    const artifacts: RadioAgentStatus["artifacts"] = {};
    let explainability: RadioAgentStatus["explainability"] | undefined;
    if (uid) {
      for (const key of [
        "user_profile.md",
        "station_now.md",
        "program_contract.md",
        "listener_session.md",
        "session_reflection.md",
        "agent_journal.md",
        "agent_repair.md",
      ]) {
        const artifact = this.deps.store.artifact(uid, key);
        if (artifact) {
          artifacts[key] = {
            updatedAt: artifact.updatedAt,
            sourceVersion: artifact.sourceVersion,
          };
        }
      }
      explainability = agentExplainabilityStatus(
        this.deps.store.artifact(uid, "program_contract.md")?.content,
        this.deps.store.artifact(uid, "agent_journal.md")?.content,
        this.deps.store.artifact(uid, "agent_repair.md")?.content,
      );
    }

    return {
      mode: this.deps.mode,
      uid,
      sessionId,
      controlsPlayback: this.deps.mode === "active",
      readiness: agentReadinessStatus(this.deps.mode, this.deps.readiness),
      recentEvents: this.deps.store.recentEvents(uid, sessionId, 20),
      recentDecisions: this.deps.store.latestShadowDecisions(uid, sessionId, 20),
      artifacts,
      explainability,
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
    const recentEvents = dedupeCompletedListeningEvents(this.profileEvidenceEvents(event));
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
    const previousListenerSession =
      event.type === "session_restored" ? this.deps.store.artifact(event.uid, "listener_session.md")?.content : undefined;
    const previousProgramContract =
      event.type === "session_restored" ? this.deps.store.artifact(event.uid, "program_contract.md")?.content : undefined;
    const activeDirection =
      currentSessionDirection(recentEvents) || restoredSessionDirectionFromArtifacts(previousListenerSession, previousProgramContract);

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
        "agent_repair.md": this.deps.store.artifact(event.uid, "agent_repair.md")?.content,
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
      const plannedWindow = await this.deps.programDirector.plan(snapshot);
      const window = this.selfRepairProgramWindow(event, plannedWindow);
      this.saveDecision(event, "program_window", { window });
      this.saveAgentJournal(event, window);
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

  private saveAgentJournal(event: RadioAgentEvent, window: RadioAgentProgramWindow): void {
    if (!event.uid) return;
    const firstTask = window.candidateTasks[0];
    const guardrails = dedupeStrings([
      ...window.disallowed,
      ...(firstTask?.negativeConstraints || []),
      window.returnRequirement,
    ]).slice(0, 6);
    this.deps.store.saveArtifact(
      event.uid,
      "agent_journal.md",
      buildAgentJournalMarkdown({
        updatedAt: this.now(),
        eventType: event.type,
        observation: journalObservation(event, window),
        interpretation: window.mainDirection || window.stationBrief,
        action: firstTask
          ? `Next search direction: ${firstTask.query}. ${firstTask.reason}`
          : "No candidate task was ready; keep the current station stable while gathering more evidence.",
        guardrails,
        nextCheck: journalNextCheck(event),
      }),
      `${AGENT_JOURNAL_SOURCE_VERSION} session=${event.sessionId ?? "none"} source=${window.source}`,
    );
  }

  private saveProgramTrackQueued(event: RadioAgentEvent): void {
    if (!event.uid) return;
    const track = extractTrack(event.payload.track);
    const trackText = track ? `${track.name || "unknown track"} - ${track.artist || "unknown artist"}` : "the prepared track";
    const programWindowId = stringValue(event.payload.programWindowId);
    const traceId = stringValue(event.payload.traceId);
    const selectionReason = stringValue(event.payload.selectionReason);
    const hostText = stringValue(event.payload.hostText);
    const guardrails = dedupeStrings([
      programWindowId ? `program window ${programWindowId}` : "",
      traceId ? `decision id ${listenerFacingDecisionId(traceId)}` : "",
    ]);

    this.saveDecision(event, "program_track_queued", {
      track,
      programWindowId,
      traceId,
      selectionReason,
      hostText,
    });
    this.deps.store.saveArtifact(
      event.uid,
      "agent_journal.md",
      buildAgentJournalMarkdown({
        updatedAt: this.now(),
        eventType: event.type,
        observation: `Agent queued ${trackText} from its current program window.`,
        interpretation: selectionReason || "The queued track is the next concrete execution of the current radio program.",
        action: `Handed ${trackText} to the playback queue.${hostText ? ` Host handoff: ${hostText}` : ""}`,
        guardrails,
        nextCheck: "Watch whether the queued track plays, completes, or gets skipped before updating the station direction.",
      }),
      `${AGENT_JOURNAL_SOURCE_VERSION} session=${event.sessionId ?? "none"} source=execution`,
    );
  }

  private selfRepairProgramWindow(event: RadioAgentEvent, window: RadioAgentProgramWindow): RadioAgentProgramWindow {
    if (!event.uid) return window;
    const repair = planProgramRepair(window);
    if (!repair) return window;

    const repairedWindow: RadioAgentProgramWindow = {
      ...window,
      candidateTasks: repair.replacementTasks,
      disallowed: dedupeStrings([...window.disallowed, ...repair.guardrails]),
      returnRequirement: repair.correction,
      hostIntent: window.hostIntent.shouldSpeak
        ? window.hostIntent
        : {
            shouldSpeak: true,
            event: "return_to_contract",
            reason: "self repair",
            text: "我先把方向拉回 R&B，下一首会更贴近人声和律动。",
          },
    };

    this.saveDecision(event, "program_repair", {
      issue: repair.issue,
      evidence: repair.evidence,
      correction: repair.correction,
      nextAttempt: repair.replacementTasks[0]?.query || "",
    });
    this.deps.store.saveArtifact(
      event.uid,
      "agent_repair.md",
      buildAgentRepairMarkdown({
        updatedAt: this.now(),
        eventType: event.type,
        issue: repair.issue,
        evidence: repair.evidence,
        correction: repair.correction,
        guardrails: repair.guardrails,
        nextAttempt: repair.replacementTasks[0]?.query || "",
      }),
      `${AGENT_REPAIR_SOURCE_VERSION} session=${event.sessionId ?? "none"} source=${window.source}`,
    );
    return repairedWindow;
  }

  private saveExecutionRepair(event: RadioAgentEvent): void {
    if (!event.uid) return;
    const attemptedQueries = stringArrayFromUnknown(event.payload.attemptedQueries).slice(0, 8);
    const reason =
      stringValue(event.payload.reason) ||
      (event.type === "playback_recovery_needed"
        ? "playback could not recover a next track"
        : "program executor could not prepare a playable track");
    const programWindow = event.payload.programWindow;
    const currentTrack = extractTrack(event.payload.currentTrack) || extractTrack(event.payload.track);
    const nextAttempt = executionRepairNextAttempt(programWindow, attemptedQueries);
    const guardrails = executionRepairGuardrails(programWindow);
    const issue =
      event.type === "playback_recovery_needed"
        ? `Playback recovery could not continue after the current track: ${reason}.`
        : `Execution could not prepare a playable track: ${reason}.`;
    const correction =
      event.type === "playback_recovery_needed"
        ? "Treat this as a continuity failure, then immediately replan with a concrete, playable song before changing station direction."
        : "Treat the failed queries as weak negative evidence for this pass, then replan with safer concrete songs.";
    const evidence = dedupeStrings([
      ...attemptedQueries,
      currentTrack ? `${currentTrack.name || "Unknown"} - ${currentTrack.artist || "Unknown"}` : "",
    ]);

    this.saveDecision(event, "execution_repair", {
      issue,
      evidence,
      correction,
      nextAttempt,
    });
    this.deps.store.saveArtifact(
      event.uid,
      "agent_repair.md",
      buildAgentRepairMarkdown({
        updatedAt: this.now(),
        eventType: event.type,
        issue,
        evidence: evidence.length ? evidence : ["No playable candidate was prepared."],
        correction,
        guardrails,
        nextAttempt,
      }),
      `${AGENT_REPAIR_SOURCE_VERSION} session=${event.sessionId ?? "none"} source=execution_feedback`,
    );
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

function journalObservation(event: RadioAgentEvent, window: RadioAgentProgramWindow): string {
  const track = extractTrack(event.payload.currentTrack) || extractTrack(event.payload.track);
  const trackText = track ? `Current track is ${track.name || "unknown track"} - ${track.artist || "unknown artist"}.` : "";
  const eventText =
    event.type === "queue_low"
      ? "Queue is low, so the agent needs to prepare the next move."
      : event.type === "track_completed"
        ? "A track completed and the agent is checking whether the queue still supports the station."
        : event.type === "user_text"
          ? "The listener gave a direct request or correction."
          : `Recent event: ${event.type}.`;
  const directionText = window.mainDirection ? `Active direction: ${window.mainDirection}.` : "";
  return [eventText, trackText, directionText].filter(Boolean).join(" ");
}

function journalNextCheck(event: RadioAgentEvent): string {
  if (event.type === "queue_low" || event.type === "track_completed") {
    return "Watch the next completion, skip, or direct correction before changing the station direction.";
  }
  if (event.type === "user_text") {
    return "Check whether the next played track satisfies the listener request.";
  }
  return "Check the next listener action before promoting any new memory.";
}

function listenerFacingDecisionId(traceId: string): string {
  const compact = traceId
    .replace(/\btrace\b/gi, "")
    .replace(/^[._\-\s]+/u, "")
    .replace(/[^A-Za-z0-9._-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return compact || "latest";
}

interface ProgramRepairPlan {
  issue: string;
  evidence: string[];
  correction: string;
  guardrails: string[];
  replacementTasks: RadioAgentProgramWindow["candidateTasks"];
}

function planProgramRepair(window: RadioAgentProgramWindow): ProgramRepairPlan | null {
  const genericRepair = planGenericAvoidRepair(window);
  if (genericRepair) return genericRepair;

  if (!isActiveRnbWindow(window)) return null;
  const offContractTasks = window.candidateTasks.filter((task) => taskClearlyBreaksRnb(task));
  if (!offContractTasks.length) return null;
  const survivingTasks = window.candidateTasks.filter((task) => !taskClearlyBreaksRnb(task) && taskLooksRnbSafe(task));
  const replacementTasks = dedupeCandidateTasks([...survivingTasks, ...rnbRepairTasks(window)]).slice(0, 5);
  if (!replacementTasks.length) return null;

  return {
    issue: "Planned search moved outside the active R&B lane.",
    evidence: offContractTasks.map((task) => `${task.query}${task.style ? ` (${task.style})` : ""}`).slice(0, 5),
    correction: "Return the next attempt to late-night R&B before exploring adjacent styles again.",
    guardrails: dedupeStrings([
      "avoid generic electronic",
      "avoid classical chamber music",
      "avoid ambient piano",
      ...window.disallowed,
      ...offContractTasks.flatMap((task) => task.negativeConstraints),
    ]).slice(0, 8),
    replacementTasks,
  };
}

function planGenericAvoidRepair(window: RadioAgentProgramWindow): ProgramRepairPlan | null {
  const guardrails = dedupeStrings([
    ...window.disallowed,
    ...window.candidateTasks.flatMap((task) => task.negativeConstraints),
  ]).filter((item) => item.length >= 3);
  if (!guardrails.length) return null;

  const violatingTasks = window.candidateTasks.filter((task) => taskViolatesGuardrails(task, guardrails));
  if (!violatingTasks.length) return null;

  const replacementTasks = dedupeCandidateTasks(
    window.candidateTasks.filter((task) => !taskViolatesGuardrails(task, guardrails)),
  ).slice(0, 5);
  if (!replacementTasks.length) return null;

  return {
    issue: "Planned search violated the active station guardrails.",
    evidence: violatingTasks.map((task) => `${task.query}${task.style ? ` (${task.style})` : ""}`).slice(0, 5),
    correction: `Remove candidates that touch ${humanListForRepair(guardrails.slice(0, 3))}, and continue inside ${window.mainDirection || window.stationBrief || "the current station direction"}.`,
    guardrails: guardrails.slice(0, 8),
    replacementTasks,
  };
}

function taskViolatesGuardrails(task: RadioAgentProgramWindow["candidateTasks"][number], guardrails: string[]): boolean {
  const taskText = normalizeRepairText([task.query, task.style, task.reason].join(" "));
  if (!taskText) return false;
  return guardrails.some((guardrail) => {
    const normalizedGuardrail = normalizeRepairText(guardrail.replace(/^avoid\s+/i, ""));
    return Boolean(normalizedGuardrail && taskText.includes(normalizedGuardrail));
  });
}

function isActiveRnbWindow(window: RadioAgentProgramWindow): boolean {
  return isRnbTextForRepair(
    [
      window.stationBrief,
      window.mainDirection,
      window.returnRequirement,
      window.traceBasis.contract,
      window.traceBasis.session || "",
      window.traceBasis.reflection || "",
    ].join(" "),
  );
}

function taskClearlyBreaksRnb(task: RadioAgentProgramWindow["candidateTasks"][number]): boolean {
  const text = [task.query, task.style, task.reason].join(" ");
  if (isRnbTextForRepair(text)) return false;
  return /\b(nils frahm|max richter|debussy|bach|mozart|beethoven|chopin|sonata|concerto|string quartet|quartet|classical|ambient|piano|edm|techno|trance|festival|house|dubstep)\b/i.test(
    text,
  );
}

function taskLooksRnbSafe(task: RadioAgentProgramWindow["candidateTasks"][number]): boolean {
  const text = [task.query, task.style, task.reason].join(" ");
  return isRnbTextForRepair(text);
}

function rnbRepairTasks(window: RadioAgentProgramWindow): RadioAgentProgramWindow["candidateTasks"] {
  const anchor = rnbAnchorFromWindow(window);
  const negativeConstraints = dedupeStrings(["generic electronic", "classical chamber music", "ambient piano", ...window.disallowed]);
  const anchorTasks = anchor
    ? [
        {
          query: `${anchor} R&B`,
          reason: `Return to the listener's active R&B direction using ${anchor} as the anchor.`,
          style: "late-night R&B",
          negativeConstraints,
        },
      ]
    : [];
  return [
    ...anchorTasks,
    {
      query: "Frank Ocean Pink + White",
      reason: "Conservative late-night R&B repair candidate.",
      style: "late-night R&B",
      negativeConstraints,
    },
    {
      query: "SZA Broken Clocks",
      reason: "Keeps the station in vocal R&B after a drift risk.",
      style: "late-night R&B",
      negativeConstraints,
    },
    {
      query: "Daniel Caesar Japanese Denim",
      reason: "Warm R&B fallback for station recovery.",
      style: "late-night R&B",
      negativeConstraints,
    },
  ];
}

function rnbAnchorFromWindow(window: RadioAgentProgramWindow): string {
  const text = [window.traceBasis.reflection || "", window.traceBasis.profile || "", window.mainDirection].join("\n");
  for (const pattern of [
    /(?:session_)?artist:([^:\n.;]+)/i,
    /\brepeatedly returned to\s+([^.;\n]+)/i,
    /\b(Frank Ocean|SZA|Daniel Caesar|H\.?E\.?R\.?|Brent Faiyaz|Jorja Smith|Kelela|Ravyn Lenae|Snoh Aalegra|Giveon|Summer Walker)\b/i,
  ]) {
    const match = text.match(pattern)?.[1]?.trim();
    if (match && isRnbTextForRepair(match)) return match;
  }
  return "";
}

function dedupeCandidateTasks(tasks: RadioAgentProgramWindow["candidateTasks"]): RadioAgentProgramWindow["candidateTasks"] {
  const seen = new Set<string>();
  const result: RadioAgentProgramWindow["candidateTasks"] = [];
  for (const task of tasks) {
    const key = task.query.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(task);
  }
  return result;
}

function normalizeRepairText(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9&.+ ]/g, " ").replace(/\s+/g, " ").trim();
}

function humanListForRepair(items: string[]): string {
  const clean = dedupeStrings(items);
  if (clean.length <= 2) return clean.join(" and ");
  return `${clean.slice(0, -1).join(", ")} and ${clean[clean.length - 1]}`;
}

function isRnbTextForRepair(text: string): boolean {
  return /\br\s*&?\s*b\b|\brnb\b|alt[-\s]?r\s*&?\s*b|neo[-\s]?soul|slow jam|frank ocean|sza|daniel caesar|h\.?e\.?r\.?|brent faiyaz|jorja smith|kelela|ravyn lenae|snoh aalegra|giveon|summer walker|the weeknd|partynextdoor/i.test(
    text,
  );
}

function executionRepairNextAttempt(programWindow: unknown, attemptedQueries: string[]): string {
  const window = isRecord(programWindow) ? programWindow : null;
  const direction = stringValue(window?.mainDirection) || stringValue(window?.stationBrief);
  if (isRnbTextForRepair(direction)) return "Replan with concrete late-night R&B songs such as Frank Ocean, SZA, or Daniel Caesar.";
  const remainingCandidate = Array.isArray(window?.candidateTasks)
    ? window.candidateTasks
        .map((task) => (isRecord(task) ? stringValue(task.query) : ""))
        .find((query) => query && !attemptedQueries.includes(query))
    : "";
  if (remainingCandidate) return remainingCandidate;
  return direction ? `Replan with a more concrete song inside ${direction}.` : "Replan with a more concrete, playable song.";
}

function executionRepairGuardrails(programWindow: unknown): string[] {
  const window = isRecord(programWindow) ? programWindow : null;
  const disallowed = Array.isArray(window?.disallowed) ? window.disallowed.map(stringValue).filter(Boolean) : [];
  const candidateConstraints = Array.isArray(window?.candidateTasks)
    ? window.candidateTasks.flatMap((task) => {
        if (!isRecord(task) || !Array.isArray(task.negativeConstraints)) return [];
        return task.negativeConstraints.map(stringValue).filter(Boolean);
      })
    : [];
  return dedupeStrings([
    "avoid repeating failed unplayable queries in the immediate retry",
    ...disallowed,
    ...candidateConstraints,
  ]).slice(0, 8);
}

function agentExplainabilityStatus(
  contractMarkdown: string | undefined,
  journalMarkdown: string | undefined,
  repairMarkdown: string | undefined,
): RadioAgentStatus["explainability"] | undefined {
  const contract = contractMarkdown
    ? {
        stationGoal: markdownFieldLine(contractMarkdown, "station_goal"),
        allowedMoves: markdownSectionItemsSafe(contractMarkdown, "Allowed Moves", 2),
        blockedMoves: markdownSectionItemsSafe(contractMarkdown, "Blocked Moves", 2),
      }
    : undefined;
  const journal = journalMarkdown
    ? {
        observation: markdownSectionFirstItem(journalMarkdown, "Observation"),
        interpretation: markdownSectionFirstItem(journalMarkdown, "Interpretation"),
        action: markdownSectionFirstItem(journalMarkdown, "Action"),
        nextCheck: markdownSectionFirstItem(journalMarkdown, "Next Check"),
      }
    : undefined;
  const repair = repairMarkdown
    ? {
        issue: markdownSectionFirstItem(repairMarkdown, "Issue"),
        correction: markdownSectionFirstItem(repairMarkdown, "Correction"),
        nextAttempt: markdownSectionFirstItem(repairMarkdown, "Next Attempt"),
      }
    : undefined;

  if (!contract && !journal && !repair) return undefined;
  return {
    ...(contract && (contract.stationGoal || contract.allowedMoves.length || contract.blockedMoves.length) ? { contract } : {}),
    ...(journal && Object.values(journal).some(Boolean) ? { journal } : {}),
    ...(repair && Object.values(repair).some(Boolean) ? { repair } : {}),
  };
}

function markdownFieldLine(markdown: string, field: string): string {
  const escapedField = field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = markdown.match(new RegExp(`^${escapedField}:\\s*(.+)$`, "im"));
  return safeExplainabilityLine(match?.[1] || "");
}

function markdownSectionItemsSafe(markdown: string, heading: string, limit: number): string[] {
  const lines = markdown.split(/\r?\n/u);
  const items: string[] = [];
  let inSection = false;
  for (const line of lines) {
    if (/^##\s+/u.test(line)) {
      inSection = line.replace(/^##\s+/u, "").trim().toLowerCase() === heading.toLowerCase();
      continue;
    }
    if (!inSection) continue;
    const item = safeExplainabilityLine(line.replace(/^\s*-\s*/u, ""));
    if (item && item.toLowerCase() !== "none") items.push(item);
    if (items.length >= limit) break;
  }
  return items;
}

function markdownSectionFirstItem(markdown: string, heading: string): string {
  const lines = markdown.split(/\r?\n/u);
  let inSection = false;
  for (const line of lines) {
    if (/^##\s+/u.test(line)) {
      inSection = line.replace(/^##\s+/u, "").trim().toLowerCase() === heading.toLowerCase();
      continue;
    }
    if (!inSection) continue;
    const item = safeExplainabilityLine(line.replace(/^\s*-\s*/u, ""));
    if (item && item.toLowerCase() !== "none") return item;
  }
  return "";
}

function safeExplainabilityLine(value: string): string {
  const compact = value.replace(/\s+/g, " ").trim();
  if (!compact) return "";
  if (/\b(model|prompt|json|tool call|shadow decision|decision trace|trace basis|verification)\b/i.test(compact)) {
    return "";
  }
  return compact.slice(0, 220).trim();
}

function agentReadinessStatus(
  mode: RadioAgentMode,
  readiness?: RadioAgentRuntimeDeps["readiness"],
): RadioAgentReadiness {
  const planner = readiness?.planner || (mode === "shadow" ? "disabled" : "available");
  const speech = readiness?.speech || "available";
  const reason = safeReadinessReason(readiness?.reason || "");

  return {
    mode,
    planner,
    speech,
    summary: readinessSummary(mode, planner, speech, reason),
  };
}

function readinessSummary(
  mode: RadioAgentMode,
  planner: RadioAgentReadiness["planner"],
  speech: RadioAgentReadiness["speech"],
  reason: string,
): string {
  if (mode === "shadow") {
    return "Agent is in shadow mode, so it is learning and explaining without steering playback.";
  }
  if (planner === "degraded" || speech === "degraded") {
    return reason || `Agent is in ${mode} mode, but planning or speech is degraded; using deterministic fallback where needed.`;
  }
  if (planner === "disabled") {
    return `Agent is in ${mode} mode, but autonomous planning is disabled.`;
  }
  return `Agent is in ${mode} mode and can plan the station with assisted intelligence.`;
}

function safeReadinessReason(value: string): string {
  return value
    .replace(/\btp-[A-Za-z0-9._-]+/g, "[redacted]")
    .replace(/\b(api[_-]?key|secret|token|bearer|prompt|json|tool call|trace basis|decision trace)\b/gi, "")
    .replace(/\b(LLM|large language model|model)\b/gi, "planning")
    .replace(/\bTTS\b/g, "voice")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 220)
    .trim();
}

function shouldRefreshProfileFromBehavior(event: RadioAgentEvent): boolean {
  return event.type === "track_completed" || event.type === "track_skipped" || event.type === "user_text";
}

function shouldPlanProgramWindow(event: RadioAgentEvent): boolean {
  if (event.type === "user_text") return shouldPlanFromUserText(stringValue(event.payload.text));
  if (event.type === "queue_low") return true;
  if (event.type === "program_repair_needed") return true;
  if (event.type !== "track_completed") return false;
  if (event.payload.queueLow === true) return true;

  const readyQueueCount = readyQueueCountFromPayload(event.payload);
  return readyQueueCount === 0;
}

function shouldPlanFromUserText(text: string): boolean {
  if (!text) return false;
  if (isExplanationQuestion(text)) return false;
  if (isRnbRequest(text)) return true;
  if (negativeArtistMovesFromText(text).length > 0) return true;
  if (positiveArtistRequestFromText(text)) return true;
  return looksLikeMusicDirection(text);
}

function isExplanationQuestion(text: string): boolean {
  return /为什么|为啥|哪里适合|怎么理解|理由|原因|why\s+(?:this|that|the)\s+(?:song|track)|why\s+did\s+you\s+(?:play|choose)/iu.test(text);
}

function looksLikeMusicDirection(text: string): boolean {
  return /(?:放点|播放|来点|想听|听点|听些|换成|换点|more\s+|play\s+|put on\s+|queue\s+|give me\s+).{1,80}|r\s*&?\s*b|rnb|jazz|hip[-\s]?hop|soul|pop|rock|ambient|classical|city\s*pop|shoegaze|edm|electronic|古典|爵士|电子|氛围|民谣|摇滚|流行|说唱|人声|律动/iu.test(text);
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

function stringArrayFromUnknown(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(stringValue).filter(Boolean);
}

function listenerStateForEvent(event: RadioAgentEvent): string {
  if (event.type === "playback_started") return "music is active; keep interruption low unless a meaningful transition appears";
  if (event.type === "track_completed") return "ordinary continuation; speak only for a deliberate bridge or recovery";
  if (event.type === "session_restored") return "fresh or restored session; profile and context should warm in the background";
  return "unknown";
}

function currentSessionDirection(events: RadioAgentEvent[]): ActiveSessionDirection | null {
  const explicitEvent = events.find((event) => {
    if (event.type !== "user_text") return false;
    const text = stringValue(event.payload.text);
    return isRnbRequest(text) || Boolean(positiveArtistRequestFromText(text)) || negativeArtistMovesFromText(text).length > 0;
  });
  if (!explicitEvent) return null;

  const explicitText = stringValue(explicitEvent.payload.text);
  const explicitAvoids = negativeArtistMovesFromText(explicitText);
  if (explicitAvoids.length > 0) {
    const avoidLabel = humanList(explicitAvoids);
    return {
      activeRequest: `Avoid ${avoidLabel}`,
      stationGoal: `Move the current radio session away from ${avoidLabel} while keeping the broader station coherent.`,
      acceptedDirection: `Avoid ${avoidLabel} for this session and choose nearby music that does not repeat the rejected direction.`,
      allowedMoves: [
        "Use adjacent tracks only when they avoid the rejected artist direction.",
        "Keep the broader station coherent while replacing the rejected anchor.",
      ],
      blockedMoves: [
        ...explicitAvoids.map((artist) => `Do not play ${artist} unless the listener asks for it again.`),
        "Do not let older profile anchors override this explicit correction.",
      ],
      rejectedMoves: explicitAvoids,
      openHypotheses: [
        `The listener explicitly corrected away from ${avoidLabel}; treat this as a session constraint, not a permanent dislike.`,
        "Wait for repeated evidence before weakening durable taste memory.",
      ],
      nextPromise: `Avoid ${avoidLabel} unless the listener asks for it again.`,
      hostGuidance: `Acknowledge the correction briefly if speaking, then move away from ${avoidLabel} without overexplaining.`,
    };
  }

  const explicitArtist = positiveArtistRequestFromText(explicitText);
  if (explicitArtist) {
    return {
      activeRequest: explicitArtist,
      stationGoal: `Keep the current radio session centered on ${explicitArtist} until the listener asks to move elsewhere.`,
      acceptedDirection: `Keep this session close to ${explicitArtist}: start from that artist as the primary anchor, then use nearby tracks only when they support the same feel.`,
      allowedMoves: [
        `Use ${explicitArtist} as the primary session anchor.`,
        "Use adjacent artists or tracks only when they clearly support the requested artist direction.",
      ],
      blockedMoves: [
        "Do not let older profile anchors override this explicit session request.",
      ],
      openHypotheses: [
        `The listener explicitly asked for more ${explicitArtist}; treat this as a session preference until playback confirms it.`,
        "Do not promote this into a durable preference without repeated evidence or completed listening.",
      ],
      nextPromise: `Stay close to ${explicitArtist} until the listener asks to move elsewhere.`,
      hostGuidance: `Acknowledge ${explicitArtist} naturally if speaking, then keep the handoff concrete and low-interruption.`,
    };
  }

  if (isRnbRequest(explicitText)) {
    return {
      activeRequest: "R&B",
      stationGoal: "Keep the current radio session centered on R&B until the listener asks to move elsewhere.",
      acceptedDirection: "Keep the current session centered on R&B vocals, groove, and closely related soul textures.",
      allowedMoves: [
        "Prefer verified R&B, alt-R&B, neo-soul, and soft vocal tracks.",
        "Only use adjacent electronic color when the track is explicitly R&B, alt-R&B, or neo-soul.",
      ],
      blockedMoves: [
        "Do not fall back to EDM, classical, ambient piano, or old profile anchors unless they clearly support the R&B request.",
      ],
      rejectedMoves: [
        "generic electronic",
        "EDM",
        "classical chamber music",
        "ambient piano",
        "old electronic/classical profile anchors unless they clearly support R&B",
      ],
      openHypotheses: [
        "The listener wants the current session to stay in R&B; this is an active session constraint.",
        "Do not treat this request as a permanent dislike of electronic, classical, or ambient music.",
      ],
      nextPromise: "Stay in R&B until the listener asks to move elsewhere.",
      hostGuidance: "Acknowledge the R&B lane naturally; keep vocals and groove forward, and avoid vague filler.",
    };
  }

  return null;
}

function restoredSessionDirectionFromArtifacts(
  listenerSessionMarkdown: string | undefined,
  programContractMarkdown: string | undefined,
): ActiveSessionDirection | null {
  const activeRequest = markdownField(listenerSessionMarkdown, "active_request");
  if (!activeRequest || /^(none|unknown)$/i.test(activeRequest)) return null;

  const stationGoal =
    markdownField(programContractMarkdown, "station_goal") ||
    `Keep the current radio session centered on ${activeRequest} until the listener asks to move elsewhere.`;
  const acceptedDirection =
    markdownField(listenerSessionMarkdown, "accepted_direction") ||
    `Continue the restored ${activeRequest} station contract until the listener changes direction.`;
  const nextPromise =
    markdownField(listenerSessionMarkdown, "next_promise") ||
    `Stay close to ${activeRequest} until the listener asks to move elsewhere.`;
  const allowedMoves = markdownSectionItems(programContractMarkdown, "Allowed Moves");
  const blockedMoves = markdownSectionItems(programContractMarkdown, "Blocked Moves");
  const rejectedMoves = markdownSectionItems(listenerSessionMarkdown, "Rejected Moves");
  const openHypotheses = markdownSectionItems(listenerSessionMarkdown, "Open Hypotheses");
  const hostGuidance =
    markdownSectionItems(listenerSessionMarkdown, "DJ Stance").find((item) => !/session requests|promote one skip|internal planning/i.test(item)) ||
    `If speaking, acknowledge the restored ${activeRequest} lane briefly and keep the next handoff concrete.`;

  return {
    activeRequest,
    stationGoal,
    acceptedDirection,
    allowedMoves: allowedMoves.length
      ? allowedMoves
      : [`Continue the restored ${activeRequest} direction unless the listener changes it.`],
    blockedMoves: blockedMoves.length
      ? blockedMoves
      : ["Do not let a restart erase the active station request."],
    rejectedMoves,
    openHypotheses: openHypotheses.length
      ? openHypotheses
      : [`The restored session was actively operating inside ${activeRequest}.`],
    nextPromise,
    hostGuidance,
  };
}

function markdownField(markdown: string | undefined, field: string): string {
  if (!markdown) return "";
  const escapedField = field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = markdown.match(new RegExp(`^${escapedField}:\\s*(.+)$`, "im"));
  return stringValue(match?.[1]);
}

function markdownSectionItems(markdown: string | undefined, heading: string): string[] {
  if (!markdown) return [];
  const lines = markdown.split(/\r?\n/u);
  const items: string[] = [];
  let inSection = false;
  for (const line of lines) {
    if (/^##\s+/u.test(line)) {
      inSection = line.replace(/^##\s+/u, "").trim().toLowerCase() === heading.toLowerCase();
      continue;
    }
    if (!inSection) continue;
    const item = line.replace(/^\s*-\s*/u, "").trim();
    if (!item || item.toLowerCase() === "none") continue;
    items.push(item);
  }
  return dedupeStrings(items);
}

function listenerSessionFromEvents(
  events: RadioAgentEvent[],
  activeDirection: ActiveSessionDirection | null,
  updatedAt: string,
): Parameters<typeof buildListenerSessionMarkdown>[0] {
  const explicitUserText = events.find((event) => event.type === "user_text" && isRnbRequest(stringValue(event.payload.text)));
  const explicitText = stringValue(explicitUserText?.payload.text);
  const correctionTexts = events
    .filter((event) => event.type === "user_text")
    .map((event) => stringValue(event.payload.text))
    .filter((text) => looksReflectiveCorrection(text))
    .slice(0, 6);
  const rejectedMoves = dedupeStrings([
    ...(explicitText ? rejectedMovesFromText(explicitText) : []),
    ...correctionTexts.flatMap(rejectedMovesFromText),
  ]);
  const skipCorrections = events
    .filter((event) => event.type === "track_skipped")
    .map((event) => {
      const track = extractTrack(event.payload.track) || extractTrack(event.payload.currentTrack);
      return track ? `Skipped ${track.name || "unknown track"} - ${track.artist || "unknown artist"} as session evidence only.` : "";
    })
    .filter(Boolean)
    .slice(0, 4);
  const userCorrections = correctionTexts.slice(0, 4).map((text) => `User said: ${text}`);

  if (activeDirection) {
    return {
      updatedAt,
      activeRequest: activeDirection.activeRequest,
      acceptedDirection: activeDirection.acceptedDirection,
      rejectedMoves: dedupeStrings([...rejectedMoves, ...(activeDirection.rejectedMoves || [])]),
      recentCorrections: [...userCorrections, ...skipCorrections].slice(0, 6),
      openHypotheses: activeDirection.openHypotheses,
      nextPromise: activeDirection.nextPromise,
      hostGuidance: activeDirection.hostGuidance,
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
  const behaviorEvents = dedupeCompletedListeningEvents(events);
  const completedTracks = behaviorEvents
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
    recentEvents: behaviorEvents,
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

function dedupeCompletedListeningEvents(events: RadioAgentEvent[]): RadioAgentEvent[] {
  const keep = new Set<RadioAgentEvent>();
  const lastCompletedBySession = new Map<string, string>();

  for (const event of [...events].reverse()) {
    if (event.type === "playback_started") {
      lastCompletedBySession.delete(completedListeningScopeKey(event));
      keep.add(event);
      continue;
    }

    if (event.type !== "track_completed") {
      keep.add(event);
      continue;
    }

    const track = extractTrack(event.payload.track) || extractTrack(event.payload.currentTrack);
    const trackKey = completedListeningTrackKey(track);
    if (!trackKey) {
      keep.add(event);
      continue;
    }

    const scopeKey = completedListeningScopeKey(event);
    if (lastCompletedBySession.get(scopeKey) === trackKey) continue;
    lastCompletedBySession.set(scopeKey, trackKey);
    keep.add(event);
  }

  return events.filter((event) => keep.has(event));
}

function completedListeningScopeKey(event: RadioAgentEvent): string {
  return `${event.uid || "anonymous"}:${event.sessionId ?? "sessionless"}`;
}

function completedListeningTrackKey(track: Track | null): string {
  if (!track) return "";
  if (track.id) return `id:${track.id}`;
  return `text:${normalizeListeningKey(track.name)}|${normalizeListeningKey(track.artist)}`;
}

function normalizeListeningKey(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function rejectedMovesFromText(text: string): string[] {
  const moves: string[] = [];
  if (/电子|electronic|edm|techno|trance|ambient/i.test(text)) moves.push("generic electronic");
  if (/古典|classical|chamber|concerto|sonata|quartet/i.test(text)) moves.push("classical chamber music");
  if (/氛围|ambient|piano/i.test(text)) moves.push("ambient piano");
  moves.push(...negativeArtistMovesFromText(text));
  return dedupeStrings(moves);
}

function looksReflectiveCorrection(text: string): boolean {
  return /不要|别|不想|更喜欢|喜欢|想听|avoid|less|more|skip|prefer/i.test(text);
}

function positiveArtistRequestFromText(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  if (/^\s*(less|avoid|skip|no|don't|dont|do not|dislike)\b/i.test(normalized)) return "";
  if (/不要|别放|别播|不想|少来点/.test(normalized.slice(0, 12))) return "";

  const patterns = [
    /\b(?:play|queue|put on|give me|want|need|like|love|prefer)\s+(?:some\s+|more\s+|tracks?\s+by\s+|songs?\s+by\s+)?([A-Z][A-Za-z0-9 .+'&-]{1,48}?)(?:\s+(?:lately|tonight|today|please|pls|now|next|tracks?|songs?|music|radio|vibes?))?(?:[.!?]|$)/i,
    /\bmore\s+of\s+([A-Z][A-Za-z0-9 .+'&-]{1,48}?)(?:\s+(?:lately|tonight|today|please|pls|now|next|tracks?|songs?|music|radio|vibes?))?(?:[.!?]|$)/i,
    /\bmore\s+([A-Z][A-Za-z0-9 .+'&-]{1,48}?)(?:\s+(?:lately|tonight|today|please|pls|now|next|tracks?|songs?|music|radio|vibes?))?(?:[.!?]|$)/i,
  ];
  const match = patterns.map((pattern) => normalized.match(pattern)).find((candidate) => candidate?.[1]);
  const artist = cleanArtistRequest(match?.[1] || "");
  if (!artist || isGenericAvoidMove(artist)) return "";

  const index = normalized.toLowerCase().indexOf(artist.toLowerCase());
  const before = index >= 0 ? normalized.toLowerCase().slice(Math.max(0, index - 24), index) : "";
  if (/\b(less|avoid|skip|not|no|don't|dont|dislike)\b/.test(before)) return "";
  return artist;
}

function negativeArtistMovesFromText(text: string): string[] {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return [];

  return dedupeStrings([
    ...matchesForPattern(
      normalized,
      /(?:不要|别放|别播|不想(?:要|听|放|播)?|少来点)\s*([A-Z][A-Za-z0-9 .+'&-]{1,48})(?=\s*(?:了|啦|吧|嘛|呀|今晚|今天|现在|下一首|tonight|today|please|pls|now|next|tracks?|songs?|music|radio|vibes?)?(?:[，,。.!?]|$))/giu,
    ),
    ...matchesForPattern(normalized, /\b(?:less|avoid|skip|no)\s+([A-Z][A-Za-z0-9 .+'&-]{1,48}?)(?=\s+(?:tonight|today|please|pls|now|next|tracks?|songs?|music|radio|vibes?)|[,.!?]|$)/gi),
    ...matchesForPattern(normalized, /\b(?:don't|dont|do not)\s+(?:play|queue|put on|give me)?\s*([A-Z][A-Za-z0-9 .+'&-]{1,48}?)(?=\s+(?:tonight|today|please|pls|now|next|tracks?|songs?|music|radio|vibes?)|[,.!?]|$)/gi),
  ]).filter((artist) => !isGenericAvoidMove(artist));
}

function matchesForPattern(text: string, pattern: RegExp): string[] {
  return Array.from(text.matchAll(pattern))
    .map((match) => cleanAvoidMove(match[1] || ""))
    .filter(Boolean);
}

function cleanAvoidMove(value: string): string {
  return value
    .replace(/\s+/g, " ")
    .replace(/\s+(?:tonight|today|please|pls|now|next|tracks?|songs?|music|radio|vibes?)$/i, "")
    .replace(/[，,。.!?]+$/u, "")
    .trim();
}

function cleanArtistRequest(value: string): string {
  return value
    .replace(/\s+/g, " ")
    .replace(/\s+(?:lately|tonight|today|please|pls|now|next|tracks?|songs?|music|radio|vibes?)$/i, "")
    .replace(/[.,!?]+$/u, "")
    .trim();
}

function isGenericAvoidMove(value: string): boolean {
  return /\b(classical|edm|rnb|r&b|jazz|ambient|pop|rock|hip hop|soul|music|songs?|tracks?)\b/i.test(value);
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
