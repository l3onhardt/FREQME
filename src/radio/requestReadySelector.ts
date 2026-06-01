import type { QueueItem } from "./playbackQueue.js";
import type { PlaybackQueue } from "./playbackQueue.js";

export type ReadyItemSnapshot = ReadonlySet<QueueItem>;

export function snapshotReadyItems(queue: PlaybackQueue): ReadyItemSnapshot {
  return new Set(queue.readyItems());
}

export function findNewBrainReadyItem(queue: PlaybackQueue, beforeRequest: ReadyItemSnapshot): QueueItem | null {
  return queue.readyItems().find((item) => !beforeRequest.has(item) && isBrainReadyItem(item)) || null;
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

function isBrainReadyItem(item: QueueItem): boolean {
  return (
    item.selectionReason.type === "ai_radio_episode" ||
    Boolean(item.selectionReason.traceId) ||
    Boolean(item.selectionReason.episodeId)
  );
}
