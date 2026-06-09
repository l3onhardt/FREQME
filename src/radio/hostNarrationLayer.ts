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
      const returnLine = direction ? `下一首我会拉回 ${direction}。` : "下一首我会把电台重新稳住。";
      return {
        shouldSpeak: true,
        event: "bridge_entered",
        text: compactText(`这里先用 ${trackLabel(args.track)} 做一首短过渡，${returnLine}`, 180),
      };
    }

    if (status === "accept_as_adjacent" && args.recentNarrationCount <= 0) {
      const direction = listenerFacingDirection(args.stationContract);
      const text = direction
        ? `这首稍微放宽一点，但后面会回到 ${direction}。`
        : `先用${trackLabel(args.track)}接住这一段，电台不会乱跳。`;
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
        ? `收到，接下来我会守住 ${direction}，人声和律动靠前，明显不合适的方向先避开。`
        : "收到，接下来我会守住刚才舒服的气口，不乱跳。",
      120,
    );
  }
}
