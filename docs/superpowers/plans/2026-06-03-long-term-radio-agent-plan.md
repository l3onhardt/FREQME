# Long-Term Radio Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the first shadow-mode version of the FREQME long-term radio agent: instant first playback, background library ingestion, durable taste/context memory, explainable traces, and restart-safe agent state without replacing legacy playback yet.

**Architecture:** Add a new `src/radio-agent/` service boundary above the existing player stack. The first implementation keeps the legacy `RadioBrain`, queue, NetEase service, audio resolver, and TTS as tools/adapters while the new agent observes events, builds memory artifacts, and emits shadow decisions.

**Tech Stack:** TypeScript, Node test runner, SQLite through `node:sqlite`, existing `NeteaseService`, `MemoryStore`, `AppDatabase`, `Track`, `TasteProfile`, and WebSocket server wiring.

---

## Scope

This plan implements Phase 1 from `docs/superpowers/specs/2026-06-03-long-term-radio-agent-design.md`: shadow-mode long-term agent MVP.

It does not:

- replace the legacy `RadioBrain`
- directly control the live playback queue except through the existing first-track/opening fallback path where explicitly wired
- add a full visual diagnostics dashboard
- add external metadata providers
- run multi-agent orchestration

It does:

- persist raw radio-agent evidence
- model radio events as typed messages
- choose a fast opening track from reliable existing sources
- scan all user playlists in the background
- distill local taste facts without waiting for LLM calls
- generate agent-readable markdown artifacts from structured memory
- record host silence as a decision
- run the new runtime in shadow mode beside legacy playback
- expose minimal HTTP diagnostics for development and future UI wiring

## File Structure

Create:

- `src/radio-agent/types.ts`
  - Shared domain types for agent events, sessions, library snapshots, taste facts, markdown artifacts, host decisions, and shadow decisions.
- `src/storage/radioAgentStore.ts`
  - Persistence wrapper for new radio-agent tables. Keeps radio-agent storage separate from existing `MemoryStore`.
- `src/radio-agent/openingTrack.ts`
  - Fast opening-track selector. Uses recent playable tracks, profile anchors, liked tracks, and fallback candidates.
- `src/radio-agent/libraryCensus.ts`
  - Background full-library scan coordinator. Fetches playlists and playlist details through `NeteaseService`, normalizes them into raw evidence rows.
- `src/radio-agent/tasteDistiller.ts`
  - Deterministic first-pass taste distiller. Produces facts and hypotheses from raw library evidence and FREQME playback events.
- `src/radio-agent/contextArtifacts.ts`
  - Builds `user_profile.md`, `station_now.md`, and `program_contract.md` strings from structured data.
- `src/radio-agent/hostPolicy.ts`
  - Decides speak/silent shadow host decisions from event, context, and recent speech density.
- `src/radio-agent/radioAgentRuntime.ts`
  - Shadow-mode orchestrator. Accepts typed events, persists them, triggers background work, writes shadow decisions, and exposes status.

Modify:

- `src/storage/database.ts`
  - Add radio-agent tables and indexes.
- `src/server.ts`
  - Instantiate `RadioAgentStore` and `RadioAgentRuntime`.
  - Send login/session/playback/user/skip events into shadow runtime.
  - Add minimal diagnostics endpoint.
- `src/services/neteaseService.ts`
  - Add optional pagination support to `userPlaylist(uid, options)` if needed for full playlist scans.
- `src/types.ts`
  - Only add shared types if they must be consumed outside `src/radio-agent/`; prefer keeping new types inside `src/radio-agent/types.ts`.

Create tests:

- `tests/ts/radio-agent-store.test.ts`
- `tests/ts/radio-agent-events.test.ts`
- `tests/ts/opening-track.test.ts`
- `tests/ts/library-census.test.ts`
- `tests/ts/taste-distiller.test.ts`
- `tests/ts/context-artifacts.test.ts`
- `tests/ts/host-policy.test.ts`
- `tests/ts/radio-agent-runtime.test.ts`
- `tests/ts/radio-agent-server-wiring.test.ts`

