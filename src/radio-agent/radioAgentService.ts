import type { Track } from "../types.js";
import type { AgentActionContract, RadioAgentAction } from "./agentActions.js";
import { ContractController } from "./contractController.js";
import type { AgentSessionContract } from "./contractController.js";
import { hostTextForRadioAgentDelivery } from "./hostDelivery.js";
import { chooseOpeningTrack as defaultChooseOpeningTrack, type OpeningTrackArgs, type OpeningTrackPick } from "./openingTrack.js";
import type { PlaybackGovernanceTrace, PlaybackGovernor, PlaybackGovernorResult } from "./playbackGovernor.js";
import type { RadioAgentHandleResult, RadioAgentPreparedTrack, RadioAgentProgramWindow, RadioAgentEventType, RadioHostDecision } from "./types.js";

export interface RadioAgentSessionStartArgs extends OpeningTrackArgs {
  uid: string | null;
  sessionId: number | null;
}

export interface RadioAgentSessionStartResult {
  actions: RadioAgentAction[];
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
  recentTracks?: Record<string, unknown>[];
  readyQueue: Record<string, unknown>[];
  shouldClearQueue: boolean;
}

export interface RadioAgentUserTextResult {
  actions: RadioAgentAction[];
  agentResult: RadioAgentHandleResult | null;
  programWindow?: RadioAgentProgramWindow;
  preparedTrack?: RadioAgentPreparedTrack;
  programQueued: boolean;
  hostText: string;
  shouldClearQueue: boolean;
  fallbackReason?: string;
}

export interface RadioAgentCorrectionArgs {
  uid: string | null;
  sessionId: number | null;
  text: string;
  currentTrack: Record<string, unknown> | null;
  recentTracks?: Record<string, unknown>[];
  readyQueue: Record<string, unknown>[];
}

export type RadioAgentCorrectionResult = RadioAgentUserTextResult;

export interface RadioAgentTrackEndedArgs {
  uid: string | null;
  sessionId: number | null;
  previousEvent: "played" | "skipped";
  currentTrack: Record<string, unknown> | null;
  recentTracks?: Record<string, unknown>[];
  readyQueue: Record<string, unknown>[];
}

export interface RadioAgentTrackEndedResult {
  actions: RadioAgentAction[];
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
  userTextQueueTimeoutMs?: number;
  contractController?: ContractController;
  activeContractStore?: ActiveContractStore;
  playbackGovernor?: Pick<PlaybackGovernor, "evaluate">;
}

export interface ActiveContractStore {
  get(uid: string | null, sessionId: number | null): AgentSessionContract | null;
  set(contract: AgentSessionContract): void;
}

const DEFAULT_TRACK_END_TIMEOUT_MS = 2500;
const DEFAULT_USER_TEXT_QUEUE_TIMEOUT_MS = 12000;

export class RadioAgentService {
  private readonly deps: Required<Pick<RadioAgentServiceDeps, "chooseOpeningTrack">> & Omit<RadioAgentServiceDeps, "chooseOpeningTrack">;
  private readonly contractController: ContractController;
  private readonly activeContractStore: ActiveContractStore;

