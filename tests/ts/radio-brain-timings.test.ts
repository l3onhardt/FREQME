import assert from "node:assert/strict";
import test from "node:test";

import {
  CONTINUATION_BRAIN_READY_TIMEOUT_MS,
  EPISODE_PLANNER_TIMEOUT_MS,
  USER_REQUEST_BRAIN_READY_TIMEOUT_MS,
  USER_REQUEST_STILL_PLANNING_AFTER_MS,
} from "../../src/radio/radioBrainTimings.js";

test("user request wait budget covers the real AI episode planning window", () => {
  assert.equal(EPISODE_PLANNER_TIMEOUT_MS, 35000);
  assert.ok(USER_REQUEST_BRAIN_READY_TIMEOUT_MS > EPISODE_PLANNER_TIMEOUT_MS);
  assert.ok(USER_REQUEST_STILL_PLANNING_AFTER_MS < EPISODE_PLANNER_TIMEOUT_MS);
});

test("continuation warmup keeps the live station responsive", () => {
  assert.ok(CONTINUATION_BRAIN_READY_TIMEOUT_MS < USER_REQUEST_BRAIN_READY_TIMEOUT_MS);
  assert.ok(CONTINUATION_BRAIN_READY_TIMEOUT_MS >= 5000);
});