## Task 1: Radio Agent Storage Schema

**Files:**
- Modify: `src/storage/database.ts`
- Create: `src/storage/radioAgentStore.ts`
- Test: `tests/ts/radio-agent-store.test.ts`

- [ ] **Step 1: Write failing schema tests**

Add tests that create a temp `AppDatabase`, construct `RadioAgentStore`, and verify:

```ts
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { AppDatabase } from "../../src/storage/database.js";
import { RadioAgentStore } from "../../src/storage/radioAgentStore.js";

test("radio agent store persists events by uid and session", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "freqme-agent-"));
  const db = new AppDatabase(path.join(dir, "test.db"));
  const store = new RadioAgentStore(db);

  const id = store.appendEvent({
    uid: "42",
    sessionId: 7,
    type: "login_completed",
    priority: "hot",
    payload: { nickname: "Katz" },
    createdAt: "2026-06-03T01:02:03.000Z",
  });

  assert.ok(id > 0);
  assert.equal(store.recentEvents("42", 7, 5)[0]?.type, "login_completed");
});

test("radio agent memory preserves confidence and evidence refs", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "freqme-agent-"));
  const db = new AppDatabase(path.join(dir, "test.db"));
  const store = new RadioAgentStore(db);

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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run build:test && node --test dist/tests/ts/radio-agent-store.test.js`

Expected: FAIL because `RadioAgentStore` and schema do not exist.

- [ ] **Step 3: Add database tables**

In `src/storage/database.ts`, add tables:

```sql
CREATE TABLE IF NOT EXISTS radio_agent_event (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uid TEXT,
  session_id INTEGER,
  event_type TEXT NOT NULL,
  priority TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS radio_agent_memory (
  uid TEXT NOT NULL,
  memory_key TEXT NOT NULL,
  kind TEXT NOT NULL,
  value_text TEXT NOT NULL,
  confidence REAL DEFAULT 0.5,
  evidence_count INTEGER DEFAULT 1,
  evidence_refs_json TEXT NOT NULL,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(uid, memory_key)
);

CREATE TABLE IF NOT EXISTS radio_library_playlist (
  uid TEXT NOT NULL,
  playlist_id TEXT NOT NULL,
  name TEXT NOT NULL,
  raw_json TEXT NOT NULL,
  scanned_at TEXT DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(uid, playlist_id)
);

CREATE TABLE IF NOT EXISTS radio_library_track (
  uid TEXT NOT NULL,
  playlist_id TEXT NOT NULL,
  song_id TEXT NOT NULL,
  song_name TEXT NOT NULL,
  artist TEXT,
  album TEXT,
  source_json TEXT NOT NULL,
  scanned_at TEXT DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(uid, playlist_id, song_id)
);

CREATE TABLE IF NOT EXISTS radio_agent_artifact (
  uid TEXT NOT NULL,
  artifact_key TEXT NOT NULL,
  content TEXT NOT NULL,
  source_version TEXT NOT NULL,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(uid, artifact_key)
);

CREATE TABLE IF NOT EXISTS radio_agent_shadow_decision (
  id TEXT PRIMARY KEY,
  uid TEXT,
  session_id INTEGER,
  decision_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
```

Add indexes:

```sql
CREATE INDEX IF NOT EXISTS idx_radio_agent_event_uid_session ON radio_agent_event(uid, session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_radio_library_track_uid_song ON radio_library_track(uid, song_id);
CREATE INDEX IF NOT EXISTS idx_radio_agent_shadow_uid_session ON radio_agent_shadow_decision(uid, session_id, created_at);
```

- [ ] **Step 4: Implement `RadioAgentStore`**

Implement methods:

