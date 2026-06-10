import assert from "node:assert/strict";
import test from "node:test";

import { normalizeRadioAgentEvent } from "../../src/radio-agent/types.js";

test("login and user text are hot radio agent events", () => {
  assert.equal(normalizeRadioAgentEvent({ type: "login_completed", uid: "42" }).priority, "hot");
  assert.equal(normalizeRadioAgentEvent({ type: "user_text", uid: "42", text: "why this song?" }).priority, "hot");
  assert.equal(normalizeRadioAgentEvent({ type: "track_skipped", uid: "42" }).priority, "hot");
});

test("library scan and idle ticks are cold events", () => {
  assert.equal(normalizeRadioAgentEvent({ type: "library_scan_requested", uid: "42" }).priority, "cold");
  assert.equal(normalizeRadioAgentEvent({ type: "idle_tick", uid: "42" }).priority, "cold");
  assert.equal(normalizeRadioAgentEvent({ type: "playback_progress", uid: "42" }).priority, "cold");
});

test("queue low and track completed are warm events", () => {
  assert.equal(normalizeRadioAgentEvent({ type: "queue_low", uid: "42" }).priority, "warm");
  assert.equal(
    normalizeRadioAgentEvent({
      type: "program_track_queued",
      uid: "42",
      track: { id: "1", name: "A", artist: "B" },
      programWindowId: "window-1",
    }).priority,
    "warm",
  );
  assert.equal(
    normalizeRadioAgentEvent({
      type: "track_completed",
      uid: "42",
      track: { id: "1", name: "A", artist: "B" },
    }).priority,
    "warm",
  );
});

test("normalization keeps unknown details in payload and fills createdAt", () => {
  const event = normalizeRadioAgentEvent({
    type: "playback_started",
    uid: "42",
    sessionId: 9,
    track: { id: "1", name: "A", artist: "B" },
  });

  assert.equal(event.sessionId, 9);
  assert.deepEqual(event.payload.track, { id: "1", name: "A", artist: "B" });
  assert.match(event.createdAt, /^\d{4}-\d{2}-\d{2}T/);
});