  constructor(deps: RadioAgentServiceDeps) {
    this.deps = {
      ...deps,
      chooseOpeningTrack: deps.chooseOpeningTrack ?? defaultChooseOpeningTrack,
    };
    this.contractController = deps.contractController ?? new ContractController();
    this.activeContractStore = deps.activeContractStore ?? new InMemoryActiveContractStore();
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
        actions: [
          {
            type: "play_now",
            track: opening.track,
            url: opening.url,
            reason: opening.selectionReason,
            ...(opening.segueText ? { hostText: opening.segueText } : {}),
          },
        ],
        opening,
        backgroundStarted,
      };
    }

    return {
      actions: [
        {
          type: "fallback",
          level: "legacy_with_label",
          reason: pick ? "opening_track_prepare_failed" : "no_opening_track_candidate",
        },
      ],
      backgroundStarted,
      fallbackReason: pick ? "opening_track_prepare_failed" : "no_opening_track_candidate",
    };
  }

  async handleTrackEnded(args: RadioAgentTrackEndedArgs): Promise<RadioAgentTrackEndedResult> {
    if (args.readyQueue.length > 0) {
      const readyTrack = asTrack(args.readyQueue[0]);
      if (readyTrack && this.deps.playbackGovernor) {
        const governedReady = await this.governReadyTrack({
          uid: args.uid,
          sessionId: args.sessionId,
          currentTrack: args.currentTrack,
          recentTracks: args.recentTracks || [],
          readyQueue: args.readyQueue.slice(1),
          readyTrack,
        });
        if (governedReady.status === "rejected") {
          return {
            actions: [
              {
                type: "honest_not_found",
                contract: this.activeContractFor(args.uid, args.sessionId),
                reason: governedReady.reason,
                searchedQueries: [],
                governanceTrace: governedReady.trace,
              },
            ],
            action: "legacy_fallback",
            agentResult: null,
            programQueued: false,
            hostText: "",
            fallbackReason: governedReady.reason,
          };
        }
        return {
          actions: [
            {
              type: "fallback",
              level: "same_contract_recent_safe",
              reason: "ready_queue_available",
            },
          ],
          action: "promote_ready",
          agentResult: null,
          programQueued: false,
          hostText: "",
        };
      }
      return {
        actions: [{ type: "fallback", level: "same_contract_recent_safe", reason: "ready_queue_available" }],
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
          recentTracks: args.recentTracks || [],
          readyQueue: args.readyQueue,
        })
      : null;
    const programWindow = agentResult?.programWindow;
    const preparedTrack =
      programWindow && this.deps.prepareProgramWindow
        ? await this.deps.prepareProgramWindow(programWindow)
        : null;
    const governedPrepared = programWindow && preparedTrack
      ? await this.governPreparedTrack({
          uid: args.uid,
          sessionId: args.sessionId,
          currentTrack: args.currentTrack,
          recentTracks: args.recentTracks || [],
          readyQueue: args.readyQueue,
          programWindow,
          preparedTrack,
        })
      : null;
    const programQueued =
      !preparedTrack && programWindow && this.deps.queueProgramWindow
        ? await this.deps.queueProgramWindow(programWindow)
        : false;
    const hostText =
      agentResult && this.deps.hostTextForDelivery
        ? this.deliverableHostText(agentResult)
        : "";

    if (preparedTrack && governedPrepared?.status === "accepted") {
      return {
        actions: [
          {
            type: "play_now",
            track: governedPrepared.track,
            url: governedPrepared.url,
            reason: preparedTrack.selectionReason,
            ...(preparedTrack.segueText ? { hostText: preparedTrack.segueText } : {}),
            governanceTrace: governedPrepared.trace,
          },
          ...(hostText ? [{ type: "speak" as const, text: hostText, speechRole: "recovery" as const }] : []),
        ],
        action: "promote_ready",
        agentResult,
        ...(programWindow ? { programWindow } : {}),
        programQueued: false,
        hostText,
      };
    }

    if (governedPrepared?.status === "rejected") {
      const fallbackReason = governedPrepared.reason;
      return {
        actions: [
          ...(hostText ? [{ type: "speak" as const, text: hostText, speechRole: "recovery" as const }] : []),
          {
            type: "honest_not_found",
            contract: this.activeContractFor(args.uid, args.sessionId),
            reason: fallbackReason,
            searchedQueries: searchedQueriesFor(programWindow),
            governanceTrace: governedPrepared.trace,
          },
        ],
        action: "legacy_fallback",
        agentResult,
        ...(programWindow ? { programWindow } : {}),
        programQueued: false,
        hostText,
        fallbackReason,
      };
    }

    if (programQueued) {
      return {
        actions: [
          ...(programWindow ? [{ type: "queue_window" as const, window: programWindow, prepared: [] }] : []),
          ...(hostText ? [{ type: "speak" as const, text: hostText, speechRole: "recovery" as const }] : []),
        ],
        action: "queued_program",
        agentResult,
        ...(programWindow ? { programWindow } : {}),
        programQueued,
        hostText,
      };
    }

    return {
      actions: [
        {
          type: "fallback",
          level: "agent_program",
          reason: programWindow ? "program_window_queue_failed" : "program_window_missing",
        },
        ...(hostText ? [{ type: "speak" as const, text: hostText, speechRole: "recovery" as const }] : []),
      ],
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
              actions: [{ type: "fallback", level: "legacy_with_label", reason: "radio_agent_track_end_timeout" }],
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
    return await this.runProgramTextEvent(args, args.shouldClearQueue, "ack");
  }

  async handleCorrection(args: RadioAgentCorrectionArgs): Promise<RadioAgentCorrectionResult> {
    return await this.runProgramTextEvent(args, true, "correction");
  }

  private async runProgramTextEvent(
    args: Pick<RadioAgentUserTextArgs, "uid" | "sessionId" | "text" | "currentTrack" | "recentTracks" | "readyQueue">,
    shouldClearQueue: boolean,
    speechRole: "ack" | "correction",
  ): Promise<RadioAgentUserTextResult> {
    const contract = speechRole === "correction"
      ? this.repairActiveContract(args.uid, args.sessionId, args.text)
      : this.createActiveContract(args.uid, args.sessionId, args.text);
    const agentResult = this.deps.handleRadioAgentEvent
      ? await this.deps.handleRadioAgentEvent({
          type: "user_text",
          uid: args.uid,
          sessionId: args.sessionId,
          text: args.text,
          currentTrack: args.currentTrack,
          recentTracks: args.recentTracks || [],
          readyQueue: args.readyQueue,
        })
      : null;
    const programWindow = agentResult?.programWindow;
    if (programWindow && shouldClearQueue) this.deps.clearReadyQueue?.();
    const queueResult = programWindow && this.deps.queueProgramWindow
      ? await this.withUserTextQueueTimeout(this.deps.queueProgramWindow(programWindow))
      : { queued: false };
    const programQueued = queueResult.queued;
    const preparedTrack =
      programWindow && !programQueued && !this.deps.queueProgramWindow && this.deps.prepareProgramWindow
        ? await this.deps.prepareProgramWindow(programWindow)
        : null;
    const governedPrepared = programWindow && preparedTrack
      ? await this.governPreparedTrack({
          uid: args.uid,
          sessionId: args.sessionId,
          currentTrack: args.currentTrack,
          recentTracks: args.recentTracks || [],
          readyQueue: args.readyQueue,
          programWindow,
          preparedTrack,
        })
      : null;
    const hostText =
      agentResult && this.deps.hostTextForDelivery
        ? this.deliverableHostText(agentResult)
        : "";
    const acceptedPreparedTrack = governedPrepared?.status === "accepted" ? preparedTrack : null;
    const governanceTrace = governedPrepared?.trace;
    const fallbackReason =
      queueResult.fallbackReason ||
      (governedPrepared?.status === "rejected" ? governedPrepared.reason : undefined) ||
      (programWindow && !programQueued && !acceptedPreparedTrack ? "no_playable_candidate" : undefined);
    const actions = this.userTextActions({
      rawUserText: args.text,
      contract,
      programWindow,
      preparedTrack: acceptedPreparedTrack,
      programQueued,
      hostText,
      fallbackReason,
      speechRole,
      governanceTrace,
    });

    return {
      actions,
      agentResult,
      ...(programWindow ? { programWindow } : {}),
      ...(acceptedPreparedTrack ? { preparedTrack: acceptedPreparedTrack } : {}),
      programQueued,
      hostText,
      shouldClearQueue,
      ...(queueResult.fallbackReason ? { fallbackReason: queueResult.fallbackReason } : {}),
    };
  }

  private userTextActions(args: {
    rawUserText: string;
    contract: AgentSessionContract | null;
    programWindow: RadioAgentProgramWindow | undefined;
    preparedTrack: RadioAgentPreparedTrack | null;
    programQueued: boolean;
    hostText: string;
    fallbackReason?: string;
    speechRole: "ack" | "correction";
    governanceTrace?: PlaybackGovernanceTrace;
  }): RadioAgentAction[] {
    const actions: RadioAgentAction[] = [];
    if (args.contract) actions.push({ type: "repair_contract", contract: args.contract, reason: args.speechRole === "correction" ? "correction" : "listener_direction" });
    if (args.hostText) actions.push({ type: "speak", text: args.hostText, speechRole: args.speechRole });
    if (args.programQueued && args.programWindow) actions.push({ type: "queue_window", window: args.programWindow, prepared: [] });
    if (args.preparedTrack) {
      actions.push({
        type: "play_now",
        track: args.preparedTrack.track,
        url: args.preparedTrack.url,
        reason: args.preparedTrack.selectionReason,
        ...(args.preparedTrack.segueText ? { hostText: args.preparedTrack.segueText } : {}),
        ...(args.governanceTrace ? { governanceTrace: args.governanceTrace } : {}),
      });
    }
    if (args.programWindow && !args.programQueued && !args.preparedTrack && args.fallbackReason === "no_playable_candidate") {
      actions.push({
        type: "honest_not_found",
        contract: args.contract ?? contractFromProgramWindow(args.programWindow, args.rawUserText),
        reason: "no playable candidate",
        searchedQueries: args.programWindow.candidateTasks.map((task) => task.query).filter(Boolean),
      });
      return actions;
    }
    if (args.programWindow && !args.programQueued && !args.preparedTrack && args.governanceTrace) {
      actions.push({
        type: "honest_not_found",
        contract: args.contract ?? contractFromProgramWindow(args.programWindow, args.rawUserText),
        reason: args.fallbackReason || args.governanceTrace.decision,
        searchedQueries: args.programWindow.candidateTasks.map((task) => task.query).filter(Boolean),
        governanceTrace: args.governanceTrace,
      });
      return actions;
    }
    if (args.fallbackReason) actions.push({ type: "fallback", level: "agent_program", reason: args.fallbackReason });
    if (!actions.length) actions.push({ type: "stay_silent", reason: "no_agent_action" });
    return actions;
  }

  private async withUserTextQueueTimeout(work: Promise<boolean>): Promise<{ queued: boolean; fallbackReason?: string }> {
    const timeoutMs = Math.max(0, this.deps.userTextQueueTimeoutMs ?? DEFAULT_USER_TEXT_QUEUE_TIMEOUT_MS);
    if (timeoutMs === 0) return { queued: await work };
    return await Promise.race([
      work.then((queued) => ({ queued })),
      new Promise<{ queued: boolean; fallbackReason: string }>((resolve) =>
        setTimeout(
          () =>
            resolve({
              queued: false,
              fallbackReason: "radio_agent_user_text_queue_timeout",
            }),
          timeoutMs,
        ),
      ),
    ]);
  }

  private startBackgroundPlanning(args: RadioAgentSessionStartArgs, opening: RadioAgentPreparedTrack | null): boolean {
    if (!this.deps.startBackgroundPlanning) return false;
    void Promise.resolve(this.deps.startBackgroundPlanning(args, opening)).catch(() => undefined);
    return true;
  }

  private deliverableHostText(agentResult: RadioAgentHandleResult): string {
    for (const decision of hostDeliveryCandidates(agentResult)) {
      const delivered = this.deliverDecisionText(agentResult.event.type, decision);
      if (delivered) return delivered;
    }
    return "";
  }

  private deliverDecisionText(eventType: RadioAgentEventType, decision?: RadioHostDecision): string {
    const text = this.deps.hostTextForDelivery?.({
      eventType,
      decision,
    });
    if (!text) return "";
    return hostTextForRadioAgentDelivery({
      eventType,
      decision: {
        shouldSpeak: true,
        event: decision?.event || "service_delivery",
        reason: decision?.reason || "service host delivery",
        text,
      },
    });
  }

  private createActiveContract(uid: string | null, sessionId: number | null, text: string): AgentSessionContract | null {
    const contract = this.contractController.fromUserDirection({
      uid,
      sessionId,
      text,
      sourceEventId: `user_text:${Date.now()}`,
    });
    this.activeContractStore.set(contract);
    return contract;
  }

  private repairActiveContract(uid: string | null, sessionId: number | null, text: string): AgentSessionContract | null {
    const active = this.activeContractFor(uid, sessionId);
    if (!active) return this.createActiveContract(uid, sessionId, text);
    const contract = this.contractController.repairFromCorrection(active, {
      text,
      sourceEventId: `correction:${Date.now()}`,
      reason: "listener correction",
    });
    this.activeContractStore.set(contract);
    return contract;
  }

  private activeContractFor(uid: string | null, sessionId: number | null): AgentSessionContract | null {
    return this.activeContractStore.get(uid, sessionId);
  }

  private async governPreparedTrack(args: {
    uid: string | null;
    sessionId: number | null;
    currentTrack: Record<string, unknown> | null;
    recentTracks: Record<string, unknown>[];
    readyQueue: Record<string, unknown>[];
    programWindow: RadioAgentProgramWindow;
    preparedTrack: RadioAgentPreparedTrack;
  }): Promise<PlaybackGovernorResult> {
    if (!this.deps.playbackGovernor) {
      return {
        status: "accepted",
        track: args.preparedTrack.track,
        url: args.preparedTrack.url,
        trace: {
          status: "accepted",
          contractId: this.activeContractFor(args.uid, args.sessionId)?.id ?? null,
          requestToken: 1,
          candidateKey: `${args.preparedTrack.track.artist}::${args.preparedTrack.track.name}`,
          decision: "direct_positive",
          evidence: ["playback governor not configured"],
        },
      };
    }
    return await this.deps.playbackGovernor.evaluate({
      contract: this.activeContractFor(args.uid, args.sessionId),
      requestToken: 1,
      activeRequestToken: 1,
      candidate: args.preparedTrack.track,
      url: args.preparedTrack.url,
      query: args.programWindow.candidateTasks[0]?.query,
      currentTrack: asTrack(args.currentTrack),
      recentTracks: args.recentTracks.map(asTrack).filter((track): track is Track => Boolean(track)),
      readyQueue: args.readyQueue.map(asTrack).filter((track): track is Track => Boolean(track)).map((track) => ({ track })),
      seedState: {},
      hostText: args.preparedTrack.segueText,
      fallbackLevel: "agent_program",
    });
  }

  private async governReadyTrack(args: {
    uid: string | null;
    sessionId: number | null;
    currentTrack: Record<string, unknown> | null;
    recentTracks: Record<string, unknown>[];
    readyQueue: Record<string, unknown>[];
    readyTrack: Track;
  }): Promise<PlaybackGovernorResult> {
    if (!this.deps.playbackGovernor) {
      return {
        status: "accepted",
        track: args.readyTrack,
        url: "",
        trace: {
          status: "accepted",
          contractId: this.activeContractFor(args.uid, args.sessionId)?.id ?? null,
          requestToken: 1,
          candidateKey: `${args.readyTrack.artist}::${args.readyTrack.name}`,
          decision: "direct_positive",
          evidence: ["playback governor not configured"],
        },
      };
    }
    return await this.deps.playbackGovernor.evaluate({
      contract: this.activeContractFor(args.uid, args.sessionId),
      requestToken: 1,
      activeRequestToken: 1,
      candidate: args.readyTrack,
      url: "",
      query: args.readyTrack.selectionReason?.text,
      currentTrack: asTrack(args.currentTrack),
      recentTracks: args.recentTracks.map(asTrack).filter((track): track is Track => Boolean(track)),
      readyQueue: args.readyQueue.map(asTrack).filter((track): track is Track => Boolean(track)).map((track) => ({ track })),
      seedState: {},
      hostText: "",
      fallbackLevel: "same_contract_recent_safe",
    });
  }
}

