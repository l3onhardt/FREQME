import type { Track } from "../types.js";
import { compactText } from "../utils/text.js";
import type { BoundaryDecision, HostNarration, StationContract } from "./radioBrainTypes.js";

export interface QueueNarrationArgs {
  stationContract?: StationContract | null;
  boundaryDecision?: BoundaryDecision | null;
  track: Track;
  reason: string;
  recentNarrationCount: number;
}

export interface QueueNarrationResult {
  shouldSpeak: boolean;
  text: string;
  event?: HostNarration["event"];
}

export class HostNarrationLayer {
  async forQueueItem(args: QueueNarrationArgs): Promise<QueueNarrationResult> {
    const status = args.boundaryDecision?.status;
    if (status === "accept_as_bridge") {
      const direction = args.stationContract?.mainDirection || "刚才的方向";
      return {
        shouldSpeak: true,
        event: "bridge_entered",
        text: compactText(
          `这里用 ${args.track.artist} 的 ${args.track.name} 做一小段过渡，留一点夜里的空间感，下一首会往 ${direction} 拉回。`,
          180,
        ),
      };
    }

    if (status === "accept_as_adjacent" && args.recentNarrationCount <= 0) {
      const direction = args.stationContract?.mainDirection || "当前电台方向";
      return {
        shouldSpeak: true,
        event: "direction_changed",
        text: compactText(`这首会稍微贴近旁边的质感，但主线还是 ${direction}。`, 140),
      };
    }

    return { shouldSpeak: false, text: "" };
  }

  requestAck(contract: StationContract): string {
    return compactText(`收到，我会把接下来的歌守在 ${contract.mainDirection} 这条线上，轻一点，不乱跳。`, 120);
  }
}
