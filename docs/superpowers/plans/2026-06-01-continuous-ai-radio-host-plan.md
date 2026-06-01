# Continuous AI Radio Host Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a continuously reasoning AI radio host that starts quickly, plans 3 to 5 tracks in the background, keeps a verified ready buffer, answers "why this song", and reacts immediately to corrections without losing memory.

**Architecture:** Add a `RadioBrain` orchestration layer around the existing `AIStationDirector`, `SearchVerifyAgent`, `DJMemoryManager`, `PlaybackQueue`, profile, and WebSocket flow. Keep the old scheduler as the final continuity fallback, but make every normal track come from an intent, episode, queue warming, and decision trace pipeline.

**Tech Stack:** TypeScript, native Node HTTP/WebSocket backend, Node test runner, SQLite via `node:sqlite`, existing NetEase/audio/TTS services.

---

## Scope Check

This is one integrated product change, but it must be implemented in slices. Each slice below is independently testable and commit-sized. Do not start with the full server rewrite. Build the brain primitives first, then episode planning, then queue warming, then server integration.

## File Structure

- Create `src/radio/radioBrainTypes.ts`: shared intent, profile quality, episode, trace, and radio brain result types.
- Create `src/radio/intentRouter.ts`: fast deterministic user-text classifier for negation, corrections, explanations, continuations, and specific-track requests.
- Create `src/radio/profileQuality.ts`: explicit quality score for saved taste profiles.
- Create `src/radio/decisionTraceStore.ts`: small wrapper around `MemoryStore` for saving and retrieving trace records.
- Create `src/radio/hostResponder.ts`: trace-backed explanations and fast host acknowledgements.
- Create `src/radio/episodePlanner.ts`: LLM planner that produces a 3 to 5 track `RadioEpisode` with backup queries.
- Create `src/radio/queueWarmer.ts`: background verifier/resolver that turns episode items into ready `PlaybackQueue` items and writes traces.
- Create `src/radio/reflectionLoop.ts`: session-memory updates from starts, skips, corrections, and completed tracks.
- Create `src/radio/radioBrain.ts`: per-session orchestration API used by `server.ts`.
- Modify `src/types.ts`: add optional trace and episode fields to `SelectionReason`.
- Modify `src/storage/database.ts`: add `decision_trace`.
- Modify `src/storage/memoryStore.ts`: add trace persistence methods.
- Modify `src/radio/playbackQueue.ts`: add queue removal by predicate and ready depth helpers used by interruptions.
- Modify `src/server.ts`: route startup, next-track, skip, and song requests through `RadioBrain`.
- Modify `frontend/js/radio.js`: display non-technical host status messages from `request_status`.
- Add tests under `tests/ts/`: `intent-router.test.ts`, `profile-quality.test.ts`, `decision-trace.test.ts`, `host-responder.test.ts`, `episode-planner.test.ts`, `queue-warmer.test.ts`, `reflection-loop.test.ts`, `radio-brain.test.ts`.

## Task 1: Shared Types And Intent Router

**Files:**
- Create: `src/radio/radioBrainTypes.ts`
- Create: `src/radio/intentRouter.ts`
- Test: `tests/ts/intent-router.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/ts/intent-router.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the tests and verify they fail**

Run:

```bash
npm run build:test && node --test dist/tests/ts/intent-router.test.js
```

Expected: FAIL because `src/radio/intentRouter.ts` does not exist.

- [ ] **Step 3: Add shared types**

Create `src/radio/radioBrainTypes.ts`:

```ts
import type { MusicTask, StationEnvironment, Track } from "../types.js";

export type ListeningIntentType =
  | "music_direction_request"
  | "specific_track_request"
  | "correction"
  | "negative_feedback"
  | "explanation_question"
  | "preference_update"
  | "continuation"
  | "small_talk";

export interface ListeningIntentDecision {
  type: ListeningIntentType;
  rawText: string;
  query: string;
  positiveSeeds: string[];
  negativeConstraints: string[];
  shouldReplan: boolean;
  shouldClearQueue: boolean;
  shouldExplain: boolean;
  confidence: "low" | "medium" | "high";
  ackText: string;
}

export interface ProfileQuality {
  level: "low_confidence" | "usable" | "strong";
  score: number;
  reasons: string[];
}

export interface RadioEpisodeItem {
  primaryQuery: string;
  backupQueries: string[];
  reason: string;
  style: string;
  energy: string;
  vocality: string;
  fitToProfile: string;
  fitToContext: string;
  avoidBecause: string[];
  musicTask?: MusicTask;
}

export interface RadioEpisode {
  id: string;
  brief: string;
  modeLabel: string;
  arc: string;
  durationTracks: number;
  positiveConstraints: string[];
  negativeConstraints: string[];
  items: RadioEpisodeItem[];
  fallbackPolicy: string;
  hostNotes: string[];
  createdFrom: "startup" | "autoplay" | "user_request" | "correction" | "reflection" | "context_change";
  createdAt: string;
}

export interface DecisionTrace {
  id: string;
  uid: string | null;
  sessionId: number | null;
  episodeId: string;
  intentType: ListeningIntentType | "autoplay";
  profileQuality: ProfileQuality;
  environment: StationEnvironment;
  selectedTrack: Track;
  reason: string;
  rejectedCandidates: string[];
  verificationAttempts: string[];
  fallbackLevel: "episode_primary" | "episode_backup" | "last_episode" | "profile_anchor" | "recent_verified" | "scheduler";
  latencyMs: Record<string, number>;
  hostText: string;
  createdAt: string;
}
```

- [ ] **Step 4: Implement the intent router**

Create `src/radio/intentRouter.ts`:

```ts
import { compactText, dedupe } from "../utils/text.js";
import type { ListeningIntentDecision } from "./radioBrainTypes.js";

const NEGATED_STYLE_PATTERNS: Array<[RegExp, string]> = [
  [/(不要|别|別|不想|拒绝|避开|別太|别太)\s*(太\s*)?emo/iu, "emo"],
  [/(不要|别|別|不想|拒绝|避开)\s*(edm|电子舞曲|电音)/iu, "EDM"],
  [/(不要|别|別|不想|拒绝|避开)\s*(dubstep|回响贝斯)/iu, "dubstep"],
  [/(不要|别|別|不想|拒绝|避开)\s*(人声|vocal|唱的|演唱)/iu, "人声"],
  [/(不要|别|別|不想|拒绝|避开)\s*(中文|华语|中文歌)/iu, "中文歌"],
  [/(太电|太电子|太吵|太炸|炸场|高能)/iu, "高能量"],
];

export class IntentRouter {
  classify(rawText: string): ListeningIntentDecision {
    const text = compactText(rawText, 240);
    const negativeConstraints = this.negativeConstraints(text);
    if (/(为什么|为啥|哪里适合|怎么理解|理由|原因).*(这首|这歌|放)|^(为什么|为啥)/iu.test(text)) {
      return this.intent("explanation_question", text, "", [], negativeConstraints, false, false, true, "我解释一下这首为什么接在这里。");
    }
    if (/(不是这种|不对|换一个|太电|太吵|太炸|不要人声|没有人声)/iu.test(text)) {
      const seeds = /专注|写代码|工作流|安静/iu.test(text) ? ["安静专注工作流"] : ["调整后的方向"];
      return this.intent("correction", text, "", seeds, negativeConstraints, true, true, false, "懂了，我先避开刚才那个方向，重新往你要的感觉收。");
    }
    const direct = text.match(/^(?:放|播放|点一首|我想听|想听)\s+(.{2,80})$/iu);
    if (direct?.[1] && !/(来点|一些|适合|感觉|氛围|风格)/iu.test(direct[1])) {
      return this.intent("specific_track_request", text, compactText(direct[1], 120), [], negativeConstraints, true, true, false, "我找一下这首。");
    }
    if (/(继续|保持|就这个|这个感觉)/iu.test(text)) {
      return this.intent("continuation", text, "", [], negativeConstraints, true, false, false, "好，继续保持这个频率。");
    }
    if (/(不喜欢|以后少放|我其实|我平时)/iu.test(text)) {
      return this.intent("preference_update", text, "", this.positiveSeeds(text, negativeConstraints), negativeConstraints, true, true, false, "记住了，我会把这个偏好先放进当前电台判断里。");
    }
    return this.intent("music_direction_request", text, "", this.positiveSeeds(text, negativeConstraints), negativeConstraints, true, true, false, "收到，我按这个方向重新排接下来的几首。");
  }

