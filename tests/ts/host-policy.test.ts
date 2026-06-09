import assert from "node:assert/strict";
import test from "node:test";

import { decideHostSpeech } from "../../src/radio-agent/hostPolicy.js";

const mojibakeTerms = /鎴|銆|鐨|涓|浣|绾|俙|紝/;
const awkwardTerms = /继续保持这个感觉|旁边|质感|主线还是|当前电台方向/;

test("host speaks for first station handoff", () => {
  const decision = decideHostSpeech({
    eventType: "login_completed",
    recentHostLines: [],
    profileReady: false,
    lowInterruption: false,
  });

  assert.equal(decision.shouldSpeak, true);
  assert.equal(decision.event, "station_open");
  assert.doesNotMatch(decision.text || "", mojibakeTerms);
});

test("host opening line changes after profile is ready", () => {
  const decision = decideHostSpeech({
    eventType: "login_completed",
    recentHostLines: [],
    profileReady: true,
    lowInterruption: false,
  });

  assert.equal(decision.shouldSpeak, true);
  assert.equal(decision.event, "station_open");
  assert.doesNotMatch(decision.text || "", /后台|整理|profile|model|trace/i);
  assert.doesNotMatch(decision.text || "", mojibakeTerms);
  assert.match(decision.text || "", /熟悉|接上|习惯/);
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
  assert.doesNotMatch(decision.text || "", mojibakeTerms);
});

test("host acknowledges explicit R&B boundaries in human language", () => {
  const decision = decideHostSpeech({
    eventType: "user_text",
    recentHostLines: [],
    profileReady: true,
    lowInterruption: false,
    userText: "放点 rnb，不要电子，不要古典",
  });

  assert.equal(decision.shouldSpeak, true);
  assert.equal(decision.event, "user_ack");
  assert.match(decision.text || "", /R&B|rnb/i);
  assert.match(decision.text || "", /电子|古典|避开/);
  assert.doesNotMatch(decision.text || "", awkwardTerms);
  assert.doesNotMatch(decision.text || "", mojibakeTerms);
});

test("host acknowledges explicit artist-level avoids", () => {
  const decision = decideHostSpeech({
    eventType: "user_text",
    recentHostLines: [],
    profileReady: true,
    lowInterruption: false,
    userText: "不要Frank Ocean，less SZA tonight",
  });

  assert.equal(decision.shouldSpeak, true);
  assert.equal(decision.event, "user_ack");
  assert.match(decision.text || "", /Frank Ocean/);
  assert.match(decision.text || "", /SZA/);
  assert.match(decision.text || "", /避开|先不|不放|换/);
  assert.doesNotMatch(decision.text || "", /model|prompt|json|trace|candidate|verification|tool call/i);
  assert.doesNotMatch(decision.text || "", awkwardTerms);
  assert.doesNotMatch(decision.text || "", mojibakeTerms);
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
  assert.doesNotMatch(decision.text || "", mojibakeTerms);
});
