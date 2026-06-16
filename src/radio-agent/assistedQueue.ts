import type { DecisionTrace } from "../radio/radioBrainTypes.js";
import type { SelectionReason, Track } from "../types.js";
import { sameTrack } from "./playbackGovernor.js";
import type {
  RadioAgentHandleResult,
  RadioAgentMode,
  RadioAgentPreparedTrack,
  RadioAgentProgramExecutionDiagnostics,
  RadioAgentProgramWindow,
} from "./types.js";

export type RadioAgentAssistedFallbackReason =
  | "program_window_missing"
  | "program_executor_no_track"
  | "program_executor_duplicate_track"
  | "trace_save_failed"
  | "assisted_queue_failed";

export interface RadioAgentAssistedQueueDeps {
  mode: RadioAgentMode;
  uid: string | null;
  sessionId: number | null;
  currentTrack: Track | null;
  recentTracks?: Track[];
  readyQueue: Track[];
  getPlaybackSnapshot?: () => { currentTrack: Track | null; recentTracks?: Track[]; readyQueue: Track[] };
  radioAgent: {
    handle(input: {
      type: "queue_low";
      uid: string | null;
      sessionId: number | null;
      currentTrack: Track | null;
      recentTracks?: Track[];
      readyQueue: Track[];
    } | {
      type: "program_track_queued";
      uid: string | null;
      sessionId: number | null;
      track: Track;
      programWindowId: string;
      traceId: string;
      selectionReason: string;
      hostText: string;
      currentTrack: Track | null;
      recentTracks?: Track[];
      readyQueue: Track[];
    } | {
      type: "program_repair_needed";
      uid: string | null;
      sessionId: number | null;
      reason: RadioAgentAssistedFallbackReason;
      programWindow: RadioAgentProgramWindow;
      attemptedQueries: string[];
      currentTrack: Track | null;
      recentTracks?: Track[];
      readyQueue: Track[];
    }): Promise<RadioAgentHandleResult>;
  };
  executor: {
    prepareFirstPlayable(window: RadioAgentProgramWindow): Promise<RadioAgentPreparedTrack | null>;
  } & Partial<RadioAgentProgramExecutionDiagnostics>;
  traceStore: {
    save(trace: DecisionTrace): void | Promise<void>;
  };
  queue: {
    addReady(
      track: Track,
      url: string,
      selectionReason: SelectionReason,
      options?: { segueText?: string; ttsHash?: string },
    ): void;
  };
  synthesize(text: string): Promise<string>;
  logFallback(reason: RadioAgentAssistedFallbackReason): void;
}

export async function tryQueueRadioAgentAssistedTrack(args: RadioAgentAssistedQueueDeps): Promise<boolean> {
  if (args.mode !== "assisted" && args.mode !== "active") return false;

  try {
    const playbackSnapshot = playbackSnapshotForQueueing(args);
    const result = await args.radioAgent.handle({
      type: "queue_low",
      uid: args.uid,
      sessionId: args.sessionId,
      currentTrack: playbackSnapshot.currentTrack,
      recentTracks: playbackSnapshot.recentTracks,
      readyQueue: playbackSnapshot.readyQueue,
    });
    if (!result.programWindow) {
      logFallback(args, "program_window_missing");
      return false;
    }

    const firstAttempt = await prepareAndQueueProgramWindow(args, result.programWindow);
    if (firstAttempt.status === "queued") return true;

    const repair = await reportRepairNeeded(args, result.programWindow, firstAttempt.reason, firstAttempt.attemptedQueries);
    if (isRepairableExecutionReason(firstAttempt.reason) && repair?.programWindow) {
      const repairedAttempt = await prepareAndQueueProgramWindow(args, repair.programWindow);
      if (repairedAttempt.status === "queued") return true;
    }

    logFallback(args, firstAttempt.reason);
    return false;
  } catch {
    logFallback(args, "assisted_queue_failed");
    return false;
  }
}

export async function queueRadioAgentProgramWindow(
  args: RadioAgentAssistedQueueDeps,
  programWindow: RadioAgentProgramWindow,
): Promise<boolean> {
  if (args.mode !== "assisted" && args.mode !== "active") return false;

  try {
    const firstAttempt = await prepareAndQueueProgramWindow(args, programWindow);
    if (firstAttempt.status === "queued") return true;

    const repair = await reportRepairNeeded(args, programWindow, firstAttempt.reason, firstAttempt.attemptedQueries);
    if (isRepairableExecutionReason(firstAttempt.reason) && repair?.programWindow) {
      const repairedAttempt = await prepareAndQueueProgramWindow(args, repair.programWindow);
      if (repairedAttempt.status === "queued") return true;
    }

    logFallback(args, firstAttempt.reason);
    return false;
  } catch {
    logFallback(args, "assisted_queue_failed");
    return false;
  }
}

type ProgramQueueAttemptResult =
  | { status: "queued" }
  | { status: "failed"; reason: Exclude<RadioAgentAssistedFallbackReason, "program_window_missing">; attemptedQueries: string[] };