class InMemoryActiveContractStore implements ActiveContractStore {
  private readonly contracts = new Map<string, AgentSessionContract>();

  get(uid: string | null, sessionId: number | null): AgentSessionContract | null {
    const key = safeContractStoreKey(uid, sessionId);
    return key ? this.contracts.get(key) || null : null;
  }

  set(contract: AgentSessionContract): void {
    const key = safeContractStoreKey(contract.uid, contract.sessionId);
    if (key) this.contracts.set(key, contract);
  }
}

function safeContractStoreKey(uid: string | null, sessionId: number | null): string | null {
  if (uid) return `uid:${uid}`;
  if (sessionId != null) return `session:${sessionId}`;
  return null;
}

function asTrack(value: Record<string, unknown> | null | undefined): Track | null {
  if (!value) return null;
  const id = typeof value.id === "string" ? value.id : "";
  const name = typeof value.name === "string" ? value.name : "";
  const artist = typeof value.artist === "string" ? value.artist : "";
  if (!id || !name || !artist) return null;
  return {
    id,
    name,
    artist,
    ...(typeof value.album === "string" ? { album: value.album } : {}),
    ...(typeof value.source === "string" ? { source: value.source } : {}),
  };
}

function searchedQueriesFor(programWindow: RadioAgentProgramWindow | undefined): string[] {
  return programWindow?.candidateTasks.map((task) => task.query).filter(Boolean) || [];
}

