import { compactText } from "../utils/text.js";
import type { DecisionTrace, ListeningIntentDecision } from "./radioBrainTypes.js";

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
    const track = `${trace.selectedTrack.artist} 的 ${trace.selectedTrack.name}`.trim();
    const reason = trace.reason || trace.hostText || "它和刚才的电台方向比较贴合。";
    return compactText(`${track} 是因为${reason}`, 180);
  }
}