  private intent(
    type: ListeningIntentDecision["type"],
    rawText: string,
    query: string,
    positiveSeeds: string[],
    negativeConstraints: string[],
    shouldReplan: boolean,
    shouldClearQueue: boolean,
    shouldExplain: boolean,
    ackText: string,
  ): ListeningIntentDecision {
    return {
      type,
      rawText,
      query,
      positiveSeeds: dedupe(positiveSeeds).slice(0, 8),
      negativeConstraints: dedupe(negativeConstraints).slice(0, 12),
      shouldReplan,
      shouldClearQueue,
      shouldExplain,
      confidence: "high",
      ackText,
    };
  }

  private negativeConstraints(text: string): string[] {
    return NEGATED_STYLE_PATTERNS.filter(([pattern]) => pattern.test(text)).map(([, label]) => label);
  }

  private positiveSeeds(text: string, negativeConstraints: string[]): string[] {
    const seeds: string[] = [];
    if (/专注|写代码|工作流|工作/iu.test(text)) seeds.push("专注工作");
    if (/安静|轻|舒缓/iu.test(text)) seeds.push("安静");
    if (/推动力|有劲|推进/iu.test(text)) seeds.push("轻微推动力");
    if (/\bemo\b|忧郁|情绪/iu.test(text) && !negativeConstraints.includes("emo")) seeds.push("emo");
    if (/\br\s*&?\s*b\b|\brnb\b/iu.test(text)) seeds.push("R&B");
    if (!seeds.length && text) seeds.push(compactText(text.replace(/不要|别太|别|不是这种/giu, ""), 80));
    return seeds.filter(Boolean);
  }
}
```

- [ ] **Step 5: Run the tests and verify they pass**

Run:

```bash
npm run build:test && node --test dist/tests/ts/intent-router.test.js
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/radio/radioBrainTypes.ts src/radio/intentRouter.ts tests/ts/intent-router.test.ts
git commit -m "Add radio brain intent router"
```

## Task 2: Profile Quality And Decision Trace Storage

**Files:**
- Create: `src/radio/profileQuality.ts`
- Create: `src/radio/decisionTraceStore.ts`
- Modify: `src/storage/database.ts`
- Modify: `src/storage/memoryStore.ts`
- Test: `tests/ts/profile-quality.test.ts`
- Test: `tests/ts/decision-trace.test.ts`

- [ ] **Step 1: Write the failing profile quality tests**

Create `tests/ts/profile-quality.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";

import { assessProfileQuality } from "../../src/radio/profileQuality.js";
import type { TasteProfile } from "../../src/types.js";

function profile(overrides: Partial<TasteProfile> = {}): TasteProfile {
  return {
    uid: "42",
    musicDna: { genres: {}, languageBias: {}, energyLevel: "中", vocalPreference: "未知" },
    personality: { traits: [], emotionalResonance: "音乐陪伴" },
    radioInsights: {
      tasteSummary: "用户画像还在建立中。",
      comfortZone: [],
      discoveryDirection: [],
      emotionalHooks: [],
      djTalkingPoints: [],
    },
    anchorTracks: [],
    recentTracks: [],
    likedTrackIds: [],
    learned: { avoidedLanguages: [], avoidedStyles: [], skippedTrackIds: [], negativeFeedbackCount: 0 },
    updatedAt: "2026-06-01T00:00:00.000Z",
    ...overrides,
  };
}

test("shallow profile is marked low confidence", () => {
  const quality = assessProfileQuality(profile());
  assert.equal(quality.level, "low_confidence");
  assert.ok(quality.reasons.includes("missing_genres"));
  assert.ok(quality.reasons.includes("unknown_vocal_preference"));
});

test("rich profile is marked strong", () => {
  const quality = assessProfileQuality(profile({
    musicDna: { genres: { ambient: 0.8, classical: 0.6 }, languageBias: { instrumental: 0.7 }, energyLevel: "低", vocalPreference: "偏无人声" },
    radioInsights: {
      tasteSummary: "偏低能量、器乐、古典和氛围电子。",
      comfortZone: ["Nils Frahm", "Max Richter"],
      discoveryDirection: ["Olafur Arnalds"],
      emotionalHooks: ["Says"],
      djTalkingPoints: ["少说话"],
    },
    anchorTracks: [{ id: "1", name: "Says", artist: "Nils Frahm" }],
    recentTracks: [{ id: "2", name: "Near Light", artist: "Olafur Arnalds" }],
  }));
  assert.equal(quality.level, "strong");
  assert.ok(quality.score >= 0.75);
});
```

- [ ] **Step 2: Write the failing decision trace tests**

Create `tests/ts/decision-trace.test.ts`:

```ts
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { AppDatabase } from "../../src/storage/database.js";
import { MemoryStore } from "../../src/storage/memoryStore.js";
import { DecisionTraceStore } from "../../src/radio/decisionTraceStore.js";
import type { DecisionTrace } from "../../src/radio/radioBrainTypes.js";

function trace(): DecisionTrace {
  return {
    id: "trace-1",
    uid: "42",
    sessionId: 7,
    episodeId: "episode-1",
    intentType: "music_direction_request",
    profileQuality: { level: "usable", score: 0.6, reasons: [] },
    environment: { scene: "夜晚", localTimeBlock: "night", summary: "夜晚" },
    selectedTrack: { id: "song-1", name: "Says", artist: "Nils Frahm" },
    reason: "安静、无人声，适合专注。",
    rejectedCandidates: ["loud-1"],
    verificationAttempts: ["Nils Frahm Says"],
    fallbackLevel: "episode_primary",
    latencyMs: { planning: 1200, verification: 500 },
    hostText: "这首用来把工作流压稳。",
    createdAt: "2026-06-01T00:00:00.000Z",
  };
}

test("decision trace round-trips through sqlite", () => {
  const db = new AppDatabase(path.join(os.tmpdir(), `freqme-trace-${Date.now()}.db`));
  const store = new MemoryStore(db);
  const traces = new DecisionTraceStore(store);

  traces.save(trace());
  const latest = traces.latestForSession("42", 7);

  assert.equal(latest?.id, "trace-1");
  assert.equal(latest?.selectedTrack.name, "Says");
  assert.equal(latest?.fallbackLevel, "episode_primary");
});
```

- [ ] **Step 3: Run the tests and verify they fail**

Run:

```bash
npm run build:test && node --test dist/tests/ts/profile-quality.test.js dist/tests/ts/decision-trace.test.js
```

Expected: FAIL because `profileQuality.ts`, `decisionTraceStore.ts`, and trace persistence do not exist.

- [ ] **Step 4: Implement profile quality**

Create `src/radio/profileQuality.ts`:

```ts
import type { TasteProfile } from "../types.js";
import type { ProfileQuality } from "./radioBrainTypes.js";

