import { compactText } from "../utils/text.js";
import type { DecisionTrace, ListeningIntentDecision } from "./radioBrainTypes.js";

const INTERNAL_LISTENER_PATTERNS = [
  /\bjson\b/i,
  /\bcandidates?\b/i,
  /\bverifications?\b/i,
  /\btool[\s_-]+calls?\b/i,
  /\bshadow[\s_-]+modes?\b/i,
  /\blistener\s+profiles?\b/i,
  /\bprogram\s+contracts?\b/i,
  /\bfallback\s+polic(?:y|ies)\b/i,
  /\btraces?\b(?!\s+of\b)/i,
  /\bmodels?\b(?=\s+(?:selected|selects|chose|chooses|picked|picks|ranked|ranks|planned|plans|returned|returns|generated|generates|suggested|suggests|decided|decides|scored|scores|called|calls|used|uses|found|finds)\b)/i,
  /\bprompts?\b(?=\s+(?:selected|selects|chose|chooses|picked|picks|ranked|ranks|planned|plans|returned|returns|generated|generates|suggested|suggests|decided|decides|produced|produces|called|calls|used|uses|found|finds)\b)/i,
];

function describeTrack(artistValue: string, nameValue: string): string {
  const artist = compactText(artistValue, 120);
  const name = compactText(nameValue, 120);
  if (artist && name && artist !== name) return `${artist} 的 ${name}`;
  if (name) return name;
  if (artist) return `${artist} 的这首歌`;
  return "这首歌";
}

function listenerFacingTraceText(value: unknown, maxLength: number): string {
  const text = compactText(value, maxLength);
  if (!text || INTERNAL_LISTENER_PATTERNS.some((pattern) => pattern.test(text))) return "";
  return text;
}

export class HostResponder {
  acknowledge(intent: ListeningIntentDecision): string {
    if (intent.type === "explanation_question") return intent.ackText;
    const positives = intent.positiveSeeds.slice(0, 2).join("、");
    const negatives = intent.negativeConstraints.slice(0, 3).join("、");
    if (intent.type === "correction" || intent.type === "negative_feedback") {
      return compactText(`懂了，我先避开${negatives || "刚才那个方向"}，往${positives || "更合适的方向"}收。`, 120);
    }
    return compactText(intent.ackText || `收到，我往${positives || "这个方向"}排接下来的几首。`, 120);
  }

  explainCurrentTrack(intent: ListeningIntentDecision, trace: DecisionTrace | null): string {
    if (!trace) return "这首是我根据刚才的电台方向接上的，但这次没有留下足够完整的选择记录。";
    const track = describeTrack(trace.selectedTrack.artist, trace.selectedTrack.name);
    const reason =
      listenerFacingTraceText(trace.reason, 180) || listenerFacingTraceText(trace.hostText, 180) || "它和刚才的电台方向比较贴合。";
    return compactText(`${track} 是因为${reason}`, 180);
  }
}
