import assert from "node:assert/strict";
import test from "node:test";

import { decideHostSpeech } from "../../src/radio-agent/hostPolicy.js";

test("host speaks for first station handoff", () => {
  const decision = decideHostSpeech({
    eventType: "login_completed",
    recentHostLines: [],
    profileReady: false,
    lowInterruption: false,
  });

  assert.equal(decision.shouldSpeak, true);
  assert.equal(decision.event, "station_open");
});

test("host records silence for ordinary continuation", () => {
  const decision = decideHostSpeech({
    eventType: "track_completed",
    recentHostLines: ["already spoke"],
    profileReady: true,
    lowInterruption: true,
  });

  assert.equal(decision.shouldSpeak, false);
  assert.equal(decision.event, "silent");
  assert.match(decision.reason, /low-interruption|ordinary/i);
});

test("host speaks for direct user text", () => {
  const decision = decideHostSpeech({
    eventType: "user_text",
    recentHostLines: ["already spoke"],
    profileReady: true,
    lowInterruption: true,
    userText: "why this song?",
  });

  assert.equal(decision.shouldSpeak, true);
  assert.equal(decision.event, "user_ack");
});

test("host text never exposes internal planning terms", () => {
  const decision = decideHostSpeech({
    eventType: "queue_low",
    recentHostLines: [],
    profileReady: true,
    lowInterruption: false,
    proposedText: "The shadow decision says this is a low-interruption bridge.",
  });

  assert.equal(/shadow decision|low-interruption|bridge/i.test(decision.text || ""), false);
});
