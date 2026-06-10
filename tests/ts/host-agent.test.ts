import assert from "node:assert/strict";
import test from "node:test";

import { planHostSpeech } from "../../src/radio-agent/hostAgent.js";

const badHostText =
  /shadow decision|low-interruption|program contract|decision trace|model|prompt|JSON|candidate|verification|tool call|鏃佽竟|璐ㄦ劅|褰撳墠鐢靛彴鏂瑰悜|鎴戝厛|濂斤紝|閬垮紑|鐢靛瓙|鍙ゅ吀|閹磡|娑搢|淇檤|闁箌|濞憒/i;

test("host agent opens the station in natural listener-facing language", () => {
  const decision = planHostSpeech({
    eventType: "login_completed",
    profileReady: false,
    lowInterruption: false,
    recentHostLines: [],
  });

  assert.equal(decision.shouldSpeak, true);
  assert.equal(decision.event, "station_open");
  assert.match(decision.text || "", /先接一首|先放一首/);
  assert.match(decision.text || "", /后面|慢慢|习惯|歌单/);
  assert.doesNotMatch(decision.text || "", badHostText);
});

test("host agent acknowledges explicit R&B corrections with concrete boundaries", () => {
  const decision = planHostSpeech({
    eventType: "user_text",
    profileReady: true,
    lowInterruption: false,
    recentHostLines: [],
    userText: "放点 rnb，不要电子，不要古典",
  });

  assert.equal(decision.shouldSpeak, true);
  assert.equal(decision.event, "user_ack");
  assert.match(decision.text || "", /R&B/i);
  assert.match(decision.text || "", /电子/);
  assert.match(decision.text || "", /古典/);
  assert.match(decision.text || "", /避开|不乱跳|先不/);
  assert.doesNotMatch(decision.text || "", badHostText);
});

test("host agent acknowledges explicit negative artist feedback", () => {
  const decision = planHostSpeech({
    eventType: "user_text",
    profileReady: true,
    lowInterruption: false,
    recentHostLines: [],
    userText: "不要 Frank Ocean, less SZA tonight",
  });

  assert.equal(decision.shouldSpeak, true);
  assert.equal(decision.event, "user_ack");
  assert.match(decision.text || "", /Frank Ocean/);
  assert.match(decision.text || "", /SZA/);
  assert.match(decision.text || "", /避开|先不|不放|换/);
  assert.doesNotMatch(decision.text || "", badHostText);
});

test("host agent stays quiet on ordinary low-interruption continuation after recent speech", () => {
  const decision = planHostSpeech({
    eventType: "track_completed",
    profileReady: true,
    lowInterruption: true,
    recentHostLines: ["我先顺着 Frank Ocean 的方向接一首。"],
  });

  assert.equal(decision.shouldSpeak, false);
  assert.equal(decision.event, "silent");
  assert.match(decision.reason, /ordinary|low-interruption/i);
  assert.equal(decision.text, undefined);
});

test("host agent uses a concrete anchor for queue recovery handoff", () => {
  const decision = planHostSpeech({
    eventType: "queue_low",
    profileReady: true,
    lowInterruption: false,
    recentHostLines: [],
    anchor: "Frank Ocean",
    direction: "late-night R&B",
  });

  assert.equal(decision.shouldSpeak, true);
  assert.equal(decision.event, "return");
  assert.match(decision.text || "", /Frank Ocean/);
  assert.match(decision.text || "", /接一首|续上|稳住/);
  assert.doesNotMatch(decision.text || "", badHostText);
});
