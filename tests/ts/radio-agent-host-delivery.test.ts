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

test("host delivery speaks recovery decisions after agent repair", () => {
  const text = hostTextForRadioAgentDelivery({
    eventType: "queue_low",
    decision: decision({
      event: "recovery",
      reason: "recovering from the last failed queue attempt",
      text: "刚才那一下没接稳，我把电台拉回 R&B，先接 Daniel Caesar 的方向。",
    }),
  });

  assert.equal(text, "刚才那一下没接稳，我把电台拉回 R&B，先接 Daniel Caesar 的方向。");
});

test("host delivery does not speak internal or broken planning text", () => {
  const text = hostTextForRadioAgentDelivery({
    eventType: "track_skipped",
    decision: decision({ text: "The shadow decision says this candidate is valid JSON." }),
  });

  assert.equal(text, "");
});

test("host delivery does not speak mojibake fallback text", () => {
  const text = hostTextForRadioAgentDelivery({
    eventType: "track_skipped",
    decision: decision({ text: "鏄庣櫧锛岃繖棣栧厛閬垮紑锛屾垜鎶婃柟鍚戞敹鍥炴潵銆?" }),
  });

  assert.equal(text, "");
});
