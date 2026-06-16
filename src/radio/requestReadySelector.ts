import type { QueueItem } from "./playbackQueue.js";
import type { PlaybackQueue } from "./playbackQueue.js";
import type { BoundaryGuard } from "./boundaryGuard.js";
import type { StationContract } from "./radioBrainTypes.js";
import type { SelectionReason, Track } from "../types.js";
import { sameTrack } from "../radio-agent/playbackGovernor.js";

export type ReadyItemSnapshot = ReadonlySet<QueueItem>;

export interface FallbackReadyItem {
  track: Track;
  url: string;
  selectionReason: SelectionReason;
}

export type FreshOrFallbackReady =
  | { source: "brain"; item: QueueItem }
  | { source: "fallback"; item: QueueItem };

export function snapshotReadyItems(queue: PlaybackQueue): ReadyItemSnapshot {
  return new Set(queue.readyItems());
}

export function findNewBrainReadyItem(queue: PlaybackQueue, beforeRequest: ReadyItemSnapshot): QueueItem | null {
  return queue.readyItems().find((item) => !beforeRequest.has(item) && isBrainReadyItem(item)) || null;
}

export function prepareFreshBrainReadyForPromotion(queue: PlaybackQueue, beforeRequest: ReadyItemSnapshot): QueueItem | null {
  const ready = findNewBrainReadyItem(queue, beforeRequest);
  if (!ready) return null;
  removeReadyItemsBefore(queue, ready);
  return ready;
}

export function prepareFreshBrainReadyOrReplaceWithFallback(
  queue: PlaybackQueue,
  beforeRequest: ReadyItemSnapshot,
  fallback: FallbackReadyItem,
): FreshOrFallbackReady {
  const ready = prepareFreshBrainReadyForPromotion(queue, beforeRequest);
  if (ready) return { source: "brain", item: ready };

  queue.clearReady();
  queue.addReady(fallback.track, fallback.url, fallback.selectionReason);
  const item = queue.readyItems()[0];
  if (!item) {
    throw new Error("fallback ready item was not queued");
  }
  return { source: "fallback", item };
}

export function removeReadyItemsBefore(queue: PlaybackQueue, target: QueueItem | null): number {
  if (!target) return 0;
  const staleAhead = new Set<QueueItem>();
  for (const item of queue.readyItems()) {
    if (item === target) break;
    staleAhead.add(item);
  }
  if (!staleAhead.size) return 0;
  return queue.removeReadyWhere((item) => staleAhead.has(item));
}

export function removeReadyItemsOutsideStationContract(
  queue: PlaybackQueue,
  stationContract: StationContract | null | undefined,
  boundaryGuard: Pick<BoundaryGuard, "evaluate">,
): number {
  if (!stationContract) return 0;
  return queue.removeReadyWhere((item) => {
    const decision = boundaryGuard.evaluate({
      contract: stationContract,
      query: item.selectionReason.text || item.selectionReason.understoodIntent || "ready queue promotion",
      candidate: item.track,
      fallbackLevel: "recent_verified",
      itemStyle: item.track.source || item.selectionReason.text || "",
    });
    return decision.status.startsWith("reject_");
  });
}

export function removeReadyItemsMatchingRecentPlayback(
  queue: PlaybackQueue,
  currentTrack: Track | null | undefined,
  recentTracks: Track[],
  windowSize = 8,
): number {
  const protectedTracks = [currentTrack, ...recentTracks.slice(0, windowSize)].filter((track): track is Track => Boolean(track));
  if (!protectedTracks.length) return 0;
  return queue.removeReadyWhere((item) =>
    protectedTracks.some((protectedTrack) => sameTrack(item.track, protectedTrack)),
  );
}

export function isCurrentRequestToken(activeToken: number | null, requestToken: number): boolean {
  return activeToken === requestToken;
}

function isBrainReadyItem(item: QueueItem): boolean {
  return (
    item.selectionReason.type === "ai_radio_episode" ||
    Boolean(item.selectionReason.traceId) ||
    Boolean(item.selectionReason.episodeId)
  );
}
