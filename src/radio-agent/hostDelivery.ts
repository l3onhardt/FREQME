import type { RadioAgentEventType, RadioHostDecision } from "./types.js";

const DELIVERABLE_EVENTS = new Set<RadioAgentEventType>([
  "user_text",
  "track_skipped",
  "playback_recovery_needed",
  "program_repair_needed",
  "queue_low",
]);

const UNSAFE_HOST_TEXT =
  /\b(model|prompt|json|tool call|shadow decision|decision trace|trace basis|verification|candidate|program contract|low-interruption)\b|旁边|质感/i;
const MOJIBAKE_MARKERS = /[�]|閹|閵|娑|缁|淇|檤|闁|濞|鐢|鍙|姘|鎴|鍏|涓|杩|俙|銆/;
const HOST_DELIVERY_LIMIT = 140;
const SERVICE_PLANNING_JARGON =
  /\b(contract|current station direction|main line|pipeline|beside it)\b/i;

export interface RadioAgentHostDeliveryArgs {
  eventType: RadioAgentEventType;
  decision?: RadioHostDecision;
}

export function hostTextForRadioAgentDelivery(args: RadioAgentHostDeliveryArgs): string {
  if (!DELIVERABLE_EVENTS.has(args.eventType)) return "";
  if (!args.decision?.shouldSpeak) return "";

  const text = (args.decision.text || "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  if (UNSAFE_HOST_TEXT.test(text) || SERVICE_PLANNING_JARGON.test(text) || MOJIBAKE_MARKERS.test(text)) return "";
  return text.length <= HOST_DELIVERY_LIMIT ? text : text.slice(0, HOST_DELIVERY_LIMIT).trim();
}
