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