```ts
appendEvent(event): number
recentEvents(uid, sessionId, limit): RadioAgentEvent[]
upsertMemory(memory): void
memories(uid, kind, limit): RadioAgentMemory[]
savePlaylist(uid, playlist): void
savePlaylistTracks(uid, playlistId, tracks): void
libraryTracks(uid, limit): RadioLibraryTrack[]
saveArtifact(uid, artifactKey, content, sourceVersion): void
artifact(uid, artifactKey): RadioArtifact | null
saveShadowDecision(decision): void
latestShadowDecisions(uid, sessionId, limit): RadioShadowDecision[]
```

Use local `json()` and `parse()` helpers copied from `MemoryStore` style.

- [ ] **Step 5: Run store tests**

Run: `npm run build:test && node --test dist/tests/ts/radio-agent-store.test.js`

Expected: PASS.

- [ ] **Step 6: Run full tests**

Run: `npm test`

Expected: `208+` tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/storage/database.ts src/storage/radioAgentStore.ts tests/ts/radio-agent-store.test.ts
git commit -m "Add radio agent storage"
```

## Task 2: Radio Agent Event Types and Priority Routing

**Files:**
- Create: `src/radio-agent/types.ts`
- Test: `tests/ts/radio-agent-events.test.ts`

- [ ] **Step 1: Write failing event normalization tests**

Create tests for event shape and priority:

```ts
import assert from "node:assert/strict";
import test from "node:test";

import { normalizeRadioAgentEvent } from "../../src/radio-agent/types.js";

test("login and user text are hot radio agent events", () => {
  assert.equal(normalizeRadioAgentEvent({ type: "login_completed", uid: "42" }).priority, "hot");
  assert.equal(normalizeRadioAgentEvent({ type: "user_text", uid: "42", text: "why this song?" }).priority, "hot");
});

test("library scan and idle ticks are cold events", () => {
  assert.equal(normalizeRadioAgentEvent({ type: "library_scan_requested", uid: "42" }).priority, "cold");
  assert.equal(normalizeRadioAgentEvent({ type: "idle_tick", uid: "42" }).priority, "cold");
});

