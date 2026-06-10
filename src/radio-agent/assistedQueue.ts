import type { DecisionTrace } from "../radio/radioBrainTypes.js";
import type { SelectionReason, Track } from "../types.js";
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
  | "trace_save_failed"
  | "assisted_queue_failed";

export interface RadioAgentAssistedQueueDeps {
  mode: RadioAgentMode;
  uid: string | null;
  sessionId: number | null;
  currentTrack: Track | null;
  readyQueue: Track[];
  radioAgent: {
    handle(input: {
      type: "queue_low";
      uid: string | null;
      sessionId: number | null;
      currentTrack: Track | null;
      readyQueue: Track[];
    } | {
      type: "program_repair_needed";
      uid: string | null;
      sessionId: number | null;
      reason: RadioAgentAssistedFallbackReason;
      programWindow: RadioAgentProgramWindow;
      attemptedQueries: string[];
      currentTrack: Track | null;
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
    const result = await args.radioAgent.handle({
      type: "queue_low",
      uid: args.uid,
      sessionId: args.sessionId,
      currentTrack: args.currentTrack,
      readyQueue: args.readyQueue,
    });
    if (!result.programWindow) {
      logFallback(args, "program_window_missing");
      return false;
    }

    let prepared: RadioAgentPreparedTrack | null = null;
    try {
      prepared = await args.executor.prepareFirstPlayable(result.programWindow);
    } catch {
      await reportRepairNeeded(args, result.programWindow, "assisted_queue_failed", attemptedQueriesFromExecutor(args, result.programWindow));
      logFallback(args, "assisted_queue_failed");
      return false;
    }
    if (!prepared) {
      await reportRepairNeeded(args, result.programWindow, "program_executor_no_track", attemptedQueriesFromExecutor(args, result.programWindow));
      logFallback(args, "program_executor_no_track");
      return false;
    }

    try {
      await args.traceStore.save(prepared.decisionTrace);
    } catch {
      await reportRepairNeeded(args, result.programWindow, "trace_save_failed", prepared.decisionTrace.verificationAttempts);
      logFallback(args, "trace_save_failed");
      return false;
    }

    const ttsHash = prepared.segueText ? await args.synthesize(prepared.segueText).catch(() => "") : "";
    try {
      args.queue.addReady(prepared.track, prepared.url, prepared.selectionReason, {
        segueText: prepared.segueText,
        ttsHash,
      });
    } catch {
      await reportRepairNeeded(args, result.programWindow, "assisted_queue_failed", prepared.decisionTrace.verificationAttempts);
      logFallback(args, "assisted_queue_failed");
      return false;
    }
    return true;
  } catch {
    logFallback(args, "assisted_queue_failed");
    return false;
  }
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
): Promise<void> {
  try {
    await args.radioAgent.handle({
      type: "program_repair_needed",
      uid: args.uid,
      sessionId: args.sessionId,
      reason,
      programWindow,
      attemptedQueries: dedupeStrings([...attemptedQueries, ...programWindow.candidateTasks.map((task) => task.query).filter(Boolean)]),
      currentTrack: args.currentTrack,
      readyQueue: args.readyQueue,
    });
  } catch {
  }
}

function attemptedQueriesFromExecutor(args: RadioAgentAssistedQueueDeps, programWindow: RadioAgentProgramWindow): string[] {
  const latest = args.executor.latestAttemptedQueries?.() || [];
  return dedupeStrings([...latest, ...programWindow.candidateTasks.map((task) => task.query).filter(Boolean)]);
}

function dedupeStrings(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}
