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

function listenerFacingDirection(contract: StationContract | null | undefined): string {
  const direction = compactText(contract?.mainDirection || "", 80);
  return isVagueDirection(direction) ? "" : direction;
}

function isVagueDirection(value: string): boolean {
  const normalized = value.toLocaleLowerCase().normalize("NFKC").replace(/\s+/g, "");
  if (!normalized) return true;
  if (
    [
      "继续保持这个感觉",
      "继续保持这个频率",
      "保持这个感觉",
      "保持这个频率",
      "当前电台方向",
      "刚才的方向",
      "刚才的感觉",
      "airadio",
    ].includes(normalized)
  ) {
    return true;
  }
  return /^(继续|延续)(保持|当前|刚才|这个)/u.test(normalized);
}

export class HostNarrationLayer {
  async forQueueItem(args: QueueNarrationArgs): Promise<QueueNarrationResult> {
    const status = args.boundaryDecision?.status;
    if (status === "accept_as_bridge") {
      const direction = listenerFacingDirection(args.stationContract);
      const returnLine = direction ? `下一首我会往 ${direction} 收回来。` : "后面我会把频率慢慢收回来。";
      return {
        shouldSpeak: true,
        event: "bridge_entered",
        text: compactText(
          `这里用 ${args.track.artist} 的《${args.track.name}》做一小段过渡，留一点夜里的空间，${returnLine}`,
          180,
        ),
      };
    }

    if (status === "accept_as_adjacent" && args.recentNarrationCount <= 0) {
      const direction = listenerFacingDirection(args.stationContract);
      const text = direction
        ? `这首先把质感往旁边轻轻推一点，后面我会把它收回到 ${direction}。`
        : "这首会先往旁边探一下，借一点空间感，后面我会把频率慢慢收回来。";
      return {
        shouldSpeak: true,
        event: "direction_changed",
        text: compactText(text, 140),
      };
    }

    return { shouldSpeak: false, text: "" };
  }

  requestAck(contract: StationContract): string {
    const direction = listenerFacingDirection(contract);
    return compactText(
      direction
        ? `收到，接下来我会守住 ${direction} 这条线，轻一点，不乱跳。`
        : "收到，接下来我会守住刚才舒服的气口，轻一点，不乱跳。",
      120,
    );
  }
}
