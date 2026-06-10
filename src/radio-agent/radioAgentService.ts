import type { Track } from "../types.js";
import { hostTextForRadioAgentDelivery } from "./hostDelivery.js";
import { chooseOpeningTrack as defaultChooseOpeningTrack, type OpeningTrackArgs, type OpeningTrackPick } from "./openingTrack.js";
import type { RadioAgentHandleResult, RadioAgentPreparedTrack, RadioAgentProgramWindow, RadioAgentEventType, RadioHostDecision } from "./types.js";

export interface RadioAgentSessionStartArgs extends OpeningTrackArgs {
  uid: string | null;
  sessionId: number | null;
}

export interface RadioAgentSessionStartResult {
  opening?: RadioAgentPreparedTrack;
  hostText?: string;
  backgroundStarted: boolean;
  fallbackReason?: string;
}

export interface RadioAgentUserTextArgs {
  uid: string | null;
  sessionId: number | null;
  text: string;
  currentTrack: Record<string, unknown> | null;
  readyQueue: Record<string, unknown>[];
  shouldClearQueue: boolean;
}

export interface RadioAgentUserTextResult {
  agentResult: RadioAgentHandleResult | null;
  programWindow?: RadioAgentProgramWindow;
  preparedTrack?: RadioAgentPreparedTrack;
  programQueued: boolean;
  hostText: string;
  shouldClearQueue: boolean;
}

export interface RadioAgentCorrectionArgs {
  uid: string | null;
  sessionId: number | null;
  text: string;
  currentTrack: Record<string, unknown> | null;
  readyQueue: Record<string, unknown>[];
}

export type RadioAgentCorrectionResult = RadioAgentUserTextResult;

export interface RadioAgentTrackEndedArgs {
  uid: string | null;
  sessionId: number | null;
  previousEvent: "played" | "skipped";
  currentTrack: Record<string, unknown> | null;
  readyQueue: Record<string, unknown>[];
}

export interface RadioAgentTrackEndedResult {
  action: "promote_ready" | "queued_program" | "legacy_fallback";
  agentResult: RadioAgentHandleResult | null;
  programWindow?: RadioAgentProgramWindow;
  programQueued: boolean;
  hostText: string;
  fallbackReason?: string;
}

export interface RadioAgentHostTextArgs {
  eventType: RadioAgentEventType;
  decision?: RadioHostDecision;
}

export interface RadioAgentServiceDeps {
  chooseOpeningTrack?: (args: OpeningTrackArgs) => OpeningTrackPick | null;
  prepareTrack: (track: Track, args: RadioAgentSessionStartArgs, pick: OpeningTrackPick) => Promise<RadioAgentPreparedTrack | null>;
  startBackgroundPlanning?: (args: RadioAgentSessionStartArgs, opening: RadioAgentPreparedTrack | null) => Promise<void> | void;
  handleRadioAgentEvent?: (event: Record<string, unknown>) => Promise<RadioAgentHandleResult | null>;
  clearReadyQueue?: () => void;
  queueProgramWindow?: (programWindow: RadioAgentProgramWindow) => Promise<boolean>;
  prepareProgramWindow?: (programWindow: RadioAgentProgramWindow) => Promise<RadioAgentPreparedTrack | null>;
  hostTextForDelivery?: (args: RadioAgentHostTextArgs) => string;
  trackEndTimeoutMs?: number;
}

const DEFAULT_TRACK_END_TIMEOUT_MS = 2500;

export class RadioAgentService {
  private readonly deps: Required<Pick<RadioAgentServiceDeps, "chooseOpeningTrack">> & Omit<RadioAgentServiceDeps, "chooseOpeningTrack">;

  constructor(deps: RadioAgentServiceDeps) {
    this.deps = {
      ...deps,
      chooseOpeningTrack: deps.chooseOpeningTrack ?? defaultChooseOpeningTrack,
    };
  }

  async startSession(args: RadioAgentSessionStartArgs): Promise<RadioAgentSessionStartResult> {
    const pick = this.deps.chooseOpeningTrack({
      recentPlayableTracks: args.recentPlayableTracks,
      profileAnchorTracks: args.profileAnchorTracks,
      likedTracks: args.likedTracks,
      fallbackTracks: args.fallbackTracks,
      avoidTrackIds: args.avoidTrackIds,
      avoidArtists: args.avoidArtists,
    });
    const opening = pick ? await this.deps.prepareTrack(pick.track, args, pick) : null;
    if (pick && !opening) {
      args.avoidTrackIds.add(pick.track.id);
    }
    const backgroundStarted = this.startBackgroundPlanning(args, opening);

    if (opening) {
      return {
        opening,
        backgroundStarted,
      };
    }

    return {
      backgroundStarted,
      fallbackReason: pick ? "opening_track_prepare_failed" : "no_opening_track_candidate",
    };
  }

