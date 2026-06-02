import type { LibraryCensus, LibraryCensusResult } from "./libraryCensus.js";
import { decideHostSpeech } from "./hostPolicy.js";
import {
  normalizeRadioAgentEvent,
  type RadioAgentEvent,
  type RadioAgentHandleResult,
  type RadioAgentMemory,
  type RadioAgentMode,
  type RadioAgentStatus,
  type RadioHostDecision,
  type RadioShadowDecision,
} from "./types.js";
import type { RadioAgentArtifactRecord } from "../storage/radioAgentStore.js";

interface RadioAgentRuntimeStore {
  appendEvent(event: RadioAgentEvent): number;
  recentEvents(uid: string | null, sessionId: number | null, limit: number): RadioAgentEvent[];
  upsertMemory(memory: RadioAgentMemory): void;
  memories(uid: string, kind: string, limit: number): RadioAgentMemory[];
  saveArtifact(uid: string, artifactKey: string, content: string, sourceVersion: string): void;
  artifact(uid: string, artifactKey: string): RadioAgentArtifactRecord | null;
  saveShadowDecision(decision: RadioShadowDecision): void;
  latestShadowDecisions(uid: string | null, sessionId: number | null, limit: number): RadioShadowDecision[];
}

export interface RadioAgentRuntimeDeps {
  mode: RadioAgentMode;
  store: RadioAgentRuntimeStore;
  census?: Pick<LibraryCensus, "scan">;
  now?: () => string;
}

export class RadioAgentRuntime {
  private readonly now: () => string;
  private readonly backgroundWork = new Set<Promise<unknown>>();
  private sequence = 0;

  constructor(private readonly deps: RadioAgentRuntimeDeps) {
    this.now = deps.now ?? (() => new Date().toISOString());
  }

  async handle(input: Record<string, unknown>): Promise<RadioAgentHandleResult> {
    const event = normalizeRadioAgentEvent({ ...input, createdAt: input.createdAt || this.now() });
    const id = this.deps.store.appendEvent(event);
    const persistedEvent = { ...event, id };

    if (event.type === "login_completed" && event.uid) {
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

    if (event.type === "track_skipped") {
      this.saveSessionEvidence(event, "skip", "Single skip recorded as session evidence, not a permanent dislike.");
    }

    const hostDecision = this.decideHost(persistedEvent);
    this.saveDecision(event, "host", hostDecision);

    return {
      controlsPlayback: false,
      event: persistedEvent,
      hostDecision,
    };
  }

  status(uid: string | null, sessionId: number | null = null): RadioAgentStatus {
    const artifacts: RadioAgentStatus["artifacts"] = {};
    if (uid) {
      for (const key of ["user_profile.md", "station_now.md", "program_contract.md"]) {
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

  private startLibraryScan(event: RadioAgentEvent): void {
    if (!event.uid || !this.deps.census) return;
    const work = this.deps.census
      .scan(event.uid)
      .then((result) => this.recordScanCompleted(event, result))
      .catch((error: unknown) => this.recordScanFailed(event, error))
      .finally(() => {
        this.backgroundWork.delete(work);
      });
    this.backgroundWork.add(work);
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
