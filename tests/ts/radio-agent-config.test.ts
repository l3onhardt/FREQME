import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

test("config exposes radio agent mode from environment", () => {
  const source = fs.readFileSync("src/config.ts", "utf8");

  assert.match(source, /RADIO_AGENT_MODE/);
  assert.match(source, /radioAgentMode/);
});