async function prepareAndQueueProgramWindow(
  args: RadioAgentAssistedQueueDeps,
  programWindow: RadioAgentProgramWindow,
): Promise<ProgramQueueAttemptResult> {
  let prepared: RadioAgentPreparedTrack | null = null;
  try {
    prepared = await args.executor.prepareFirstPlayable(programWindow);
  } catch {
    return {
      status: "failed",
      reason: "assisted_queue_failed",
      attemptedQueries: attemptedQueriesFromExecutor(args, programWindow),
    };
  }
  if (!prepared) {
    return {
      status: "failed",
      reason: "program_executor_no_track",
      attemptedQueries: attemptedQueriesFromExecutor(args, programWindow),
    };
  }
  const playbackSnapshot = playbackSnapshotForQueueing(args);
  if (isDuplicatePreparedTrack(prepared.track, playbackSnapshot.currentTrack, playbackSnapshot.recentTracks, playbackSnapshot.readyQueue)) {
    return {
      status: "failed",
      reason: "program_executor_duplicate_track",
      attemptedQueries: attemptedQueriesFromPrepared(args, programWindow, prepared),
    };
  }

  try {
    await args.traceStore.save(prepared.decisionTrace);
  } catch {
    return {
      status: "failed",
      reason: "trace_save_failed",
      attemptedQueries: prepared.decisionTrace.verificationAttempts,
    };
  }

  const ttsHash = prepared.segueText ? await args.synthesize(prepared.segueText).catch(() => "") : "";
  try {
    const latestPlaybackSnapshot = playbackSnapshotForQueueing(args);
    if (isDuplicatePreparedTrack(prepared.track, latestPlaybackSnapshot.currentTrack, latestPlaybackSnapshot.recentTracks, latestPlaybackSnapshot.readyQueue)) {
      return {
        status: "failed",
        reason: "program_executor_duplicate_track",
        attemptedQueries: attemptedQueriesFromPrepared(args, programWindow, prepared),
      };
    }
    args.queue.addReady(prepared.track, prepared.url, prepared.selectionReason, {
      segueText: prepared.segueText,
      ttsHash,
    });
    reportTrackQueued(args, programWindow, prepared);
  } catch {
    return {
      status: "failed",
      reason: "assisted_queue_failed",
      attemptedQueries: prepared.decisionTrace.verificationAttempts,
    };
  }
  return { status: "queued" };
}

function reportTrackQueued(
  args: RadioAgentAssistedQueueDeps,
  programWindow: RadioAgentProgramWindow,
  prepared: RadioAgentPreparedTrack,
): void {
  const playbackSnapshot = playbackSnapshotForQueueing(args);
  void args.radioAgent.handle({
    type: "program_track_queued",
    uid: args.uid,
    sessionId: args.sessionId,
    track: prepared.track,
    programWindowId: programWindow.id,
    traceId: prepared.decisionTrace.id,
    selectionReason: prepared.selectionReason.text || prepared.decisionTrace.reason || programWindow.stationBrief,
    hostText: prepared.segueText,
    currentTrack: playbackSnapshot.currentTrack,
    recentTracks: playbackSnapshot.recentTracks,
    readyQueue: playbackSnapshot.readyQueue,
  }).catch(() => undefined);
}

function logFallback(args: RadioAgentAssistedQueueDeps, reason: RadioAgentAssistedFallbackReason): void {
  try {
    args.logFallback(reason);
  } catch {
  }
}

async function reportRepairNeeded(
  args: RadioAgentAssistedQueueDeps,
  programWindow: RadioAgentProgramWindow,
  reason: RadioAgentAssistedFallbackReason,
  attemptedQueries = programWindow.candidateTasks.map((task) => task.query).filter(Boolean),
): Promise<RadioAgentHandleResult | null> {
  try {
    return await args.radioAgent.handle({
      type: "program_repair_needed",
      uid: args.uid,
      sessionId: args.sessionId,
      reason,
      programWindow,
      attemptedQueries: dedupeStrings([...attemptedQueries, ...programWindow.candidateTasks.map((task) => task.query).filter(Boolean)]),
      ...playbackSnapshotForQueueing(args),
    });
  } catch {
    return null;
  }
}

function playbackSnapshotForQueueing(args: RadioAgentAssistedQueueDeps): { currentTrack: Track | null; recentTracks: Track[]; readyQueue: Track[] } {
  try {
    const snapshot = args.getPlaybackSnapshot?.();
    if (snapshot) return {
      currentTrack: snapshot.currentTrack,
      recentTracks: snapshot.recentTracks || [],
      readyQueue: snapshot.readyQueue,
    };
  } catch {
  }
  return {
    currentTrack: args.currentTrack,
    recentTracks: args.recentTracks || [],
    readyQueue: args.readyQueue,
  };
}

function attemptedQueriesFromExecutor(args: RadioAgentAssistedQueueDeps, programWindow: RadioAgentProgramWindow): string[] {
  const latest = args.executor.latestAttemptedQueries?.() || [];
  return dedupeStrings([...latest, ...programWindow.candidateTasks.map((task) => task.query).filter(Boolean)]);
}

function attemptedQueriesFromPrepared(
  args: RadioAgentAssistedQueueDeps,
  programWindow: RadioAgentProgramWindow,
  prepared: RadioAgentPreparedTrack,
): string[] {
  return dedupeStrings([
    ...(args.executor.latestAttemptedQueries?.() || []),
    ...prepared.decisionTrace.verificationAttempts,
    ...programWindow.candidateTasks.map((task) => task.query).filter(Boolean),
  ]);
}

function isRepairableExecutionReason(reason: Exclude<RadioAgentAssistedFallbackReason, "program_window_missing">): boolean {
  return reason === "program_executor_no_track" || reason === "program_executor_duplicate_track";
}

function isDuplicatePreparedTrack(track: Track, currentTrack: Track | null, recentTracks: Track[], readyQueue: Track[]): boolean {
  return [currentTrack, ...recentTracks, ...readyQueue].some((existing) => sameTrack(track, existing));
}

function dedupeStrings(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}
