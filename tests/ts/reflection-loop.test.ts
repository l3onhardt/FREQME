import assert from "node:assert/strict";
import test from "node:test";

import { ReflectionLoop } from "../../src/radio/reflectionLoop.js";

test("skip creates session evidence without permanent dislike", () => {
  const loop = new ReflectionLoop();
  const memory = loop.record({
    existing: {},
    event: "skip",
    track: {
      id: "1",
      name: "Loud Song",
      artist: "Club Artist",
      selectionReason: { type: "ai_radio_episode", text: "high energy", episodeId: "e1" },
    },
    constraints: ["EDM"],
  });

  assert.deepEqual(memory.currentConstraints, ["EDM"]);
  assert.deepEqual(memory.temporaryRejectedTrackIds, ["1"]);
  assert.equal(memory.longTermCandidates.length, 0);
});

test("repeated explicit preference can create long term candidate", () => {
  const loop = new ReflectionLoop();
  const first = loop.record({
    existing: {},
    event: "preference_update",
    rawText: "我其实不太喜欢中文口水歌",
    constraints: ["中文歌", "口水歌"],
  });
  const second = loop.record({
    existing: first,
    event: "preference_update",
    rawText: "以后少放中文口水歌",
    constraints: ["中文歌", "口水歌"],
  });

  assert.ok(second.longTermCandidates.some((item) => /中文歌|口水歌/.test(item)));
});

test("repeated skip of the same track does not duplicate temporary rejection", () => {
  const loop = new ReflectionLoop();
  const first = loop.record({
    existing: {},
    event: "skip",
    track: { id: "same-track", name: "Again", artist: "Repeat Artist" },
  });
  const second = loop.record({
    existing: first,
    event: "skip",
    track: { id: "same-track", name: "Again", artist: "Repeat Artist" },
  });

  assert.deepEqual(second.temporaryRejectedTrackIds, ["same-track"]);
});

test("correction and negative feedback increment correction count and dedupe constraints", () => {
  const loop = new ReflectionLoop();
  const corrected = loop.record({
    existing: { currentConstraints: ["jazz"] },
    event: "correction",
    constraints: ["jazz", "piano"],
  });
  const negative = loop.record({
    existing: corrected,
    event: "negative_feedback",
    constraints: ["piano", "late night"],
  });

  assert.equal(negative.correctionCount, 2);
  assert.deepEqual(negative.currentConstraints, ["jazz", "piano", "late night"]);
});

test("non-preference events do not create long term candidates even when constraints repeat", () => {
  const loop = new ReflectionLoop();
  const first = loop.record({ existing: {}, event: "played", constraints: ["ambient"] });
  const second = loop.record({ existing: first, event: "skip", constraints: ["ambient"] });
  const third = loop.record({ existing: second, event: "negative_feedback", constraints: ["ambient"] });

  assert.deepEqual(third.currentConstraints, ["ambient"]);
  assert.equal(third.longTermCandidates.length, 0);
});
