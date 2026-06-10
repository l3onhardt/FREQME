import assert from "node:assert/strict";
import test from "node:test";

import { envFileCandidates, parseRadioAgentMode } from "../../src/config.js";

test("config parses radio agent mode from environment safely", () => {
  assert.equal(parseRadioAgentMode(undefined), "assisted");
  assert.equal(parseRadioAgentMode(""), "assisted");
  assert.equal(parseRadioAgentMode("assisted"), "assisted");
  assert.equal(parseRadioAgentMode("ACTIVE"), "active");
  assert.equal(parseRadioAgentMode("shadow"), "shadow");
  assert.equal(parseRadioAgentMode("anything-else"), "assisted");
});

test("config can discover the parent workspace env file from a git worktree", () => {
  const candidates = envFileCandidates("C:\\Users\\lacr1\\Desktop\\AI音乐\\.worktrees\\hermes-radio-agent-service");

  assert.equal(candidates[0], "C:\\Users\\lacr1\\Desktop\\AI音乐\\.worktrees\\hermes-radio-agent-service\\.env");
  assert.ok(candidates.includes("C:\\Users\\lacr1\\Desktop\\AI音乐\\.env"));
});
