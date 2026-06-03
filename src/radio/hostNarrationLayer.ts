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

function trackLabel(track: Track): string {
  const artist = compactText(track.artist || "", 40);
  const name = compactText(track.name || "", 80);
  if (artist && name) return `${artist} 的《${name}》`;
  if (name) return `《${name}》`;
  if (artist) return artist;
  return "这首歌";
}

export class HostNarrationLayer {
  async forQueueItem(args: QueueNarrationArgs): Promise<QueueNarrationResult> {
    const status = args.boundaryDecision?.status;
    if (status === "accept_as_bridge") {
      const direction = listenerFacingDirection(args.stationContract);
      const returnLine = direction ? `下一首我会带回 ${direction}。` : "后面我会把电台稳稳接住。";
      return {
        shouldSpeak: true,
        event: "bridge_entered",
        text: compactText(
          `这里先用 ${trackLabel(args.track)}做一个短过渡，${returnLine}`,
          180,
        ),
      };
    }

    if (status === "accept_as_adjacent" && args.recentNarrationCount <= 0) {
      const direction = listenerFacingDirection(args.stationContract);
      const text = direction
        ? `这首先用 ${trackLabel(args.track)}换一下呼吸，后面我会带回 ${direction}。`
        : `我先用 ${trackLabel(args.track)}接住这一段，让电台稳稳往前走。`;
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