test("queue low and track completed are warm events", () => {
  assert.equal(normalizeRadioAgentEvent({ type: "queue_low", uid: "42" }).priority, "warm");
  assert.equal(normalizeRadioAgentEvent({ type: "track_completed", uid: "42", track: { id: "1", name: "A", artist: "B" } }).priority, "warm");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run build:test && node --test dist/tests/ts/radio-agent-events.test.js`

Expected: FAIL because `types.ts` does not exist.

- [ ] **Step 3: Implement event and memory types**

In `src/radio-agent/types.ts`, define:

```ts
export type RadioAgentPriority = "hot" | "warm" | "cold";
export type RadioAgentMode = "shadow" | "assisted" | "active";

export type RadioAgentEventType =
  | "login_completed"
  | "session_restored"
  | "library_scan_requested"
  | "playback_started"
  | "playback_progress"
  | "track_completed"
  | "track_skipped"
  | "queue_low"
  | "user_text"
  | "tts_completed"
  | "idle_tick"
  | "weather_updated"
  | "location_updated";

export interface RadioAgentEvent {
  id?: number;
  uid: string | null;
  sessionId?: number | null;
  type: RadioAgentEventType;
  priority: RadioAgentPriority;
  payload: Record<string, unknown>;
  createdAt: string;
}
```

Also define:

- `RadioAgentMemory`
- `RadioLibraryPlaylist`
- `RadioLibraryTrack`
- `RadioProfileArtifact`
- `RadioHostDecision`
- `RadioShadowDecision`
- `RadioAgentStatus`

Implement:

```ts
export function normalizeRadioAgentEvent(input: Record<string, unknown>): RadioAgentEvent
```

Priority mapping:

```ts
hot: login_completed, session_restored, user_text, track_skipped
warm: playback_started, track_completed, queue_low, tts_completed, weather_updated, location_updated
cold: library_scan_requested, playback_progress, idle_tick
```

- [ ] **Step 4: Run event tests**

Run: `npm run build:test && node --test dist/tests/ts/radio-agent-events.test.js`

Expected: PASS.

- [ ] **Step 5: Run full tests**

Run: `npm test`

Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/radio-agent/types.ts tests/ts/radio-agent-events.test.ts
git commit -m "Define radio agent events"
```

## Task 3: Fast Opening Track Selector

**Files:**
- Create: `src/radio-agent/openingTrack.ts`
- Test: `tests/ts/opening-track.test.ts`

- [ ] **Step 1: Write failing opening-track tests**

Test priority order:

```ts
import assert from "node:assert/strict";
import test from "node:test";

import { chooseOpeningTrack } from "../../src/radio-agent/openingTrack.js";

test("opening selector prefers recent playable tracks", () => {
  const result = chooseOpeningTrack({
    recentPlayableTracks: [{ id: "recent-1", name: "Recent", artist: "A" }],
    profileAnchorTracks: [{ id: "anchor-1", name: "Anchor", artist: "B" }],
    likedTracks: [],
    fallbackTracks: [],
    avoidTrackIds: new Set(),
  });

  assert.equal(result?.track.id, "recent-1");
  assert.equal(result?.reason.type, "radio_agent_opening_recent");
});

test("opening selector skips avoided tracks and falls back to anchors", () => {
  const result = chooseOpeningTrack({
    recentPlayableTracks: [{ id: "bad", name: "Bad", artist: "A" }],
    profileAnchorTracks: [{ id: "anchor-1", name: "Anchor", artist: "B" }],
    likedTracks: [],
    fallbackTracks: [],
    avoidTrackIds: new Set(["bad"]),
  });

  assert.equal(result?.track.id, "anchor-1");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run build:test && node --test dist/tests/ts/opening-track.test.js`

Expected: FAIL because `openingTrack.ts` does not exist.

- [ ] **Step 3: Implement selector**

Implement:

```ts
export interface OpeningTrackArgs {
  recentPlayableTracks: Track[];
  profileAnchorTracks: Track[];
  likedTracks: Track[];
  fallbackTracks: Track[];
  avoidTrackIds: Set<string>;
}

export function chooseOpeningTrack(args: OpeningTrackArgs): OpeningTrackPick | null
```

Priority:

1. recent playable
2. profile anchor
3. liked
4. fallback

Reject empty ids, avoided ids, duplicate ids, and tracks with blank names.

- [ ] **Step 4: Run opening tests**

Run: `npm run build:test && node --test dist/tests/ts/opening-track.test.js`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/radio-agent/openingTrack.ts tests/ts/opening-track.test.ts
git commit -m "Add radio agent opening track selector"
```

## Task 4: Full Library Census Worker

**Files:**
- Create: `src/radio-agent/libraryCensus.ts`
- Modify: `src/services/neteaseService.ts`
- Test: `tests/ts/library-census.test.ts`

- [ ] **Step 1: Write failing library census tests**

Use a fake NetEase client:

```ts
import assert from "node:assert/strict";
import test from "node:test";

import { LibraryCensus } from "../../src/radio-agent/libraryCensus.js";

test("library census scans every playlist and stores normalized tracks", async () => {
  const calls: string[] = [];
  const netease = {
    userPlaylist: async () => [
      { id: 1, name: "Night" },
      { id: 2, name: "Work" },
    ],
    playlistDetail: async (id: string | number) => {
      calls.push(String(id));
      return {
        playlist: {
          id,
          name: `P${id}`,
          tracks: [{ id: `song-${id}`, name: `Song ${id}`, ar: [{ name: "Artist" }], al: { name: "Album" } }],
        },
      };
    },
    normalizeTrack: (song: Record<string, unknown>, source = "") => ({
      id: String(song.id || ""),
      name: String(song.name || ""),
      artist: "Artist",
      album: "Album",
      source,
      raw: song,
    }),
  };
  const saved: Array<{ playlistId: string; count: number }> = [];
  const store = {
    savePlaylist: () => undefined,
    savePlaylistTracks: (_uid: string, playlistId: string, tracks: unknown[]) => saved.push({ playlistId, count: tracks.length }),
  };

  const census = new LibraryCensus(netease, store);
  const result = await census.scan("42");

  assert.deepEqual(calls, ["1", "2"]);
  assert.deepEqual(saved, [{ playlistId: "1", count: 1 }, { playlistId: "2", count: 1 }]);
  assert.equal(result.playlistsScanned, 2);
  assert.equal(result.tracksScanned, 2);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build:test && node --test dist/tests/ts/library-census.test.js`

Expected: FAIL because `LibraryCensus` does not exist.

- [ ] **Step 3: Implement library census**

`LibraryCensus.scan(uid)` should:

- call `netease.userPlaylist(uid)`
- iterate all returned playlists
- call `netease.playlistDetail(id)` for each playlist
- normalize tracks through `netease.normalizeTrack`
- save playlist metadata
- save playlist tracks
- return counts and failures
- continue scanning if one playlist fails

Keep concurrency conservative in first version: sequential or max 2 in flight. Avoid flooding NetEase.

- [ ] **Step 4: Add optional pagination support if needed**

If `NeteaseService.userPlaylist(uid)` only returns the first page, modify it to accept:

```ts
async userPlaylist(uid: string, options: { limit?: number; offset?: number } = {}): Promise<Record<string, unknown>[]>
```

Keep existing calls working.

- [ ] **Step 5: Run library census tests**

Run: `npm run build:test && node --test dist/tests/ts/library-census.test.js`

Expected: PASS.

- [ ] **Step 6: Run NetEase-related tests**

Run: `npm run build:test && node --test dist/tests/ts/netease-service.test.js netease-bridge/*.test.mjs`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/radio-agent/libraryCensus.ts src/services/neteaseService.ts tests/ts/library-census.test.ts
git commit -m "Add radio agent library census"
```

## Task 5: Deterministic Taste Distiller

**Files:**
- Create: `src/radio-agent/tasteDistiller.ts`
- Test: `tests/ts/taste-distiller.test.ts`

- [ ] **Step 1: Write failing distillation tests**

Test that it creates facts without using LLM:

```ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run build:test && node --test dist/tests/ts/taste-distiller.test.js`

Expected: FAIL because `tasteDistiller.ts` does not exist.

- [ ] **Step 3: Implement local distiller**

Implement:

```ts
export function distillTasteFacts(args: TasteDistillationArgs): TasteDistillationResult
```

The first pass should detect:

- top artists
- repeated playlist title tokens
- likely language hints when track language exists
- repeated albums if available
- skipped track ids from recent events
- explicit user preference/correction events

Fact vs hypothesis rules:

- repeated count >= 2 for same artist: fact
- playlist title theme: hypothesis unless supported by repeated artists/tracks
- one skip: session hypothesis only, not long-term fact
- explicit correction event: high-importance session evidence

- [ ] **Step 4: Run distiller tests**

Run: `npm run build:test && node --test dist/tests/ts/taste-distiller.test.js`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/radio-agent/tasteDistiller.ts tests/ts/taste-distiller.test.ts
git commit -m "Add deterministic radio taste distiller"
```

## Task 6: Markdown Context Artifacts

**Files:**
- Create: `src/radio-agent/contextArtifacts.ts`
- Test: `tests/ts/context-artifacts.test.ts`

- [ ] **Step 1: Write failing artifact tests**

Test `user_profile.md`, `station_now.md`, and `program_contract.md` generation:

```ts
import assert from "node:assert/strict";
import test from "node:test";

import { buildUserProfileMarkdown, buildStationNowMarkdown, buildProgramContractMarkdown } from "../../src/radio-agent/contextArtifacts.js";

test("user profile markdown separates facts from hypotheses", () => {
  const markdown = buildUserProfileMarkdown({
    uid: "42",
    facts: [{ key: "artist:SZA", value: "Frequent SZA evidence.", confidence: 0.8, evidenceCount: 3 }],
    hypotheses: [{ key: "scene:night", value: "May prefer lower energy at night.", confidence: 0.55, evidenceCount: 1 }],
    updatedAt: "2026-06-03T00:00:00.000Z",
  });

  assert.match(markdown, /## Stable Taste Facts/);
  assert.match(markdown, /Frequent SZA evidence/);
  assert.match(markdown, /## Hypotheses/);
});

test("station now markdown includes uncertainty", () => {
  const markdown = buildStationNowMarkdown({
    localTimeBlock: "late_night",
    timezoneName: "Asia/Hong_Kong",
    currentTrack: { id: "1", name: "A", artist: "B" },
    recentTracks: [],
    listenerStateHypothesis: "low interruption likely",
    confidence: "medium",
  });

  assert.match(markdown, /low interruption likely/);
  assert.match(markdown, /confidence: medium/i);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run build:test && node --test dist/tests/ts/context-artifacts.test.js`

Expected: FAIL because artifact builders do not exist.

- [ ] **Step 3: Implement markdown builders**

Implement pure functions:

- `buildUserProfileMarkdown(args)`
- `buildStationNowMarkdown(args)`
- `buildProgramContractMarkdown(args)`

Keep output concise, stable, and ASCII-friendly for test assertions. Do not include raw huge JSON.

- [ ] **Step 4: Run artifact tests**

Run: `npm run build:test && node --test dist/tests/ts/context-artifacts.test.js`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/radio-agent/contextArtifacts.ts tests/ts/context-artifacts.test.ts
git commit -m "Build radio agent context artifacts"
```

## Task 7: Host Policy With Explicit Silence

**Files:**
- Create: `src/radio-agent/hostPolicy.ts`
- Test: `tests/ts/host-policy.test.ts`

- [ ] **Step 1: Write failing host policy tests**

```ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run build:test && node --test dist/tests/ts/host-policy.test.js`

Expected: FAIL because `hostPolicy.ts` does not exist.

- [ ] **Step 3: Implement host policy**

Implement:

```ts
export function decideHostSpeech(args: HostPolicyArgs): RadioHostDecision
```

Rules:

- speak on `login_completed`, direct user text acknowledgement, bridge, return, correction, recovery, explanation
- stay silent for ordinary continuation when recent host lines exist
- stay silent when low-interruption is true unless event is hot
- include internal `reason`
- never include banned words in `text`

- [ ] **Step 4: Run host policy tests**

Run: `npm run build:test && node --test dist/tests/ts/host-policy.test.js`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/radio-agent/hostPolicy.ts tests/ts/host-policy.test.ts
git commit -m "Add explicit radio host speech policy"
```

## Task 8: Shadow Radio Agent Runtime

**Files:**
- Create: `src/radio-agent/radioAgentRuntime.ts`
- Test: `tests/ts/radio-agent-runtime.test.ts`

- [ ] **Step 1: Write failing runtime tests**

Test that runtime persists events and triggers cold work without controlling playback:

```ts
import assert from "node:assert/strict";
import test from "node:test";

import { RadioAgentRuntime } from "../../src/radio-agent/radioAgentRuntime.js";

test("shadow runtime persists login event and schedules library scan", async () => {
  const events: string[] = [];
  const store = {
    appendEvent: (event: any) => {
      events.push(event.type);
      return events.length;
    },
    saveShadowDecision: () => undefined,
    latestShadowDecisions: () => [],
  };
  const census = { scan: async () => ({ playlistsScanned: 0, tracksScanned: 0, failures: [] }) };

  const runtime = new RadioAgentRuntime({ mode: "shadow", store, census });
  const result = await runtime.handle({ type: "login_completed", uid: "42", sessionId: 1 });

  assert.equal(result.controlsPlayback, false);
  assert.deepEqual(events, ["login_completed", "library_scan_requested"]);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run build:test && node --test dist/tests/ts/radio-agent-runtime.test.js`

Expected: FAIL because `RadioAgentRuntime` does not exist.

- [ ] **Step 3: Implement runtime constructor and handle method**

Dependencies:

```ts
interface RadioAgentRuntimeDeps {
  mode: RadioAgentMode;
  store: Pick<
    RadioAgentStore,
    | "appendEvent"
    | "recentEvents"
    | "upsertMemory"
    | "memories"
    | "saveArtifact"
    | "artifact"
    | "saveShadowDecision"
    | "latestShadowDecisions"
  >;
  census?: Pick<LibraryCensus, "scan">;
  now?: () => string;
}
```

Implement:

```ts
handle(input: Record<string, unknown>): Promise<RadioAgentHandleResult>
status(uid, sessionId): RadioAgentStatus
```

Behavior:

- normalize input event
- persist event
- for `login_completed`, persist a follow-up `library_scan_requested` event and start scan in background
- for `track_skipped`, write session-level shadow memory/decision
- for host-worthy events, write host decision including silence when applicable
- always return `controlsPlayback: false` in shadow mode

- [ ] **Step 4: Ensure background work cannot break hot path**

Catch census failures and persist an event:

```ts
radio_agent_library_scan_failed
```

The `handle(login_completed)` call must resolve even if the background scan later fails.

- [ ] **Step 5: Run runtime tests**

Run: `npm run build:test && node --test dist/tests/ts/radio-agent-runtime.test.js`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/radio-agent/radioAgentRuntime.ts tests/ts/radio-agent-runtime.test.ts
git commit -m "Add shadow radio agent runtime"
```

## Task 9: Server Wiring and Minimal Diagnostics

**Files:**
- Modify: `src/server.ts`
- Test: `tests/ts/radio-agent-server-wiring.test.ts`

- [ ] **Step 1: Write failing wiring test**

Follow the pattern in `tests/ts/server-wiring.test.ts`: inspect `src/server.ts` as source text and assert it wires the new runtime.

```ts
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

test("server wires long-term radio agent in shadow mode", () => {
  const source = fs.readFileSync("src/server.ts", "utf8");

  assert.match(source, /RadioAgentRuntime/);
  assert.match(source, /RadioAgentStore/);
  assert.match(source, /mode:\s*"shadow"/);
  assert.match(source, /radioAgent\.handle/);
  assert.match(source, /\/api\/radio\/agent\/status/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build:test && node --test dist/tests/ts/radio-agent-server-wiring.test.js`

Expected: FAIL because server is not wired.

- [ ] **Step 3: Instantiate runtime in `src/server.ts`**

Add imports:

```ts
import { RadioAgentStore } from "./storage/radioAgentStore.js";
import { LibraryCensus } from "./radio-agent/libraryCensus.js";
import { RadioAgentRuntime } from "./radio-agent/radioAgentRuntime.js";
```

Instantiate:

```ts
const radioAgentStore = new RadioAgentStore(database);
const libraryCensus = new LibraryCensus(netease, radioAgentStore);
const radioAgent = new RadioAgentRuntime({
  mode: "shadow",
  store: radioAgentStore,
  census: libraryCensus,
});
```

- [ ] **Step 4: Send login/auth events**

On successful auth status or refresh where `activeUid` exists:

```ts
void radioAgent.handle({
  type: "login_completed",
  uid: activeUid,
  payload: { source: "auth_status" },
});
```

Make sure this is non-blocking and catches internally, or wrap:

```ts
void radioAgent.handle(...).catch((error) => store.logPlaybackEvent("radio_agent_error", { uid: activeUid, reason: String(error) }));
```

- [ ] **Step 5: Send playback and user events from WebSocket flow**

Inside `handleRadioSocket`, when existing code knows:

- session restored/created
- playback starts
- track skipped
- user text received
- queue low

Call `radioAgent.handle(...)` without changing legacy behavior.

- [ ] **Step 6: Add diagnostics endpoint**

Add:

```ts
GET /api/radio/agent/status?uid=<uid>&session_id=<id>
```

Return:

```ts
radioAgent.status(uid, sessionId)
```

Never expose cookies or API keys.

- [ ] **Step 7: Run wiring test**

Run: `npm run build:test && node --test dist/tests/ts/radio-agent-server-wiring.test.js`

Expected: PASS.

- [ ] **Step 8: Run full test suite**

Run: `npm test`

Expected: all tests pass.

- [ ] **Step 9: Commit**

```bash
git add src/server.ts tests/ts/radio-agent-server-wiring.test.ts
git commit -m "Wire shadow radio agent runtime"
```

## Task 10: Smoke Checklist Update

**Files:**
- Create: `docs/superpowers/checklists/2026-06-03-long-term-radio-agent-shadow-smoke.md`

- [ ] **Step 1: Create manual smoke checklist**

Include:

```md
# Long-Term Radio Agent Shadow Smoke

- [ ] Start local server from `C:\Users\lacr1\Desktop\AI音乐\.worktrees\hermes-radio-agent-service`.
- [ ] Open `http://127.0.0.1:8000/`.
- [ ] Log in or restore account.
- [ ] Confirm first track starts before library scan completes.
- [ ] Confirm UI remains usable while agent status says profile/library work is running.
- [ ] Confirm `/api/radio/agent/status?uid=<uid>` returns shadow mode status.
- [ ] Confirm radio playback still uses legacy fallback when shadow runtime fails.
- [ ] Skip one track.
- [ ] Confirm skip is recorded as session evidence, not long-term dislike.
- [ ] Ask "why this song?"
- [ ] Confirm legacy answer still works and shadow trace exists for future explanation.
- [ ] Restart server.
- [ ] Confirm agent artifacts and recent events persist.
```

- [ ] **Step 2: Run markdown diff check**

Run: `git diff --check`

Expected: no whitespace errors.

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/checklists/2026-06-03-long-term-radio-agent-shadow-smoke.md
git commit -m "Add radio agent shadow smoke checklist"
```

## Final Verification

- [ ] **Step 1: Run full tests**

Run: `npm test`

Expected: all tests pass.

- [ ] **Step 2: Build production TypeScript**

Run: `npm run build`

Expected: exit code 0.

- [ ] **Step 3: Run local server**

Run from the worktree with parent `.env` loaded:

```powershell
cd C:\Users\lacr1\Desktop\AI音乐\.worktrees\hermes-radio-agent-service
npm run dev
```

Expected:

- server starts on configured host/port
- `/ready` returns readiness JSON
- `/api/radio/agent/status` returns no secrets

- [ ] **Step 4: Manual browser smoke**

Use the in-app browser at `http://127.0.0.1:8000/`.

Expected:

- playback still starts
- old radio chain remains functional
- shadow radio agent status is available
- no frontend console errors introduced by this work

- [ ] **Step 5: Final commit if any verification-only changes were needed**

Only commit if files changed during verification.

## Execution Notes

- Use TDD for every implementation task.
- Keep commits per task.
- Do not rewrite `RadioBrain` in this plan.
- Do not expose raw agent internals in listener-facing text.
- Do not let background library scan block playback.
- Do not treat one skip as a permanent preference.
- Prefer dependency injection in new `src/radio-agent/` modules so tests can use fakes.
- Keep `server.ts` changes minimal. If it becomes unwieldy during implementation, create a focused `src/radio-agent/serverWiring.ts` helper in a separate task before adding more logic.

## Plan Review Note

The standard plan workflow asks for a plan-document-reviewer subagent. In this Codex environment, subagents may only be spawned when the user explicitly asks for subagents or parallel agent work. If the user wants the review loop, dispatch one reviewer with:

- plan: `docs/superpowers/plans/2026-06-03-long-term-radio-agent-plan.md`
- spec: `docs/superpowers/specs/2026-06-03-long-term-radio-agent-design.md`

Until then, use local review plus the verification commands above.
