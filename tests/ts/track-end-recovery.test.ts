import assert from "node:assert/strict";
import test from "node:test";

import { ensureTrackEndReadyItem } from "../../src/radio/trackEndRecovery.js";
import type { ReadyItemSnapshot } from "../../src/radio/requestReadySelector.js";

test("track-end recovery does not call slow recovery when a ready item already exists", async () => {
  const calls: string[] = [];

  const result = await ensureTrackEndReadyItem({
    readyCount: () => 1,
    trackEndAction: "promote_ready",
    allowContinuation: true,
    hasActiveRequest: false,
    fillLegacyQueue: async () => {
      calls.push("fill");
    },
    addRecentPlayableFallback: async () => {
      calls.push("recent");
      return true;
    },
    kickBrainContinuation: () => {
      calls.push("brain");
      return new Set() as ReadyItemSnapshot;
    },
    waitForNewBrainReadyItem: async () => null,
    prepareFreshBrainReadyForPromotion: () => null,
    legacyFillTimeoutMs: 1,
  });

  assert.equal(result.source, "ready");
  assert.deepEqual(calls, []);
});

test("track-end recovery uses quick recent fallback when legacy fill is too slow", async () => {
  const calls: string[] = [];
  let readyCount = 0;

  const result = await ensureTrackEndReadyItem({
    readyCount: () => readyCount,
    trackEndAction: "legacy_fallback",
    allowContinuation: true,
    hasActiveRequest: false,
    fillLegacyQueue: async () => {
      calls.push("fill");
      await new Promise(() => undefined);
    },
    addRecentPlayableFallback: async () => {
      calls.push("recent");
      readyCount = 1;
      return true;
    },
    kickBrainContinuation: () => {
      calls.push("brain");
      return new Set() as ReadyItemSnapshot;
    },
    waitForNewBrainReadyItem: async () => null,
    prepareFreshBrainReadyForPromotion: () => null,
    legacyFillTimeoutMs: 1,
  });

  assert.equal(result.source, "recent_playable_fallback");
  assert.equal(result.legacyFillTimedOut, true);
  assert.deepEqual(calls, ["fill", "recent"]);
});

test("track-end recovery still falls back when the agent claimed a program but no ready item remains", async () => {
  const calls: string[] = [];
  let readyCount = 0;

  const result = await ensureTrackEndReadyItem({
    readyCount: () => readyCount,
    trackEndAction: "queued_program",
    allowContinuation: true,
    hasActiveRequest: false,
    fillLegacyQueue: async () => {
      calls.push("fill");
    },
    addRecentPlayableFallback: async () => {
      calls.push("recent");
      readyCount = 1;
      return true;
    },
    kickBrainContinuation: () => {
      calls.push("brain");
      return new Set() as ReadyItemSnapshot;
    },
    waitForNewBrainReadyItem: async () => null,
    prepareFreshBrainReadyForPromotion: () => null,
    legacyFillTimeoutMs: 1,
  });

  assert.equal(result.source, "recent_playable_fallback");
  assert.deepEqual(calls, ["fill", "recent"]);
});

test("track-end recovery keeps an immediate legacy fill ahead of recent fallback", async () => {
  const calls: string[] = [];
  let readyCount = 0;

  const result = await ensureTrackEndReadyItem({
    readyCount: () => readyCount,
    trackEndAction: "legacy_fallback",
    allowContinuation: true,
    hasActiveRequest: false,
    fillLegacyQueue: async () => {
      calls.push("fill");
      readyCount = 1;
    },
    addRecentPlayableFallback: async () => {
      calls.push("recent");
      return true;
    },
    kickBrainContinuation: () => {
      calls.push("brain");
      return new Set() as ReadyItemSnapshot;
    },
    waitForNewBrainReadyItem: async () => null,
    prepareFreshBrainReadyForPromotion: () => null,
    legacyFillTimeoutMs: 10,
  });

  assert.equal(result.source, "legacy_fill");
  assert.equal(result.legacyFillTimedOut, false);
  assert.deepEqual(calls, ["fill"]);
});

test("track-end recovery asks the agent continuation before recent fallback when a station contract is active", async () => {
  const calls: string[] = [];
  let readyCount = 0;

  const result = await ensureTrackEndReadyItem({
    readyCount: () => readyCount,
    trackEndAction: "legacy_fallback",
    allowContinuation: true,
    hasActiveRequest: false,
    hasActiveStationContract: true,
    fillLegacyQueue: async () => {
      calls.push("fill");
    },
    addRecentPlayableFallback: async () => {
      calls.push("recent");
      readyCount = 1;
      return true;
    },
    kickBrainContinuation: () => {
      calls.push("brain");
      return new Set() as ReadyItemSnapshot;
    },
    waitForNewBrainReadyItem: async () => {
      calls.push("wait");
      readyCount = 1;
      return { track: { id: "agent-1", name: "Blue in Green", artist: "Miles Davis" } } as any;
    },
    prepareFreshBrainReadyForPromotion: () => {
      calls.push("prepare");
      return { track: { id: "agent-1", name: "Blue in Green", artist: "Miles Davis" } } as any;
    },
    legacyFillTimeoutMs: 1,
  });

  assert.equal(result.source, "brain_continuation");
  assert.deepEqual(calls, ["fill", "brain", "wait", "prepare"]);
});

test("track-end recovery sanitizes ready items before deciding recovery is unnecessary", async () => {
  const calls: string[] = [];
  let readyCount = 1;
  let staleReadyItems = 1;

  const result = await ensureTrackEndReadyItem({
    readyCount: () => readyCount,
    sanitizeReadyItems: () => {
      calls.push("sanitize");
      if (staleReadyItems > 0) {
        readyCount -= staleReadyItems;
        staleReadyItems = 0;
      }
    },
    trackEndAction: "promote_ready",
    allowContinuation: true,
    hasActiveRequest: false,
    hasActiveStationContract: true,
    fillLegacyQueue: async () => {
      calls.push("fill");
    },
    addRecentPlayableFallback: async () => {
      calls.push("recent");
      readyCount = 1;
      return true;
    },
    kickBrainContinuation: () => {
      calls.push("brain");
      return new Set() as ReadyItemSnapshot;
    },
    waitForNewBrainReadyItem: async () => null,
    prepareFreshBrainReadyForPromotion: () => null,
    legacyFillTimeoutMs: 1,
  });

  assert.equal(result.source, "recent_playable_fallback");
  assert.deepEqual(calls, ["sanitize", "fill", "sanitize", "brain", "sanitize", "recent", "sanitize"]);
});