export function assessProfileQuality(profile: TasteProfile | null): ProfileQuality {
  if (!profile) return { level: "low_confidence", score: 0, reasons: ["missing_profile"] };
  const reasons: string[] = [];
  let score = 0;

  if (Object.keys(profile.musicDna.genres || {}).length) score += 0.22;
  else reasons.push("missing_genres");
  if (Object.keys(profile.musicDna.languageBias || {}).length) score += 0.14;
  else reasons.push("missing_language_bias");
  if (profile.musicDna.vocalPreference && profile.musicDna.vocalPreference !== "未知") score += 0.14;
  else reasons.push("unknown_vocal_preference");
  if (profile.radioInsights.tasteSummary && !/还在建立|熟悉旋律/.test(profile.radioInsights.tasteSummary)) score += 0.16;
  else reasons.push("generic_taste_summary");
  if (profile.radioInsights.comfortZone.length >= 2) score += 0.12;
  else reasons.push("thin_comfort_zone");
  if (profile.radioInsights.discoveryDirection.length >= 1) score += 0.08;
  if (profile.anchorTracks.length >= 1) score += 0.08;
  if (profile.recentTracks.length >= 1) score += 0.06;

  const rounded = Math.min(1, Number(score.toFixed(2)));
  const level = rounded >= 0.75 ? "strong" : rounded >= 0.45 ? "usable" : "low_confidence";
  return { level, score: rounded, reasons };
}
```

- [ ] **Step 5: Add database and store trace methods**

Modify `src/storage/database.ts` inside `init()`:

```ts
      CREATE TABLE IF NOT EXISTS decision_trace (
        id TEXT PRIMARY KEY,
        uid TEXT,
        session_id INTEGER,
        episode_id TEXT NOT NULL,
        trace_json TEXT NOT NULL,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_decision_trace_uid_session ON decision_trace(uid, session_id, created_at);
```

Modify `src/storage/memoryStore.ts` imports and class methods:

```ts
import type { DecisionTrace } from "../radio/radioBrainTypes.js";
```

```ts
  saveDecisionTrace(trace: DecisionTrace): void {
    this.database.db
      .prepare(`
        INSERT INTO decision_trace (id, uid, session_id, episode_id, trace_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET trace_json=excluded.trace_json
      `)
      .run(trace.id, trace.uid, trace.sessionId, trace.episodeId, json(trace), trace.createdAt);
  }

  getLatestDecisionTrace(uid: string | null, sessionId: number | null): DecisionTrace | null {
    const row = this.database.db
      .prepare(`
        SELECT trace_json
        FROM decision_trace
        WHERE (uid IS ? OR uid = ?) AND (session_id IS ? OR session_id = ?)
        ORDER BY created_at DESC
        LIMIT 1
      `)
      .get(uid, uid, sessionId, sessionId) as { trace_json?: string } | undefined;
    return row ? parse<DecisionTrace>(row.trace_json, null as unknown as DecisionTrace) : null;
  }
```

- [ ] **Step 6: Add decision trace wrapper**

Create `src/radio/decisionTraceStore.ts`:

```ts
import type { MemoryStore } from "../storage/memoryStore.js";
import type { DecisionTrace } from "./radioBrainTypes.js";

export class DecisionTraceStore {
  constructor(private readonly store: MemoryStore) {}

  save(trace: DecisionTrace): void {
    this.store.saveDecisionTrace(trace);
  }

  latestForSession(uid: string | null, sessionId: number | null): DecisionTrace | null {
    return this.store.getLatestDecisionTrace(uid, sessionId);
  }
}
```

- [ ] **Step 7: Run the tests and verify they pass**

Run:

```bash
npm run build:test && node --test dist/tests/ts/profile-quality.test.js dist/tests/ts/decision-trace.test.js
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/radio/profileQuality.ts src/radio/decisionTraceStore.ts src/storage/database.ts src/storage/memoryStore.ts tests/ts/profile-quality.test.ts tests/ts/decision-trace.test.ts
git commit -m "Add radio profile quality and decision traces"
```

## Task 3: Host Responses And Trace-Backed Explanation

**Files:**
- Create: `src/radio/hostResponder.ts`
- Test: `tests/ts/host-responder.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/ts/host-responder.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";

import { HostResponder } from "../../src/radio/hostResponder.js";
import type { DecisionTrace, ListeningIntentDecision } from "../../src/radio/radioBrainTypes.js";

const explanationIntent: ListeningIntentDecision = {
  type: "explanation_question",
  rawText: "为什么给我放这首？",
  query: "",
  positiveSeeds: [],
  negativeConstraints: [],
  shouldReplan: false,
  shouldClearQueue: false,
  shouldExplain: true,
  confidence: "high",
  ackText: "我解释一下这首为什么接在这里。",
};

const trace: DecisionTrace = {
  id: "trace-1",
  uid: "42",
  sessionId: 7,
  episodeId: "episode-1",
  intentType: "music_direction_request",
  profileQuality: { level: "usable", score: 0.6, reasons: [] },
  environment: { scene: "夜晚", localTimeBlock: "night", summary: "夜晚" },
  selectedTrack: { id: "song-1", name: "Says", artist: "Nils Frahm" },
  reason: "它是安静、无人声、但有推进感的器乐，贴合刚才的专注工作流。",
  rejectedCandidates: [],
  verificationAttempts: ["Nils Frahm Says"],
  fallbackLevel: "episode_primary",
  latencyMs: {},
  hostText: "这首先把工作流压稳。",
  createdAt: "2026-06-01T00:00:00.000Z",
};

test("explains the current song from decision trace", () => {
  const responder = new HostResponder();
  const text = responder.explainCurrentTrack(explanationIntent, trace);

  assert.match(text, /Says/);
  assert.match(text, /Nils Frahm/);
  assert.match(text, /专注|工作流|无人声/);
  assert.doesNotMatch(text, /系统|算法|JSON|trace/);
});

test("fast acknowledgement reflects correction constraints", () => {
  const responder = new HostResponder();
  const text = responder.acknowledge({
    ...explanationIntent,
    type: "correction",
    shouldExplain: false,
    shouldReplan: true,
    shouldClearQueue: true,
    negativeConstraints: ["人声", "EDM"],
    positiveSeeds: ["安静专注工作流"],
    ackText: "懂了，我先避开刚才那个方向，重新往你要的感觉收。",
  });

  assert.match(text, /避开|重新|专注/);
});
```

- [ ] **Step 2: Run the tests and verify they fail**

Run:

```bash
npm run build:test && node --test dist/tests/ts/host-responder.test.js
```

Expected: FAIL because `hostResponder.ts` does not exist.

- [ ] **Step 3: Implement host responder**

Create `src/radio/hostResponder.ts`:

```ts
import { compactText } from "../utils/text.js";
import type { DecisionTrace, ListeningIntentDecision } from "./radioBrainTypes.js";

export class HostResponder {
  acknowledge(intent: ListeningIntentDecision): string {
    if (intent.type === "explanation_question") return intent.ackText;
    const positives = intent.positiveSeeds.slice(0, 2).join("、");
    const negatives = intent.negativeConstraints.slice(0, 3).join("、");
    if (intent.type === "correction" || intent.type === "negative_feedback") {
      return compactText(`懂了，我先避开${negatives || "刚才那个方向"}，往${positives || "更合适的方向"}收。`, 120);
    }
    return compactText(intent.ackText || `收到，我往${positives || "这个方向"}排接下来的几首。`, 120);
  }

  explainCurrentTrack(intent: ListeningIntentDecision, trace: DecisionTrace | null): string {
    if (!trace) return "这首是我根据刚才的电台方向接上的，但这次没有留下足够完整的选择记录。";
    const track = `${trace.selectedTrack.artist} 的 ${trace.selectedTrack.name}`.trim();
    const reason = trace.reason || trace.hostText || "它和刚才的电台方向比较贴合。";
    return compactText(`${track} 是因为${reason}`, 180);
  }
}
```

- [ ] **Step 4: Run the tests and verify they pass**

Run:

```bash
npm run build:test && node --test dist/tests/ts/host-responder.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/radio/hostResponder.ts tests/ts/host-responder.test.ts
git commit -m "Add trace-backed host responses"
```

## Task 4: Episode Planner With Backup Queries

**Files:**
- Create: `src/radio/episodePlanner.ts`
- Test: `tests/ts/episode-planner.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/ts/episode-planner.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";

import { EpisodePlanner } from "../../src/radio/episodePlanner.js";
import type { ListeningIntentDecision, ProfileQuality } from "../../src/radio/radioBrainTypes.js";
import type { StationEnvironment, TasteProfile } from "../../src/types.js";

class FakeLlm {
  calls: Array<{ prompt: string; options: Record<string, unknown> }> = [];
  async chat(prompt: string, options: Record<string, unknown>): Promise<string> {
    this.calls.push({ prompt, options });
    return JSON.stringify({
      brief: "安静无人声的专注工作流。",
      mode_label: "focus instrumental",
      arc: "从极简钢琴到轻微推进的器乐电子。",
      duration_tracks: 4,
      positive_constraints: ["安静", "无人声", "专注"],
      negative_constraints: ["emo", "EDM", "dubstep", "人声"],
      items: [
        {
          primary_query: "Nils Frahm Says",
          backup_queries: ["Max Richter On The Nature Of Daylight", "Olafur Arnalds Near Light"],
          reason: "无人声但有推进感。",
          style: "instrumental focus",
          energy: "low-medium",
          vocality: "instrumental",
          fit_to_profile: "接近用户古典与氛围锚点。",
          fit_to_context: "适合夜晚工作。",
          avoid_because: ["EDM"],
        },
        {
          primary_query: "Ryuichi Sakamoto Energy Flow",
          backup_queries: ["Brian Eno An Ending Ascent"],
          reason: "继续安静器乐线。",
          style: "minimal piano",
          energy: "low",
          vocality: "instrumental",
          fit_to_profile: "贴近钢琴锚点。",
          fit_to_context: "不打断专注。",
          avoid_because: ["人声"],
        },
      ],
      fallback_policy: "Use backups, then profile anchors.",
      host_notes: ["少说话，解释选择时强调无人声和专注。"],
    });
  }
}

const intent: ListeningIntentDecision = {
  type: "correction",
  rawText: "不是这种，太电了；我要没有人声的安静专注背景",
  query: "",
  positiveSeeds: ["安静专注工作流"],
  negativeConstraints: ["人声", "EDM", "emo"],
  shouldReplan: true,
  shouldClearQueue: true,
  shouldExplain: false,
  confidence: "high",
  ackText: "懂了。",
};

const environment: StationEnvironment = { scene: "夜晚", localTimeBlock: "night", summary: "夜晚" };
const profile = null as TasteProfile | null;
const profileQuality: ProfileQuality = { level: "low_confidence", score: 0.2, reasons: ["missing_genres"] };

test("episode planner creates a 3 to 5 track episode shape with backups", async () => {
  const llm = new FakeLlm();
  const planner = new EpisodePlanner(llm as any);

  const episode = await planner.plan({
    uid: "42",
    sessionId: 7,
    intent,
    profile,
    profileQuality,
    environment,
    currentTrack: null,
    playedTracks: [],
    readyTracks: [],
    recentTurns: [],
    createdFrom: "correction",
  });

  assert.equal(episode.modeLabel, "focus instrumental");
  assert.equal(episode.negativeConstraints.includes("EDM"), true);
  assert.equal(episode.items[0]?.primaryQuery, "Nils Frahm Says");
  assert.deepEqual(episode.items[0]?.backupQueries.slice(0, 2), ["Max Richter On The Nature Of Daylight", "Olafur Arnalds Near Light"]);
  assert.match(llm.calls[0]?.prompt || "", /low_confidence/);
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run:

```bash
npm run build:test && node --test dist/tests/ts/episode-planner.test.js
```

Expected: FAIL because `episodePlanner.ts` does not exist.

- [ ] **Step 3: Implement episode planner**

Create `src/radio/episodePlanner.ts` with a `plan()` method that calls `LLMRouter.chat`, parses JSON with `extractJsonObject`, and normalizes snake/camel fields:

```ts
import type { LLMRouter } from "../services/llmRouter.js";
import type { StationEnvironment, TasteProfile, Track } from "../types.js";
import { asStringList, compactText, dedupe, extractJsonObject } from "../utils/text.js";
import type { ListeningIntentDecision, ProfileQuality, RadioEpisode, RadioEpisodeItem } from "./radioBrainTypes.js";

export interface EpisodePlanArgs {
  uid: string | null;
  sessionId: number | null;
  intent: ListeningIntentDecision;
  profile: TasteProfile | null;
  profileQuality: ProfileQuality;
  environment: StationEnvironment;
  currentTrack: Track | null;
  playedTracks: Track[];
  readyTracks: Track[];
  recentTurns: Array<Record<string, unknown>>;
  createdFrom: RadioEpisode["createdFrom"];
}

export class EpisodePlanner {
  constructor(
    private readonly llm: LLMRouter,
    private readonly llmTimeoutMs = 12000,
  ) {}

  async plan(args: EpisodePlanArgs): Promise<RadioEpisode> {
    const response = await this.llm.chat(this.prompt(args), {
      maxTokens: 1100,
      system: "You are FREQME's private AI radio episode planner. Return only valid JSON.",
      responseFormat: { type: "json_object" },
      timeoutMs: this.llmTimeoutMs,
    });
    const data = extractJsonObject(response);
    const items = this.items(this.field(data, "items", "items"));
    const duration = Math.max(3, Math.min(5, Number(this.field(data, "duration_tracks", "durationTracks") || items.length || 3)));
    return {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      brief: compactText(this.field(data, "brief", "brief") || args.intent.ackText, 500),
      modeLabel: compactText(this.field(data, "mode_label", "modeLabel") || args.intent.positiveSeeds.join(" / ") || "AI radio", 120),
      arc: compactText(this.field(data, "arc", "arc") || "", 400),
      durationTracks: duration,
      positiveConstraints: dedupe([...args.intent.positiveSeeds, ...asStringList(this.field(data, "positive_constraints", "positiveConstraints"), 10)]),
      negativeConstraints: dedupe([...args.intent.negativeConstraints, ...asStringList(this.field(data, "negative_constraints", "negativeConstraints"), 12)]),
      items: items.slice(0, duration),
      fallbackPolicy: compactText(this.field(data, "fallback_policy", "fallbackPolicy") || "Use item backups, then profile anchors.", 240),
      hostNotes: asStringList(this.field(data, "host_notes", "hostNotes"), 8),
      createdFrom: args.createdFrom,
      createdAt: new Date().toISOString(),
    };
  }

  private prompt(args: EpisodePlanArgs): string {
    return `Create the next FREQME radio episode. Plan 3 to 5 concrete songs with backup queries.

Intent:
${JSON.stringify(args.intent, null, 2)}

Profile quality:
${JSON.stringify(args.profileQuality, null, 2)}

Profile:
${JSON.stringify(args.profile, null, 2)}

Environment:
${JSON.stringify(args.environment, null, 2)}

Playback:
${JSON.stringify({ currentTrack: args.currentTrack, playedTracks: args.playedTracks.slice(-8), readyTracks: args.readyTracks }, null, 2)}

Return only JSON with brief, mode_label, arc, duration_tracks, positive_constraints, negative_constraints, items, fallback_policy, host_notes. Each item must include primary_query and backup_queries.`;
  }

  private items(value: unknown): RadioEpisodeItem[] {
    if (!Array.isArray(value)) return [];
    return value
      .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object" && !Array.isArray(item)))
      .map((item) => ({
        primaryQuery: compactText(this.field(item, "primary_query", "primaryQuery") || item.query || "", 140),
        backupQueries: asStringList(this.field(item, "backup_queries", "backupQueries"), 5),
        reason: compactText(item.reason || "", 240),
        style: compactText(item.style || "", 120),
        energy: compactText(item.energy || "", 80),
        vocality: compactText(item.vocality || "", 80),
        fitToProfile: compactText(this.field(item, "fit_to_profile", "fitToProfile") || "", 220),
        fitToContext: compactText(this.field(item, "fit_to_context", "fitToContext") || "", 220),
        avoidBecause: asStringList(this.field(item, "avoid_because", "avoidBecause"), 8),
      }))
      .filter((item) => item.primaryQuery);
  }

  private field(source: Record<string, unknown>, snake: string, camel: string): unknown {
    return source[snake] ?? source[camel];
  }
}
```

- [ ] **Step 4: Run the test and verify it passes**

Run:

```bash
npm run build:test && node --test dist/tests/ts/episode-planner.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/radio/episodePlanner.ts tests/ts/episode-planner.test.ts
git commit -m "Add AI radio episode planner"
```

## Task 5: Queue Warmer And Decision Tracing

**Files:**
- Create: `src/radio/queueWarmer.ts`
- Modify: `src/types.ts`
- Modify: `src/radio/playbackQueue.ts`
- Test: `tests/ts/queue-warmer.test.ts`

- [ ] **Step 1: Write the failing queue warmer tests**

Create `tests/ts/queue-warmer.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";

import { PlaybackQueue } from "../../src/radio/playbackQueue.js";
import { QueueWarmer } from "../../src/radio/queueWarmer.js";
import type { DecisionTraceStore } from "../../src/radio/decisionTraceStore.js";
import type { RadioEpisode } from "../../src/radio/radioBrainTypes.js";
import type { MusicTask, SearchVerification } from "../../src/types.js";

const episode: RadioEpisode = {
  id: "episode-1",
  brief: "安静专注工作流",
  modeLabel: "focus",
  arc: "quiet to focused",
  durationTracks: 3,
  positiveConstraints: ["安静"],
  negativeConstraints: ["EDM"],
  items: [
    {
      primaryQuery: "bad query",
      backupQueries: ["Nils Frahm Says"],
      reason: "无人声但有推进感。",
      style: "instrumental",
      energy: "low-medium",
      vocality: "instrumental",
      fitToProfile: "钢琴锚点",
      fitToContext: "工作",
      avoidBecause: ["EDM"],
    },
  ],
  fallbackPolicy: "Use backups.",
  hostNotes: [],
  createdFrom: "correction",
  createdAt: "2026-06-01T00:00:00.000Z",
};

class FakeVerifier {
  tasks: MusicTask[] = [];
  async verify(task: MusicTask): Promise<SearchVerification> {
    this.tasks.push(task);
    const query = task.searchGoals[0] || "";
    if (query === "Nils Frahm Says") {
      return {
        status: "verified",
        selectedSong: { id: "says", name: "Says", artist: "Nils Frahm" },
        url: "/api/radio/audio/says",
        verification: { versionNote: "verified backup" },
        fallbackCandidates: [],
        recoveryOptions: [],
        usedQuery: query,
      };
    }
    return { status: "not_found", verification: {}, fallbackCandidates: [], recoveryOptions: [], diagnostics: { searchedQueries: [query] } };
  }
}

class FakeTraceStore {
  traces: unknown[] = [];
  save(trace: unknown): void {
    this.traces.push(trace);
  }
}

test("queue warmer verifies backups and writes a trace", async () => {
  const queue = new PlaybackQueue(2);
  const verifier = new FakeVerifier();
  const traceStore = new FakeTraceStore();
  const warmer = new QueueWarmer(verifier as any, traceStore as unknown as DecisionTraceStore);

  const added = await warmer.warm({
    queue,
    episode,
    uid: "42",
    sessionId: 7,
    intentType: "correction",
    profileQuality: { level: "usable", score: 0.5, reasons: [] },
    environment: { scene: "夜晚", localTimeBlock: "night", summary: "夜晚" },
    targetReady: 1,
    contextPack: {
      userProfileDigest: "",
      sessionWorkingMemory: {},
      recentTurns: [],
      retrievedMemories: [],
      playbackContext: {},
      userSettings: {},
      hardConstraints: [],
    },
  });

  assert.equal(added, 1);
  assert.equal(queue.readyItems()[0]?.track.name, "Says");
  assert.equal(queue.readyItems()[0]?.selectionReason.episodeId, "episode-1");
  assert.equal(traceStore.traces.length, 1);
  assert.equal(verifier.tasks[0]?.searchGoals[0], "bad query");
  assert.equal(verifier.tasks[1]?.searchGoals[0], "Nils Frahm Says");
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run:

```bash
npm run build:test && node --test dist/tests/ts/queue-warmer.test.js
```

Expected: FAIL because `queueWarmer.ts` does not exist and `SelectionReason.episodeId` is not typed.

- [ ] **Step 3: Extend selection reasons and playback queue**

Modify `src/types.ts`:

```ts
export interface SelectionReason {
  type: string;
  text: string;
  understoodIntent?: string;
  verificationNote?: string;
  episodeId?: string;
  traceId?: string;
  fallbackLevel?: string;
}
```

Modify `src/radio/playbackQueue.ts`:

```ts
  removeReadyWhere(predicate: (item: QueueItem) => boolean): number {
    let removed = 0;
    for (let index = this.items.length - 1; index >= 0; index -= 1) {
      const item = this.items[index];
      if (item?.status === "ready" && predicate(item)) {
        this.items.splice(index, 1);
        removed += 1;
      }
    }
    return removed;
  }

  readyDepth(): number {
    return this.readyItems().length;
  }
```

- [ ] **Step 4: Implement queue warmer**

Create `src/radio/queueWarmer.ts`:

```ts
import type { SearchVerifyAgent } from "./searchVerifyAgent.js";
import type { PlaybackQueue } from "./playbackQueue.js";
import type { DecisionTraceStore } from "./decisionTraceStore.js";
import type { DecisionTrace, ListeningIntentType, ProfileQuality, RadioEpisode, RadioEpisodeItem } from "./radioBrainTypes.js";
import type { MemoryPack, MusicTask, StationEnvironment } from "../types.js";

export interface QueueWarmArgs {
  queue: PlaybackQueue;
  episode: RadioEpisode;
  uid: string | null;
  sessionId: number | null;
  intentType: ListeningIntentType | "autoplay";
  profileQuality: ProfileQuality;
  environment: StationEnvironment;
  targetReady: number;
  contextPack: MemoryPack;
}

export class QueueWarmer {
  private readonly cursors = new Map<string, number>();

  constructor(
    private readonly verifier: SearchVerifyAgent,
    private readonly traceStore: DecisionTraceStore,
  ) {}

  async warm(args: QueueWarmArgs): Promise<number> {
    let added = 0;
    let cursor = this.cursors.get(args.episode.id) || 0;
    while (args.queue.readyDepth() < args.targetReady && cursor < args.episode.items.length) {
      const item = args.episode.items[cursor];
      cursor += 1;
      if (!item) continue;
      const queued = await this.tryItem(args, item);
      if (queued) added += 1;
    }
    this.cursors.set(args.episode.id, cursor);
    return added;
  }

  private async tryItem(args: QueueWarmArgs, item: RadioEpisodeItem): Promise<boolean> {
    const queries = [item.primaryQuery, ...item.backupQueries].filter(Boolean);
    const rejectedCandidates: string[] = [];
    const verificationAttempts: string[] = [];
    const startedAt = Date.now();

    for (let index = 0; index < queries.length; index += 1) {
      const query = queries[index] || "";
      verificationAttempts.push(query);
      const task = this.taskForQuery(args.episode, item, query);
      const verification = await this.verifier.verify(task, args.uid, item.primaryQuery, args.contextPack);
      if (verification.status !== "verified" || !verification.selectedSong || !verification.url) {
        rejectedCandidates.push(query);
        continue;
      }

      const fallbackLevel = index === 0 ? "episode_primary" : "episode_backup";
      const traceId = `${args.episode.id}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const hostText = item.reason || args.episode.brief;
      const trace: DecisionTrace = {
        id: traceId,
        uid: args.uid,
        sessionId: args.sessionId,
        episodeId: args.episode.id,
        intentType: args.intentType,
        profileQuality: args.profileQuality,
        environment: args.environment,
        selectedTrack: verification.selectedSong,
        reason: hostText,
        rejectedCandidates,
        verificationAttempts,
        fallbackLevel,
        latencyMs: { verification: Date.now() - startedAt },
        hostText,
        createdAt: new Date().toISOString(),
      };
      this.traceStore.save(trace);
      args.queue.addReady(
        verification.selectedSong,
        verification.url,
        {
          type: "ai_radio_episode",
          text: hostText,
          understoodIntent: args.episode.brief,
          verificationNote: verification.verification.versionNote,
          episodeId: args.episode.id,
          traceId,
          fallbackLevel,
        },
      );
      return true;
    }
    return false;
  }

  private taskForQuery(episode: RadioEpisode, item: RadioEpisodeItem, query: string): MusicTask {
    return {
      type: "specific_track",
      primaryEntities: [],
      workHint: "",
      styleHint: item.style || episode.modeLabel,
      negativeConstraints: episode.negativeConstraints,
      searchGoals: [query],
      mustNotSearchLiteralUserSentence: true,
    };
  }
}
```

- [ ] **Step 5: Run the test and verify it passes**

Run:

```bash
npm run build:test && node --test dist/tests/ts/queue-warmer.test.js
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/radio/queueWarmer.ts src/types.ts src/radio/playbackQueue.ts tests/ts/queue-warmer.test.ts
git commit -m "Add AI episode queue warmer"
```

## Task 6: Reflection Loop For Session Learning

**Files:**
- Create: `src/radio/reflectionLoop.ts`
- Test: `tests/ts/reflection-loop.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/ts/reflection-loop.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";

import { ReflectionLoop } from "../../src/radio/reflectionLoop.js";

test("skip creates session evidence without permanent dislike", () => {
  const loop = new ReflectionLoop();
  const memory = loop.record({
    existing: {},
    event: "skip",
    track: { id: "1", name: "Loud Song", artist: "Club Artist", selectionReason: { type: "ai_radio_episode", text: "high energy", episodeId: "e1" } },
    constraints: ["EDM"],
  });

  assert.deepEqual(memory.currentConstraints, ["EDM"]);
  assert.deepEqual(memory.temporaryRejectedTrackIds, ["1"]);
  assert.equal(memory.longTermCandidates.length, 0);
});

test("repeated explicit preference can create long term candidate", () => {
  const loop = new ReflectionLoop();
  const first = loop.record({ existing: {}, event: "preference_update", rawText: "我其实不太喜欢中文口水歌", constraints: ["中文歌", "口水歌"] });
  const second = loop.record({ existing: first, event: "preference_update", rawText: "以后少放中文口水歌", constraints: ["中文歌", "口水歌"] });

  assert.ok(second.longTermCandidates.some((item) => /中文歌|口水歌/.test(item)));
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run:

```bash
npm run build:test && node --test dist/tests/ts/reflection-loop.test.js
```

Expected: FAIL because `reflectionLoop.ts` does not exist.

- [ ] **Step 3: Implement reflection loop**

Create `src/radio/reflectionLoop.ts`:

```ts
import type { Track } from "../types.js";
import { compactText, dedupe } from "../utils/text.js";

export interface ReflectionMemory {
  currentConstraints?: string[];
  temporaryRejectedTrackIds?: string[];
  correctionCount?: number;
  preferenceEvidence?: Record<string, number>;
  longTermCandidates?: string[];
  updatedAt?: string;
}

export interface ReflectionEvent {
  existing: ReflectionMemory;
  event: "started" | "played" | "skip" | "correction" | "negative_feedback" | "preference_update";
  track?: Track | null;
  rawText?: string;
  constraints?: string[];
}

export class ReflectionLoop {
  record(args: ReflectionEvent): ReflectionMemory {
    const existing = args.existing || {};
    const currentConstraints = dedupe([...(existing.currentConstraints || []), ...(args.constraints || [])]).slice(-12);
    const temporaryRejectedTrackIds = [...(existing.temporaryRejectedTrackIds || [])];
    if (args.event === "skip" && args.track?.id && !temporaryRejectedTrackIds.includes(args.track.id)) {
      temporaryRejectedTrackIds.unshift(args.track.id);
    }
    const preferenceEvidence = { ...(existing.preferenceEvidence || {}) };
    if (args.event === "preference_update") {
      for (const constraint of args.constraints || []) {
        const key = compactText(constraint, 80);
        preferenceEvidence[key] = (preferenceEvidence[key] || 0) + 1;
      }
    }
    const longTermCandidates = dedupe([
      ...(existing.longTermCandidates || []),
      ...Object.entries(preferenceEvidence)
        .filter(([, count]) => count >= 2)
        .map(([key]) => key),
    ]);
    return {
      ...existing,
      currentConstraints,
      temporaryRejectedTrackIds: temporaryRejectedTrackIds.slice(0, 20),
      correctionCount: (existing.correctionCount || 0) + (args.event === "correction" || args.event === "negative_feedback" ? 1 : 0),
      preferenceEvidence,
      longTermCandidates,
      updatedAt: new Date().toISOString(),
    };
  }
}
```

- [ ] **Step 4: Run the test and verify it passes**

Run:

```bash
npm run build:test && node --test dist/tests/ts/reflection-loop.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/radio/reflectionLoop.ts tests/ts/reflection-loop.test.ts
git commit -m "Add radio reflection loop"
```

## Task 7: RadioBrain Orchestration

**Files:**
- Create: `src/radio/radioBrain.ts`
- Test: `tests/ts/radio-brain.test.ts`

- [ ] **Step 1: Write failing orchestration tests**

Create `tests/ts/radio-brain.test.ts` with two tests:

```ts
import assert from "node:assert/strict";
import test from "node:test";

import { PlaybackQueue } from "../../src/radio/playbackQueue.js";
import { RadioBrain } from "../../src/radio/radioBrain.js";

test("startup returns a bridge track before deep planning completes", async () => {
  const queue = new PlaybackQueue(2);
  const brain = new RadioBrain({
    intentRouter: { classify: (text: string) => ({ type: "music_direction_request", rawText: text, query: "", positiveSeeds: [], negativeConstraints: [], shouldReplan: true, shouldClearQueue: false, shouldExplain: false, confidence: "high", ackText: "" }) },
    planner: { plan: async () => { throw new Error("deep planner should run in background"); } },
    warmer: { warm: async () => 0 },
    responder: { acknowledge: () => "", explainCurrentTrack: () => "" },
    traceStore: { latestForSession: () => null, save: () => undefined },
    reflectionLoop: { record: (args: any) => args.existing || {} },
    bridgePicker: async () => ({ track: { id: "bridge", name: "Bridge", artist: "Known" }, url: "/audio/bridge", reason: "safe bridge" }),
  } as any);

  const result = await brain.startSession({
    queue,
    uid: "42",
    sessionId: 7,
    profile: null,
    settings: {},
    environment: { scene: "夜晚", localTimeBlock: "night", summary: "夜晚" },
    currentTrack: null,
    playedTracks: [],
    recentTurns: [],
    contextPack: { userProfileDigest: "", sessionWorkingMemory: {}, recentTurns: [], retrievedMemories: [], playbackContext: {}, userSettings: {}, hardConstraints: [] },
  });

  assert.equal(result.status, "bridge_ready");
  assert.equal(queue.readyItems()[0]?.track.id, "bridge");
});

test("explanation request returns text and does not clear queue", async () => {
  const queue = new PlaybackQueue(2);
  queue.addReady({ id: "next", name: "Next", artist: "Artist" }, "/audio/next", { type: "ai_radio_episode", text: "next" });
  const brain = new RadioBrain({
    intentRouter: { classify: () => ({ type: "explanation_question", rawText: "为什么", query: "", positiveSeeds: [], negativeConstraints: [], shouldReplan: false, shouldClearQueue: false, shouldExplain: true, confidence: "high", ackText: "解释一下。" }) },
    responder: { acknowledge: () => "解释一下。", explainCurrentTrack: () => "因为它适合现在。" },
    traceStore: { latestForSession: () => null, save: () => undefined },
    reflectionLoop: { record: (args: any) => args.existing || {} },
  } as any);

  const result = await brain.handleUserText({
    queue,
    text: "为什么给我放这首？",
    uid: "42",
    sessionId: 7,
    profile: null,
    settings: {},
    environment: { scene: "夜晚", localTimeBlock: "night", summary: "夜晚" },
    currentTrack: null,
    playedTracks: [],
    recentTurns: [],
    contextPack: { userProfileDigest: "", sessionWorkingMemory: {}, recentTurns: [], retrievedMemories: [], playbackContext: {}, userSettings: {}, hardConstraints: [] },
  });

  assert.equal(result.status, "explained");
  assert.equal(queue.readyItems().length, 1);
  assert.match(result.hostText, /适合现在/);
});
```

- [ ] **Step 2: Run the tests and verify they fail**

Run:

```bash
npm run build:test && node --test dist/tests/ts/radio-brain.test.js
```

Expected: FAIL because `radioBrain.ts` does not exist.

- [ ] **Step 3: Implement RadioBrain minimum API**

Create `src/radio/radioBrain.ts`:

```ts
import type { DecisionTraceStore } from "./decisionTraceStore.js";
import type { EpisodePlanner } from "./episodePlanner.js";
import type { HostResponder } from "./hostResponder.js";
import type { IntentRouter } from "./intentRouter.js";
import type { PlaybackQueue } from "./playbackQueue.js";
import { assessProfileQuality } from "./profileQuality.js";
import type { QueueWarmer } from "./queueWarmer.js";
import type { ReflectionLoop, ReflectionMemory } from "./reflectionLoop.js";
import type { ListeningIntentDecision } from "./radioBrainTypes.js";
import type { MemoryPack, StationEnvironment, TasteProfile, Track, UserSettings } from "../types.js";

export type RadioBrainResultStatus = "bridge_ready" | "explained" | "acknowledged" | "queued" | "not_found";

export interface RadioBrainResult {
  status: RadioBrainResultStatus;
  hostText: string;
}

export interface BridgePick {
  track: Track;
  url: string;
  reason: string;
}

export interface RadioBrainArgs {
  queue: PlaybackQueue;
  uid: string | null;
  sessionId: number | null;
  profile: TasteProfile | null;
  settings: Partial<UserSettings>;
  environment: StationEnvironment;
  currentTrack: Track | null;
  playedTracks: Track[];
  recentTurns: Array<Record<string, unknown>>;
  contextPack: MemoryPack;
}

export interface UserTextArgs extends RadioBrainArgs {
  text: string;
}

export interface RadioBrainDeps {
  intentRouter: Pick<IntentRouter, "classify">;
  planner?: Pick<EpisodePlanner, "plan">;
  warmer?: Pick<QueueWarmer, "warm">;
  responder: Pick<HostResponder, "acknowledge" | "explainCurrentTrack">;
  traceStore: Pick<DecisionTraceStore, "latestForSession">;
  reflectionLoop: Pick<ReflectionLoop, "record">;
  bridgePicker?: (uid: string | null, profile: TasteProfile | null) => Promise<BridgePick | null>;
}

export class RadioBrain {
  private reflectionMemory: ReflectionMemory = {};

  constructor(private readonly deps: RadioBrainDeps) {}

  async startSession(args: RadioBrainArgs): Promise<RadioBrainResult> {
    if (!args.queue.readyDepth() && this.deps.bridgePicker) {
      const bridge = await this.deps.bridgePicker(args.uid, args.profile);
      if (bridge) {
        args.queue.addReady(bridge.track, bridge.url, {
          type: "startup_bridge",
          text: bridge.reason,
        });
      }
    }
    void this.planAndWarm(args, this.defaultIntent("startup")).catch(() => undefined);
    return { status: "bridge_ready", hostText: "" };
  }

  async handleUserText(args: UserTextArgs): Promise<RadioBrainResult> {
    const intent = this.deps.intentRouter.classify(args.text);
    if (intent.shouldExplain) {
      const trace = this.deps.traceStore.latestForSession(args.uid, args.sessionId);
      return {
        status: "explained",
        hostText: this.deps.responder.explainCurrentTrack(intent, trace),
      };
    }
    if (intent.shouldClearQueue) {
      args.queue.removeReadyWhere((item) => this.conflicts(item.selectionReason.text, intent.negativeConstraints));
    }
    this.reflectionMemory = this.deps.reflectionLoop.record({
      existing: this.reflectionMemory,
      event: intent.type === "preference_update" ? "preference_update" : intent.type === "correction" ? "correction" : "negative_feedback",
      track: args.currentTrack,
      rawText: args.text,
      constraints: intent.negativeConstraints,
    });
    const hostText = this.deps.responder.acknowledge(intent);
    if (intent.shouldReplan) void this.planAndWarm(args, intent).catch(() => undefined);
    return { status: "acknowledged", hostText };
  }

  private async planAndWarm(args: RadioBrainArgs, intent: ListeningIntentDecision): Promise<void> {
    if (!this.deps.planner || !this.deps.warmer) return;
    const profileQuality = assessProfileQuality(args.profile);
    const episode = await this.deps.planner.plan({
      uid: args.uid,
      sessionId: args.sessionId,
      intent,
      profile: args.profile,
      profileQuality,
      environment: args.environment,
      currentTrack: args.currentTrack,
      playedTracks: args.playedTracks,
      readyTracks: args.queue.readyItems().map((item) => item.track),
      recentTurns: args.recentTurns,
      createdFrom: intent.type === "correction" ? "correction" : intent.rawText === "startup" ? "startup" : "user_request",
    });
    await this.deps.warmer.warm({
      queue: args.queue,
      episode,
      uid: args.uid,
      sessionId: args.sessionId,
      intentType: intent.rawText === "startup" ? "autoplay" : intent.type,
      profileQuality,
      environment: args.environment,
      targetReady: 2,
      contextPack: args.contextPack,
    });
  }

  private conflicts(text: string, constraints: string[]): boolean {
    const lower = text.toLowerCase();
    return constraints.some((constraint) => lower.includes(constraint.toLowerCase()));
  }

  private defaultIntent(rawText: string): ListeningIntentDecision {
    return {
      type: "music_direction_request",
      rawText,
      query: "",
      positiveSeeds: [],
      negativeConstraints: [],
      shouldReplan: true,
      shouldClearQueue: false,
      shouldExplain: false,
      confidence: "medium",
      ackText: "",
    };
  }
}
```

- [ ] **Step 4: Run the tests and verify they pass**

Run:

```bash
npm run build:test && node --test dist/tests/ts/radio-brain.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/radio/radioBrain.ts tests/ts/radio-brain.test.ts
git commit -m "Add continuous radio brain orchestrator"
```

## Task 8: Server Integration And User-Visible Status

**Files:**
- Modify: `src/server.ts`
- Modify: `frontend/js/radio.js`
- Test: `tests/js/radio-websocket.test.mjs`
- Test: `tests/ts/radio-brain.test.ts`

- [ ] **Step 1: Add failing integration expectations**

Append this frontend status test to `tests/js/radio-websocket.test.mjs`:

```js
test('request status explanation and planning update host text without changing playback', async () => {
  const { context, elements } = loadRadio();
  const audioMain = elements.get('audio-main');

  await context.handleMessage({
    type: 'play_track',
    track: { id: '1', name: 'Current', artist: 'Artist' },
    url: '/api/radio/audio/1',
  });
  await context.handleMessage({
    type: 'request_status',
    status: 'explained',
    text: '这首是因为它适合你现在的专注工作流。',
  });

  assert.equal(elements.get('dj-text').textContent, '这首是因为它适合你现在的专注工作流。');
  assert.equal(audioMain.src, '/api/radio/audio/1');

  await context.handleMessage({
    type: 'request_status',
    status: 'planning',
    text: '我先避开这个方向，重新排接下来的几首。',
  });

  assert.equal(elements.get('dj-text').textContent, '我先避开这个方向，重新排接下来的几首。');
  assert.equal(audioMain.src, '/api/radio/audio/1');
});
```

Add a TS orchestration test that asserts correction clears ready queue:

```ts
assert.equal(result.status, "acknowledged");
assert.equal(queue.readyItems().some((item) => /EDM|emo/i.test(item.selectionReason.text)), false);
```

- [ ] **Step 2: Run the focused tests and verify they fail**

Run:

```bash
npm run build:test && node --test dist/tests/ts/radio-brain.test.js tests/js/radio-websocket.test.mjs
```

Expected: FAIL because server still routes every text request through `stationDirector.handleUserRequest()`.

- [ ] **Step 3: Instantiate RadioBrain dependencies in `src/server.ts`**

Near existing service construction, add:

```ts
const intentRouter = new IntentRouter();
const traceStore = new DecisionTraceStore(store);
const hostResponder = new HostResponder();
const episodePlanner = new EpisodePlanner(llm);
const reflectionLoop = new ReflectionLoop();
const queueWarmer = new QueueWarmer(searchVerifyAgent, traceStore);
const radioBrain = new RadioBrain({
  intentRouter,
  planner: episodePlanner,
  warmer: queueWarmer,
  responder: hostResponder,
  traceStore,
  reflectionLoop,
  bridgePicker: pickBridgeTrack,
});
```

Add `pickBridgeTrack()` in `server.ts` using existing safe fallbacks:

```ts
const pickBridgeTrack = async (uid: string | null, profile: TasteProfile | null): Promise<{ track: Track; url: string; reason: string } | null> => {
  for (const track of store.getRecentPlayableTracks(uid, 20)) {
    const prepared = await scheduler.prepareTrack(track, uid);
    if (prepared) return { track: prepared.track, url: prepared.url, reason: "最近确认可播的安全桥接歌。" };
  }
  for (const track of profile?.anchorTracks || []) {
    const prepared = await scheduler.prepareTrack(track, uid);
    if (prepared) return { track: prepared.track, url: prepared.url, reason: "从你的歌单锚点先稳稳接上。" };
  }
  return null;
};
```

- [ ] **Step 4: Route startup through RadioBrain**

In the handshake block, replace the first `await fillQueue(1)` with:

```ts
const contextPack = djMemory.buildContextPack({
  uid,
  sessionId,
  requestText: "startup",
  profile,
  userSettings: settings,
  playbackContext: { currentTrack, recentTracks: playedTracks.slice(-10), readyQueue: queue.readyItems().map((item) => item.track), scene, environment },
  recentTurns,
});
await radioBrain.startSession({
  queue,
  uid,
  sessionId,
  profile,
  settings,
  environment,
  currentTrack,
  playedTracks,
  recentTurns,
  contextPack,
});
```

Keep `sendTrack(item.track, item.url)` after promoting the first ready item.

- [ ] **Step 5: Route user text through RadioBrain**

In the `song_request` block, classify and handle through `radioBrain.handleUserText()` before falling back to the old station director. The explanation branch must send:

```ts
send({ type: "request_status", status: "explained", text: result.hostText });
synthesizeAndSendDjMessage(result.hostText);
return;
```

For correction and direction requests, send an immediate acknowledgement:

```ts
send({ type: "request_status", status: "planning", text: result.hostText });
synthesizeAndSendDjMessage(result.hostText);
```

Only call `sendPreparedNext("played")` after a corrected ready item exists.

- [ ] **Step 6: Update frontend status handling**

In `frontend/js/radio.js`, extend the `request_status` switch so `explained` and `planning` show the server text without changing playback locally:

```js
if (msg.status === 'explained' || msg.status === 'planning') {
  setDjText(msg.text || '我正在处理。');
  setRequestStatus(msg.text || '', 'ok');
  return;
}
```

- [ ] **Step 7: Run focused integration tests**

Run:

```bash
npm run build:test && node --test dist/tests/ts/radio-brain.test.js tests/js/radio-websocket.test.mjs
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/server.ts frontend/js/radio.js tests/js/radio-websocket.test.mjs tests/ts/radio-brain.test.ts
git commit -m "Route radio playback through continuous brain"
```

## Task 9: Full Verification And Live Smoke Checklist

**Files:**
- Modify: `README.md`
- Create: `docs/superpowers/checklists/2026-06-01-continuous-ai-radio-host-smoke.md`

- [ ] **Step 1: Add smoke checklist**

Create `docs/superpowers/checklists/2026-06-01-continuous-ai-radio-host-smoke.md`:

```md
# Continuous AI Radio Host Smoke Checklist

- Start local server.
- Open `http://127.0.0.1:8002/` with a logged-in NetEase account.
- Confirm first track starts before deep planning finishes.
- Ask: `我现在要专注写代码，别太 emo，也不要 edm/dubstep，来点安静但有推动力的`.
- Confirm the resulting plan does not contain emo as a positive direction.
- Ask: `你为什么给我放这首？`.
- Confirm the answer explains the current track and does not trigger a new `play_track`.
- Ask: `不是这种，太电了；我要没有人声的安静专注背景，像工作流，不要 emo，不要 edm`.
- Confirm queued incompatible tracks are cleared and the next track is instrumental/focus.
- Let two next tracks play and confirm the direction persists.
- Check `playback_event` and `decision_trace` rows for traceability.
```

- [ ] **Step 2: Update README operational note**

Add a short section to `README.md`:

```md
## Continuous AI Host Smoke

After changing radio brain behavior, run the local smoke checklist in `docs/superpowers/checklists/2026-06-01-continuous-ai-radio-host-smoke.md`. Unit tests prove the routing and queue behavior; the smoke confirms the logged-in NetEase path, real audio resolution, and host explanation flow.
```

- [ ] **Step 3: Run full automated verification**

Run:

```bash
npm run typecheck
npm test
git diff --check
```

Expected:

- `npm run typecheck` exits 0.
- `npm test` exits 0.
- `git diff --check` prints no whitespace errors.

- [ ] **Step 4: Run local smoke**

Use the running local app or restart with:

```bash
npm run build
npm run start:local
```

Then complete `docs/superpowers/checklists/2026-06-01-continuous-ai-radio-host-smoke.md` manually in the browser.

- [ ] **Step 5: Commit**

```bash
git add README.md docs/superpowers/checklists/2026-06-01-continuous-ai-radio-host-smoke.md
git commit -m "Document continuous AI radio host smoke test"
```

## Final Verification

After all tasks are complete, run:

```bash
npm run typecheck
npm test
git status --short
```

Expected:

- Typecheck passes.
- All tests pass.
- `git status --short` is empty.

Then run the browser smoke checklist and record the result in the final response.
