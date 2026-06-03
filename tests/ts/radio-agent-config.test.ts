import assert from "node:assert/strict";
import test from "node:test";

import { parseRadioAgentMode } from "../../src/config.js";

test("config parses radio agent mode from environment safely", () => {
  assert.equal(parseRadioAgentMode(undefined), "shadow");
  assert.equal(parseRadioAgentMode(""), "shadow");
  assert.equal(parseRadioAgentMode("assisted"), "assisted");
  assert.equal(parseRadioAgentMode("ACTIVE"), "active");
  assert.equal(parseRadioAgentMode("shadow"), "shadow");
  assert.equal(parseRadioAgentMode("anything-else"), "shadow");
});
