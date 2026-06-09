import assert from "node:assert/strict";
import test from "node:test";

import { distillTasteFacts } from "../../src/radio-agent/tasteDistiller.js";

test("taste distiller promotes explicit positive repeats into durable artist facts", () => {
  const result = distillTasteFacts({
    uid: "42",
    libraryTracks: [],
    playlists: [],
    recentEvents: [
      {
        id: 20,
        uid: "42",
        sessionId: 7,
        type: "user_text",
        priority: "hot",
        payload: { text: "more Frank Ocean tonight, less classical" },
        createdAt: "2026-06-03T01:00:00.000Z",
      },
      {
        id: 21,
        uid: "42",
        sessionId: 7,
        type: "track_completed",
        priority: "warm",
        payload: { track: { id: "frank-1", name: "Nights", artist: "Frank Ocean" } },
        createdAt: "2026-06-03T01:05:00.000Z",
      },
      {
        id: 22,
        uid: "42",
        sessionId: 7,
        type: "track_completed",
        priority: "warm",
        payload: { track: { id: "frank-2", name: "Pink + White", artist: "Frank Ocean" } },
        createdAt: "2026-06-03T01:10:00.000Z",
      },
      {
        id: 23,
        uid: "42",
        sessionId: 7,
        type: "track_skipped",
        priority: "hot",
        payload: { track: { id: "classic-1", name: "Sonata", artist: "Classical Artist" } },
        createdAt: "2026-06-03T01:12:00.000Z",
      },
    ],
  });

  const durable = result.facts.find((item) => item.key === "artist:Frank Ocean");
  assert.ok(durable);
  assert.equal(durable?.kind, "taste_fact");
  assert.ok((durable?.confidence || 0) >= 0.8);
  assert.ok((durable?.evidenceCount || 0) >= 3);
  assert.equal(result.facts.some((item) => /classical/i.test(`${item.key} ${item.value}`)), false);
  assert.ok(result.sessionEvidence.some((item) => item.key === "skip:classic-1"));
});

test("taste distiller combines existing session memory with new confirmation before durable promotion", () => {
  const result = distillTasteFacts({
    uid: "42",
    libraryTracks: [],
    playlists: [],
    existingMemories: [
      {
        uid: "42",
        key: "session_artist:Frank Ocean",
        kind: "taste_hypothesis",
        value: "Recent completed listening repeatedly returned to Frank Ocean.",
        confidence: 0.72,
        evidenceCount: 2,
        evidenceRefs: ["event:10", "event:11"],
        updatedAt: "2026-06-02T23:00:00.000Z",
      },
    ],
    recentEvents: [
      {
        id: 24,
        uid: "42",
        sessionId: 8,
        type: "user_text",
        priority: "hot",
        payload: { text: "play more Frank Ocean" },
        createdAt: "2026-06-03T02:00:00.000Z",
      },
      {
        id: 25,
        uid: "42",
        sessionId: 8,
        type: "track_completed",
        priority: "warm",
        payload: { track: { id: "frank-3", name: "Ivy", artist: "Frank Ocean" } },
        createdAt: "2026-06-03T02:05:00.000Z",
      },
    ],
  });

  const durable = result.facts.find((item) => item.key === "artist:Frank Ocean");
  assert.ok(durable);
  assert.ok((durable?.evidenceRefs || []).includes("event:10"));
  assert.ok((durable?.evidenceRefs || []).includes("event:25"));
});

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
