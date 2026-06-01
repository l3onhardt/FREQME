import type { QueueItem } from "./playbackQueue.js";
import type { PlaybackQueue } from "./playbackQueue.js";
import type { SelectionReason, Track } from "../types.js";

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
