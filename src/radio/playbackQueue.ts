import type { SelectionReason, Track } from "../types.js";

export interface QueueItem {
  track: Track;
  url: string;
  status: "ready" | "playing" | "played" | "skipped";
  selectionReason: SelectionReason;
  segueText?: string;
  ttsHash?: string;
}

export class PlaybackQueue {
  readonly items: QueueItem[] = [];

  constructor(private readonly prewarmDepth = 3) {}

  readyItems(): QueueItem[] {
    return this.items.filter((item) => item.status === "ready");
  }

  current(): QueueItem | undefined {
    return this.items.find((item) => item.status === "playing");
  }

  prewarmNeeded(): number {
    return Math.max(0, this.prewarmDepth - this.readyItems().length);
  }

  addReady(
    track: Track,
    url: string,
    selectionReason: SelectionReason,
    options: { segueText?: string; ttsHash?: string } = {},
  ): void {
    this.items.push({
      track: { ...track, selectionReason },
      url,
      status: "ready",
      selectionReason,
      segueText: options.segueText || "",
      ttsHash: options.ttsHash || "",
    });
  }

  promoteNext(previousEvent = "played"): QueueItem | null {
    const current = this.current();
    if (current) current.status = previousEvent === "skipped" ? "skipped" : "played";
    const next = this.readyItems()[0];
    if (!next) return null;
    next.status = "playing";
    return next;
  }

  markCurrent(status: "played" | "skipped"): void {
    const current = this.current();
    if (current) current.status = status;
  }

  clearReady(): void {
    for (let index = this.items.length - 1; index >= 0; index -= 1) {
      if (this.items[index]?.status === "ready") {
        this.items.splice(index, 1);
      }
    }
  }

  removeReadyWhere(predicate: (item: QueueItem) => boolean): number {
    let removed = 0;
    for (let index = this.items.length - 1; index >= 0; index -= 1) {
      const item = this.items[index];
      if (item?.status === "ready" && predicate(item)) {
        this.items.splice(index, 1);
        removed += 1;
      }
    }
    return removed;
  }

  readyDepth(): number {
    return this.readyItems().length;
  }
}
