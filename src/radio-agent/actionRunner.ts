import type { SelectionReason, Track } from "../types.js";
import type { AgentActionContract, FallbackLevel, RadioAgentAction } from "./agentActions.js";
import type { PlaybackGovernanceTrace } from "./playbackGovernor.js";
import type { RadioAgentPreparedTrack } from "./types.js";

type SpeechRole = Extract<RadioAgentAction, { type: "speak" }>["speechRole"];

export interface RadioAgentActionRunnerDeps {
  queuePlayNow(args: {
    track: Track;
    url: string;
    reason: SelectionReason;
    hostText: string;
    governanceTrace?: PlaybackGovernanceTrace;
  }): Promise<void> | void;
  queuePrepared?(args: { prepared: RadioAgentPreparedTrack; windowId: string }): Promise<void> | void;
  speak(args: { text: string; speechRole: SpeechRole }): Promise<void> | void;
  staySilent(args: { reason: string }): Promise<void> | void;
  repairContract?(args: { contract: Extract<RadioAgentAction, { type: "repair_contract" }>["contract"]; reason: string }): Promise<void> | void;
  reportNotFound(args: {
    contract: AgentActionContract | null;
    reason: string;
    searchedQueries: string[];
    governanceTrace?: PlaybackGovernanceTrace;
  }): Promise<void> | void;
  reportFallback(args: { level: FallbackLevel; reason: string; action?: RadioAgentAction }): Promise<void> | void;
}

export interface RadioAgentActionRunnerResult {
  executedTypes: RadioAgentAction["type"][];
  playbackQueued: boolean;
  preparedQueued: number;
  spoke: boolean;
  notFound: boolean;
  fallbackLevels: FallbackLevel[];
}

export async function runRadioAgentActions(
  actions: RadioAgentAction[],
  deps: RadioAgentActionRunnerDeps,
): Promise<RadioAgentActionRunnerResult> {
  const result: RadioAgentActionRunnerResult = {
    executedTypes: [],
    playbackQueued: false,
    preparedQueued: 0,
    spoke: false,
    notFound: false,
    fallbackLevels: [],
  };

  for (const action of actions) {
    result.executedTypes.push(action.type);

    if (action.type === "play_now") {
      await deps.queuePlayNow({
        track: action.track,
        url: action.url,
        reason: action.reason,
        hostText: action.hostText || "",
        governanceTrace: action.governanceTrace,
      });
      result.playbackQueued = true;
      continue;
    }

    if (action.type === "queue_window") {
      for (const prepared of action.prepared) {
        await deps.queuePrepared?.({ prepared, windowId: action.window.id });
        result.preparedQueued += 1;
      }
      continue;
    }

    if (action.type === "speak") {
      await deps.speak({ text: action.text, speechRole: action.speechRole });
      result.spoke = true;
      continue;
    }

    if (action.type === "stay_silent") {
      await deps.staySilent({ reason: action.reason });
      continue;
    }

    if (action.type === "repair_contract") {
      await deps.repairContract?.({ contract: action.contract, reason: action.reason });
      continue;
    }

    if (action.type === "honest_not_found") {
      await deps.reportNotFound({
        contract: action.contract,
        reason: action.reason,
        searchedQueries: action.searchedQueries,
        governanceTrace: action.governanceTrace,
      });
      result.notFound = true;
      continue;
    }

    await deps.reportFallback({ level: action.level, reason: action.reason, action: action.action });
    result.fallbackLevels.push(action.level);
  }

  return result;
}
