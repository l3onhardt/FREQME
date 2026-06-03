import type { DecisionTrace } from "../radio/radioBrainTypes.js";
import type { SelectionReason, Track } from "../types.js";
import type {
  RadioAgentHandleResult,
  RadioAgentMode,
  RadioAgentPreparedTrack,
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
    }): Promise<RadioAgentHandleResult>;
  };
  executor: {
    prepareFirstPlayable(window: RadioAgentProgramWindow): Promise<RadioAgentPreparedTrack | null>;
  };
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

    const prepared = await args.executor.prepareFirstPlayable(result.programWindow);
    if (!prepared) {
      logFallback(args, "program_executor_no_track");
      return false;
    }

    try {
      await args.traceStore.save(prepared.decisionTrace);
    } catch {
      logFallback(args, "trace_save_failed");
      return false;
    }

    const ttsHash = prepared.segueText ? await args.synthesize(prepared.segueText).catch(() => "") : "";
    args.queue.addReady(prepared.track, prepared.url, prepared.selectionReason, {
      segueText: prepared.segueText,
      ttsHash,
    });
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
