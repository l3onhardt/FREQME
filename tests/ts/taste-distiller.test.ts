import assert from "node:assert/strict";
import test from "node:test";

import { distillTasteFacts } from "../../src/radio-agent/tasteDistiller.js";

test("taste distiller turns repeated artists and playlist themes into facts", () => {
  const result = distillTasteFacts({
    uid: "42",
    libraryTracks: [
      { uid: "42", playlistId: "p1", songId: "1", songName: "A", artist: "SZA", album: "", source: {}, scannedAt: "" },
      { uid: "42", playlistId: "p1", songId: "2", songName: "B", artist: "SZA", album: "", source: {}, scannedAt: "" },
      { uid: "42", playlistId: "p2", songId: "3", songName: "C", artist: "Frank Ocean", album: "", source: {}, scannedAt: "" },
    ],
    playlists: [
      { uid: "42", playlistId: "p1", name: "late night rnb", raw: {}, scannedAt: "" },
      { uid: "42", playlistId: "p2", name: "soft night", raw: {}, scannedAt: "" },
    ],
    recentEvents: [],
  });

  assert.ok(result.facts.some((fact) => fact.key === "artist:SZA"));
  assert.ok(result.hypotheses.some((hypothesis) => /late night/i.test(hypothesis.value)));
});

test("taste distiller turns repeated completed listening into a session taste hypothesis", () => {
  const result = distillTasteFacts({
    uid: "42",
    libraryTracks: [],
    playlists: [],
    recentEvents: [
      {
        id: 10,
        uid: "42",
        sessionId: 7,
        type: "track_completed",
        priority: "warm",
        payload: { track: { id: "anyma-1", name: "Pictures Of You", artist: "Anyma" } },
        createdAt: "2026-06-03T01:00:00.000Z",
      },
      {
        id: 11,
        uid: "42",
        sessionId: 7,
        type: "track_completed",
        priority: "warm",
        payload: { currentTrack: { id: "anyma-2", name: "Eternity", artist: "Anyma" } },
        createdAt: "2026-06-03T01:05:00.000Z",
      },
      {
        id: 12,
        uid: "42",
        sessionId: 7,
        type: "playback_started",
        priority: "warm",
        payload: { track: { id: "s1", name: "Started Only", artist: "SZA" } },
        createdAt: "2026-06-03T01:07:00.000Z",
      },
    ],
  });

  const hypothesis = result.hypotheses.find((item) => item.key === "session_artist:Anyma");
  assert.ok(hypothesis);
  assert.equal(hypothesis?.evidenceCount, 2);
  assert.match(hypothesis?.value || "", /Anyma/);
  assert.equal(result.hypotheses.some((item) => item.key === "session_artist:SZA"), false);
});

test("taste distiller treats one skip as session evidence only", () => {
  const result = distillTasteFacts({
    uid: "42",
    libraryTracks: [],
    playlists: [],
    recentEvents: [
      {
        uid: "42",
        sessionId: 7,
        type: "track_skipped",
        priority: "hot",
        payload: { track: { id: "bad-1", name: "Too Much", artist: "A" } },
        createdAt: "2026-06-03T01:02:03.000Z",
      },
    ],
  });

  assert.equal(result.facts.some((fact) => /bad-1/.test(fact.key)), false);
  assert.ok(result.sessionEvidence.some((item) => item.key === "skip:bad-1"));
});

test("taste distiller gives explicit preference corrections higher confidence", () => {
  const result = distillTasteFacts({
    uid: "42",
    libraryTracks: [],
    playlists: [],
    recentEvents: [
      {
        uid: "42",
        sessionId: 7,
        type: "user_text",
        priority: "hot",
        payload: { text: "不要古典，想听更晚上的 R&B" },
        createdAt: "2026-06-03T01:02:03.000Z",
      },
    ],
  });

  const correction = result.sessionEvidence.find((item) => item.key === "explicit:user_text");
  assert.ok(correction);
  assert.ok((correction?.confidence || 0) > 0.7);
  assert.match(correction?.value || "", /不要古典/);
});