  async handleTrackEnded(args: RadioAgentTrackEndedArgs): Promise<RadioAgentTrackEndedResult> {
    if (args.readyQueue.length > 0) {
      return {
        action: "promote_ready",
        agentResult: null,
        programQueued: false,
        hostText: "",
      };
    }

    return await this.withTrackEndTimeout(this.runTrackEndContinuation(args));
  }

  private async runTrackEndContinuation(args: RadioAgentTrackEndedArgs): Promise<RadioAgentTrackEndedResult> {
    const agentResult = this.deps.handleRadioAgentEvent
      ? await this.deps.handleRadioAgentEvent({
          type: "queue_low",
          uid: args.uid,
          sessionId: args.sessionId,
          currentTrack: args.currentTrack,
          readyQueue: args.readyQueue,
        })
      : null;
    const programWindow = agentResult?.programWindow;
    const programQueued = programWindow && this.deps.queueProgramWindow ? await this.deps.queueProgramWindow(programWindow) : false;
    const hostText =
      agentResult && this.deps.hostTextForDelivery
        ? this.deliverableHostText(agentResult)
        : "";

    if (programQueued) {
      return {
        action: "queued_program",
        agentResult,
        ...(programWindow ? { programWindow } : {}),
        programQueued,
        hostText,
      };
    }

    return {
      action: "legacy_fallback",
      agentResult,
      ...(programWindow ? { programWindow } : {}),
      programQueued: false,
      hostText,
      fallbackReason: programWindow ? "program_window_queue_failed" : "program_window_missing",
    };
  }

  private async withTrackEndTimeout(work: Promise<RadioAgentTrackEndedResult>): Promise<RadioAgentTrackEndedResult> {
    const timeoutMs = Math.max(0, this.deps.trackEndTimeoutMs ?? DEFAULT_TRACK_END_TIMEOUT_MS);
    if (timeoutMs === 0) return await work;
    return await Promise.race([
      work,
      new Promise<RadioAgentTrackEndedResult>((resolve) =>
        setTimeout(
          () =>
            resolve({
              action: "legacy_fallback",
              agentResult: null,
              programQueued: false,
              hostText: "",
              fallbackReason: "radio_agent_track_end_timeout",
            }),
          timeoutMs,
        ),
      ),
    ]);
  }

  async handleUserText(args: RadioAgentUserTextArgs): Promise<RadioAgentUserTextResult> {
    return await this.runProgramTextEvent(args, args.shouldClearQueue);
  }

  async handleCorrection(args: RadioAgentCorrectionArgs): Promise<RadioAgentCorrectionResult> {
    return await this.runProgramTextEvent(args, true);
  }

  private async runProgramTextEvent(
    args: Pick<RadioAgentUserTextArgs, "uid" | "sessionId" | "text" | "currentTrack" | "readyQueue">,
    shouldClearQueue: boolean,
  ): Promise<RadioAgentUserTextResult> {
    const agentResult = this.deps.handleRadioAgentEvent
      ? await this.deps.handleRadioAgentEvent({
          type: "user_text",
          uid: args.uid,
          sessionId: args.sessionId,
          text: args.text,
          currentTrack: args.currentTrack,
          readyQueue: args.readyQueue,
        })
      : null;
    const programWindow = agentResult?.programWindow;
    if (programWindow && shouldClearQueue) this.deps.clearReadyQueue?.();
    const programQueued = programWindow && this.deps.queueProgramWindow ? await this.deps.queueProgramWindow(programWindow) : false;
    const preparedTrack =
      programWindow && !programQueued && !this.deps.queueProgramWindow && this.deps.prepareProgramWindow
        ? await this.deps.prepareProgramWindow(programWindow)
        : null;
    const hostText =
      agentResult && this.deps.hostTextForDelivery
        ? this.deliverableHostText(agentResult)
        : "";

    return {
      agentResult,
      ...(programWindow ? { programWindow } : {}),
      ...(preparedTrack ? { preparedTrack } : {}),
      programQueued,
      hostText,
      shouldClearQueue,
    };
  }

  private startBackgroundPlanning(args: RadioAgentSessionStartArgs, opening: RadioAgentPreparedTrack | null): boolean {
    if (!this.deps.startBackgroundPlanning) return false;
    void Promise.resolve(this.deps.startBackgroundPlanning(args, opening)).catch(() => undefined);
    return true;
  }

  private deliverableHostText(agentResult: RadioAgentHandleResult): string {
    const text = this.deps.hostTextForDelivery?.({
      eventType: agentResult.event.type,
      decision: agentResult.hostDecision,
    });
    if (!text) return "";
    return hostTextForRadioAgentDelivery({
      eventType: agentResult.event.type,
      decision: {
        shouldSpeak: true,
        event: agentResult.hostDecision?.event || "service_delivery",
        reason: agentResult.hostDecision?.reason || "service host delivery",
        text,
      },
    });
  }
}
