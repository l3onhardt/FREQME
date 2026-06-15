import type { SelectionReason, Track } from "../types.js";
import type { RadioAgentPreparedTrack, RadioAgentProgramWindow } from "./types.js";
import type {
  AgentSessionContract as ControllerAgentSessionContract,
  LegacyAgentSessionContract,
} from "./contractController.js";

export type AgentSessionContract = ControllerAgentSessionContract | LegacyAgentSessionContract;

export type FallbackLevel =
  | "agent_program"
  | "same_contract_verified"
  | "same_contract_recent_safe"
  | "legacy_with_label"
  | "honest_not_found";

export type RadioAgentAction =
  | { type: "play_now"; track: Track; url: string; reason: SelectionReason; hostText?: string }
  | { type: "queue_window"; window: RadioAgentProgramWindow; prepared: RadioAgentPreparedTrack[] }
  | { type: "speak"; text: string; speechRole: "opening" | "ack" | "correction" | "recovery" | "explanation" }
  | { type: "stay_silent"; reason: string }
  | { type: "repair_contract"; contract: AgentSessionContract; reason: string }
  | { type: "fallback"; level: FallbackLevel; reason: string; action?: RadioAgentAction }
  | { type: "honest_not_found"; contract: AgentSessionContract | null; reason: string; searchedQueries: string[] };

export interface RadioAgentActionResult {
  actions: RadioAgentAction[];
}

export function actionTypes(actions: RadioAgentAction[]): string[] {
  return actions.map((action) => action.type);
}
