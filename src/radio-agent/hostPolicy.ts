import { planHostSpeech } from "./hostAgent.js";
import type { RadioAgentEventType, RadioHostDecision } from "./types.js";

export interface HostPolicyArgs {
  eventType: RadioAgentEventType;
  recentHostLines: string[];
  profileReady: boolean;
  lowInterruption: boolean;
  userText?: string;
  proposedText?: string;
}

export function decideHostSpeech(args: HostPolicyArgs): RadioHostDecision {
  return planHostSpeech(args);
}
