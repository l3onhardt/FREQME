import type { SelectionReason, Track } from "../types.js";
import type { RadioAgentPreparedTrack, RadioAgentProgramWindow } from "./types.js";
import type { AgentSessionContract as ControllerAgentSessionContract } from "./contractController.js";
import type { PlaybackGovernanceTrace } from "./playbackGovernor.js";
export type { AgentSessionContract } from "./contractController.js";

export interface LegacyCompatibleAgentSessionContract {
  id?: string;
  mainDirection: string;
  rawUserText?: string;
  allowedAdjacent: string[];
  softBridge?: string[];
  disallowed: string[];
  positiveSeeds?: string[];
  negativeConstraints?: string[];
  driftBudget?: number;
  bridgeCount?: number;
  mustReturnToContract?: boolean;
  hostStyle?: "quiet" | "standard" | "companion";
  createdAt?: string;
  updatedAt?: string;
}

export type AgentActionContract = ControllerAgentSessionContract | LegacyCompatibleAgentSessionContract;

export type FallbackLevel =
  | "agent_program"
  | "same_contract_verified"
  | "same_contract_recent_safe"
  | "legacy_with_label"
  | "honest_not_found";

export type RadioAgentAction =
  | { type: "play_now"; track: Track; url: string; reason: SelectionReason; hostText?: string; governanceTrace?: PlaybackGovernanceTrace }
  | { type: "queue_window"; window: RadioAgentProgramWindow; prepared: RadioAgentPreparedTrack[] }
  | { type: "speak"; text: string; speechRole: "opening" | "ack" | "correction" | "recovery" | "explanation" }
  | { type: "stay_silent"; reason: string }
  | { type: "repair_contract"; contract: ControllerAgentSessionContract; reason: string }
  | { type: "fallback"; level: FallbackLevel; reason: string; action?: RadioAgentAction }
  | { type: "honest_not_found"; contract: AgentActionContract | null; reason: string; searchedQueries: string[]; governanceTrace?: PlaybackGovernanceTrace };

export interface RadioAgentActionResult {
  actions: RadioAgentAction[];
}

export function actionTypes(actions: RadioAgentAction[]): string[] {
  return actions.map((action) => action.type);
}
