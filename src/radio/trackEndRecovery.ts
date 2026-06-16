import type { QueueItem } from "./playbackQueue.js";
import type { ReadyItemSnapshot } from "./requestReadySelector.js";

export type TrackEndRecoveryAction = "promote_ready" | "queued_program" | "legacy_fallback";
export type TrackEndRecoverySource =
  | "ready"
  | "legacy_fill"
  | "recent_playable_fallback"
  | "brain_continuation"
  | "empty";

export interface TrackEndRecoveryArgs {
  readyCount: () => number;
  sanitizeReadyItems?: () => void;
  trackEndAction: TrackEndRecoveryAction;
  allowContinuation: boolean;
  hasActiveRequest: boolean;
  hasActiveStationContract?: boolean;
  fillLegacyQueue: () => Promise<void>;
  addRecentPlayableFallback: () => Promise<boolean>;
  kickBrainContinuation: () => ReadyItemSnapshot;
  waitForNewBrainReadyItem: (beforeRequest: ReadyItemSnapshot) => Promise<QueueItem | null>;
  prepareFreshBrainReadyForPromotion: (beforeRequest: ReadyItemSnapshot) => QueueItem | null;
  legacyFillTimeoutMs?: number;
}

export interface TrackEndRecoveryResult {
  source: TrackEndRecoverySource;
  legacyFillTimedOut: boolean;
}

const DEFAULT_LEGACY_FILL_TIMEOUT_MS = 1200;

export async function ensureTrackEndReadyItem(args: TrackEndRecoveryArgs): Promise<TrackEndRecoveryResult> {
  if (sanitizedReadyCount(args) > 0) return result("ready");

  const legacyFillTimedOut = await runLegacyFillWithTimeout(args);
  if (sanitizedReadyCount(args) > 0) return result("legacy_fill", legacyFillTimedOut);

  const preferContinuationBeforeRecentFallback = Boolean(args.hasActiveStationContract);
  if (preferContinuationBeforeRecentFallback && (await tryBrainContinuation(args))) {
    return result("brain_continuation", legacyFillTimedOut);
  }

  if (await addRecentPlayable(args)) return result("recent_playable_fallback", legacyFillTimedOut);

  if (!preferContinuationBeforeRecentFallback && (await tryBrainContinuation(args))) {
    return result("brain_continuation", legacyFillTimedOut);
  }

  if (await addRecentPlayable(args)) return result("recent_playable_fallback", legacyFillTimedOut);

  return result("empty", legacyFillTimedOut);
}

async function runLegacyFillWithTimeout(args: TrackEndRecoveryArgs): Promise<boolean> {
  const timeoutMs = Math.max(0, args.legacyFillTimeoutMs ?? DEFAULT_LEGACY_FILL_TIMEOUT_MS);
  const fill = Promise.resolve()
    .then(() => args.fillLegacyQueue())
    .then(
      () => "completed" as const,
      () => "completed" as const,
    );
  const completed = timeoutMs === 0 ? fill : await Promise.race([fill, timeout(timeoutMs)]);
  return completed === "timed_out";
}

async function tryBrainContinuation(args: TrackEndRecoveryArgs): Promise<boolean> {
  if (!args.allowContinuation || args.hasActiveRequest) return false;
  const beforeContinuation = args.kickBrainContinuation();
  const ready = await args.waitForNewBrainReadyItem(beforeContinuation);
  if (!ready) return false;
  const prepared = args.prepareFreshBrainReadyForPromotion(beforeContinuation);
  return Boolean(prepared || sanitizedReadyCount(args) > 0);
}

async function addRecentPlayable(args: TrackEndRecoveryArgs): Promise<boolean> {
  if (sanitizedReadyCount(args) > 0) return true;
  const added = await args.addRecentPlayableFallback().catch(() => false);
  return added && sanitizedReadyCount(args) > 0;
}

function sanitizedReadyCount(args: TrackEndRecoveryArgs): number {
  args.sanitizeReadyItems?.();
  return args.readyCount();
}

function timeout(ms: number): Promise<"timed_out"> {
  return new Promise((resolve) => setTimeout(() => resolve("timed_out"), ms));
}

function result(source: TrackEndRecoverySource, legacyFillTimedOut = false): TrackEndRecoveryResult {
  return { source, legacyFillTimedOut };
}