function hostDeliveryCandidates(agentResult: RadioAgentHandleResult): RadioHostDecision[] {
  const hostDecision = agentResult.hostDecision;
  const programIntent = agentResult.programWindow?.hostIntent;
  if (!shouldConsiderProgramHostIntent(agentResult.event.type, programIntent)) return hostDecision ? [hostDecision] : [];

  if (!hostDecision?.shouldSpeak || isGenericHostText(hostDecision.text || "")) {
    return [programIntent, hostDecision].filter((decision): decision is RadioHostDecision => Boolean(decision));
  }

  return [hostDecision, programIntent].filter((decision): decision is RadioHostDecision => Boolean(decision));
}

function shouldConsiderProgramHostIntent(eventType: RadioAgentEventType, intent: RadioHostDecision | undefined): intent is RadioHostDecision {
  if (eventType !== "user_text") return false;
  if (!intent?.shouldSpeak) return false;
  return isConcreteHostText(intent.text || "");
}

function isConcreteHostText(text: string): boolean {
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length >= 8 && !isGenericHostText(compact);
}

function contractFromProgramWindow(programWindow: RadioAgentProgramWindow, rawUserText: string): AgentActionContract {
  return {
    id: programWindow.id,
    mainDirection: programWindow.mainDirection,
    rawUserText,
    allowedAdjacent: programWindow.allowedAdjacent,
    disallowed: programWindow.disallowed,
    positiveSeeds: [programWindow.mainDirection],
    negativeConstraints: programWindow.disallowed,
    driftBudget: programWindow.bridgeBudget,
    bridgeCount: 0,
    mustReturnToContract: Boolean(programWindow.returnRequirement),
    createdAt: programWindow.createdAt,
    updatedAt: programWindow.createdAt,
  };
}

function isGenericHostText(text: string): boolean {
  const compact = text.replace(/\s+/g, "").trim();
  return (
    /^(好|好的|嗯|收到|可以|ok|okay)[。.!！]?$/iu.test(compact) ||
    /^(收到|好的|好)[，,]?(我会|我来|先)?按?(这个|当前)?方向(调整|处理|重新排|排一下)?[。.!！]?$/iu.test(compact)
  );
}
