import assert from "node:assert/strict";
import test from "node:test";

import { IntentRouter } from "../../src/radio/intentRouter.js";

test("negated style is a constraint instead of a positive direction", () => {
  const router = new IntentRouter();
  const intent = router.classify("我现在要专注写代码，别太 emo，也不要 edm/dubstep，来点安静但有推动力的");

  assert.equal(intent.type, "music_direction_request");
  assert.ok(intent.negativeConstraints.includes("emo"));
  assert.ok(intent.negativeConstraints.includes("EDM"));
  assert.ok(intent.negativeConstraints.includes("dubstep"));
  assert.equal(intent.positiveSeeds.some((seed) => /emo/i.test(seed)), false);
  assert.ok(intent.positiveSeeds.some((seed) => /专注|安静|推动力/.test(seed)));
});

test("explanation question does not become a music request", () => {
  const router = new IntentRouter();
  const intent = router.classify("你为什么给我放这首？");

  assert.equal(intent.type, "explanation_question");
  assert.equal(intent.shouldReplan, false);
  assert.equal(intent.shouldClearQueue, false);
});

test("correction clears incompatible queued tracks", () => {
  const router = new IntentRouter();
  const intent = router.classify("不是这种，太电了；我要没有人声的安静专注背景，像工作流，不要 emo，不要 edm");

  assert.equal(intent.type, "correction");
  assert.equal(intent.shouldReplan, true);
  assert.equal(intent.shouldClearQueue, true);
  assert.ok(intent.negativeConstraints.includes("人声"));
  assert.ok(intent.negativeConstraints.includes("emo"));
  assert.ok(intent.negativeConstraints.includes("EDM"));
  assert.ok(intent.positiveSeeds.includes("安静专注工作流"));
});

test("specific track requests remain specific requests", () => {
  const router = new IntentRouter();
  const intent = router.classify("放 Nils Frahm Says");

  assert.equal(intent.type, "specific_track_request");
  assert.equal(intent.shouldReplan, true);
  assert.equal(intent.query, "Nils Frahm Says");
});

test("specific track titles with accidental r b letters remain specific requests", () => {
  const router = new IntentRouter();
  const cases = [
    { text: "放 Mr Brightside", query: "Mr Brightside" },
    { text: "放 Starboy", query: "Starboy" },
    { text: "放 Jazzman", query: "Jazzman" },
    { text: "放 Ambient 1 Music for Airports", query: "Ambient 1 Music for Airports" },
    { text: "放 年轻的朋友来相会", query: "年轻的朋友来相会" },
    { text: "放 工作细胞", query: "工作细胞" },
    { text: "放 深夜食堂", query: "深夜食堂" },
    { text: "放 轻松熊", query: "轻松熊" },
  ];

  for (const { text, query } of cases) {
    const intent = router.classify(text);

    assert.equal(intent.type, "specific_track_request", text);
    assert.equal(intent.query, query, text);
  }
});

test("play verb plus broad scene/style remains a music direction", () => {
  const router = new IntentRouter();
  const cases = [
    "放点深夜听的rnb",
    "播放一点晚上听的 r&b",
    "想听适合深夜的R&B",
    "放点安静但有推动力的电子",
  ];

  for (const text of cases) {
    const intent = router.classify(text);
    assert.equal(intent.type, "music_direction_request", text);
    assert.equal(intent.shouldReplan, true, text);
    assert.equal(intent.shouldClearQueue, true, text);
  }
});

test("negated-only terms do not become fallback positive seeds", () => {
  const router = new IntentRouter();
  const cases = [
    { text: "不要 emo", constraint: "emo", leaked: /emo/i },
    { text: "不要 edm", constraint: "EDM", leaked: /edm/i },
    { text: "不要 dubstep", constraint: "dubstep", leaked: /dubstep/i },
    { text: "不要中文", constraint: "中文歌", leaked: /中文/ },
    { text: "不要高能量", constraint: "高能量", leaked: /高能量/ },
  ];

  for (const item of cases) {
    const intent = router.classify(item.text);

    assert.ok(intent.negativeConstraints.includes(item.constraint), item.text);
    assert.equal(intent.positiveSeeds.some((seed) => item.leaked.test(seed)), false, item.text);
  }
});

test("bare high energy request is not a negative constraint", () => {
  const router = new IntentRouter();
  const intent = router.classify("来点高能");

  assert.equal(intent.type, "music_direction_request");
  assert.equal(intent.negativeConstraints.includes("高能量"), false);
  assert.ok(intent.positiveSeeds.some((seed) => /高能/.test(seed)));
});

test("negation allows bounded filler before style terms", () => {
  const router = new IntentRouter();
  const cases = [
    { text: "别放 emo", constraint: "emo", leaked: /emo/i },
    { text: "不要放 edm", constraint: "EDM", leaked: /edm|放 edm/i },
    { text: "不要再来中文歌", constraint: "中文歌", leaked: /中文|中文歌|再来中文歌/ },
  ];

  for (const item of cases) {
    const intent = router.classify(item.text);

    assert.ok(intent.negativeConstraints.includes(item.constraint), item.text);
    assert.equal(intent.positiveSeeds.some((seed) => item.leaked.test(seed)), false, item.text);
  }
});

test("specific track commands do not require whitespace after Chinese verbs", () => {
  const router = new IntentRouter();
  const cases = ["放Nils Frahm Says", "播放Nils Frahm Says", "想听Nils Frahm Says", "点一首Nils Frahm Says"];

  for (const text of cases) {
    const intent = router.classify(text);

    assert.equal(intent.type, "specific_track_request", text);
    assert.equal(intent.query, "Nils Frahm Says", text);
  }
});

test("broad direction guard still prevents direct-track classification", () => {
  const router = new IntentRouter();
  const intent = router.classify("想听适合写代码的");

  assert.equal(intent.type, "music_direction_request");
});
