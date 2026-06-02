import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { AppDatabase } from "../../src/storage/database.js";
import { RadioAgentStore } from "../../src/storage/radioAgentStore.js";

function tempStore(): { db: AppDatabase; store: RadioAgentStore } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "freqme-agent-"));
  const db = new AppDatabase(path.join(dir, "test.db"));
  return { db, store: new RadioAgentStore(db) };
}

test("radio agent store persists events by uid and session", () => {
  const { store } = tempStore();

  const id = store.appendEvent({
    uid: "42",
    sessionId: 7,
    type: "login_completed",
    priority: "hot",
    payload: { nickname: "Katz" },
    createdAt: "2026-06-03T01:02:03.000Z",
  });

  assert.ok(id > 0);
  const recent = store.recentEvents("42", 7, 5);
  assert.equal(recent[0]?.type, "login_completed");
  assert.deepEqual(recent[0]?.payload, { nickname: "Katz" });
});

test("radio agent memory preserves confidence and evidence refs", () => {
  const { store } = tempStore();

  store.upsertMemory({
    uid: "42",
    key: "style:late-night-rnb",
    kind: "taste_fact",
    value: "Listener repeatedly returns to late-night R&B.",
    confidence: 0.82,
    evidenceCount: 3,
    evidenceRefs: ["track:1", "playlist:2"],
    updatedAt: "2026-06-03T01:02:03.000Z",
  });

  const memories = store.memories("42", "taste_fact", 10);
  assert.equal(memories[0]?.evidenceCount, 3);
  assert.deepEqual(memories[0]?.evidenceRefs, ["track:1", "playlist:2"]);
});

test("radio agent store persists library playlists and tracks", () => {
  const { store } = tempStore();

  store.savePlaylist("42", {
    uid: "42",
    playlistId: "p1",
    name: "late night rnb",
    raw: { id: "p1", subscribed: true },
    scannedAt: "2026-06-03T01:02:03.000Z",
  });
  store.savePlaylistTracks("42", "p1", [
    {
      uid: "42",
      playlistId: "p1",
      songId: "s1",
      songName: "Warm Static",
      artist: "Katz",
      album: "After Hours",
      source: { id: "s1" },
      scannedAt: "2026-06-03T01:02:03.000Z",
    },
  ]);

  const playlists = store.playlists("42", 10);
  const tracks = store.libraryTracks("42", 10);
  assert.equal(playlists[0]?.name, "late night rnb");
  assert.deepEqual(playlists[0]?.raw, { id: "p1", subscribed: true });
  assert.equal(tracks[0]?.songId, "s1");
  assert.deepEqual(tracks[0]?.source, { id: "s1" });
});

test("radio agent artifacts and shadow decisions round trip", () => {
  const { store } = tempStore();

  store.saveArtifact("42", "user_profile.md", "# User\n", "v1");
  store.saveShadowDecision({
    id: "decision-1",
    uid: "42",
    sessionId: 7,
    decisionType: "host",
    payload: { event: "silent", reason: "ordinary continuation" },
    createdAt: "2026-06-03T01:02:03.000Z",
  });

  const artifact = store.artifact("42", "user_profile.md");
  const decisions = store.latestShadowDecisions("42", 7, 5);
  assert.equal(artifact?.content, "# User\n");
  assert.equal(artifact?.sourceVersion, "v1");
  assert.equal(decisions[0]?.decisionType, "host");
  assert.deepEqual(decisions[0]?.payload, { event: "silent", reason: "ordinary continuation" });
});
