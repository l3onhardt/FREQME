import assert from "node:assert/strict";
import test from "node:test";

import { hostTextForRadioAgentDelivery } from "../../src/radio-agent/hostDelivery.js";
import type { RadioHostDecision } from "../../src/radio-agent/types.js";

function decision(overrides: Partial<RadioHostDecision> = {}): RadioHostDecision {
  return {
    shouldSpeak: true,
    event: "correction",
    reason: "listener correction",
    text: "明白，这首先避开，我把方向收回来。",
    ...overrides,
  };
}

test("host delivery speaks agent correction decisions for real-time playback feedback", () => {
  const text = hostTextForRadioAgentDelivery({
    eventType: "track_skipped",
    decision: decision(),
  });

  assert.equal(text, "明白，这首先避开，我把方向收回来。");
});

test("host delivery suppresses direct user text because the request path already speaks", () => {
  const text = hostTextForRadioAgentDelivery({
    eventType: "user_text",
    decision: decision({ event: "user_ack", text: "收到，我按这个方向调整。" }),
  });

  assert.equal(text, "");
});

test("host delivery keeps ordinary silent decisions off the speaker", () => {
  const text = hostTextForRadioAgentDelivery({
    eventType: "track_completed",
    decision: decision({ shouldSpeak: false, event: "silent", text: undefined }),
  });

  assert.equal(text, "");
});

test("host delivery does not speak internal or broken planning text", () => {
  const text = hostTextForRadioAgentDelivery({
    eventType: "track_skipped",
    decision: decision({ text: "The shadow decision says this candidate is valid JSON." }),
  });

  assert.equal(text, "");
});
