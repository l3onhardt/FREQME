# Hermes Radio Agent Phase 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move FREQME from shadow-only radio-agent observation into Phase 2 Assisted Agent mode, where `RadioAgentRuntime` owns program intent and the legacy playback stack acts as tool execution plus fallback.

**Architecture:** Add a compact context engine, a program director, and a tool-execution adapter under `src/radio-agent/`. `RadioAgentRuntime` should create agent-owned radio windows from `user_profile.md`, `station_now.md`, `program_contract.md`, and recent events. The server should try agent-produced windows first in assisted mode, then fall back to the existing `AIStationDirector` / scheduler path.

**Tech Stack:** TypeScript, Node test runner, existing `LLMRouter`, `SearchVerifyAgent`, `PlaybackQueue`, `DecisionTraceStore`, SQLite-backed `RadioAgentStore`, and current WebSocket server.

---

## Scope

This plan implements the first Phase 2 slice from `docs/superpowers/specs/2026-06-03-hermes-radio-agent-target-design.md`.

It does:

- create typed agent context snapshots from durable artifacts and recent events;
- create agent-owned multi-track radio windows;
- persist program-window decisions in the radio-agent decision stream;
- execute the first candidate through existing search/verify/audio tools;
- attach host intent and trace data to queued tracks;
- make server queue filling prefer assisted agent output when enabled;
- preserve the old queue path as fallback.

It does not:

- remove `RadioBrain`;
- remove `AIStationDirector`;
- build a diagnostics dashboard;
- build a perfect music-style ontology;
- make multi-agent orchestration;
- make the agent active by default without a fallback path.

## Alignment Rule

Every task below must move ownership toward this flow:

```text
queue_low or track_completed
  -> RadioAgentRuntime receives the event
  -> ContextEngine transforms artifacts plus events into compact context
  -> ProgramDirector emits an agent-owned radio window
  -> Tool adapter executes the first candidate
  -> DecisionTrace records why the track was chosen
  -> HostAgent intent becomes segue text or intentional silence
  -> legacy path runs only when the assisted agent cannot produce a safe item
```

If an implementation makes the old planning chain smarter while leaving the radio agent as an observer, stop and redesign before continuing.

## File Structure

Create:

- `src/radio-agent/agentContext.ts`
  - Pure context transformer. Reads artifacts, recent events, current queue/playback inputs, and memory rows into `RadioAgentContextSnapshot`.
- `src/radio-agent/programDirector.ts`
  - Agent-owned program planner. Uses an injected JSON planning model when available and deterministic fallback when unavailable.
- `src/radio-agent/programExecutor.ts`
  - Tool adapter that turns one `RadioAgentCandidateTask` into a verified, playable prepared track through `SearchVerifyAgent`.
- `tests/ts/radio-agent-context.test.ts`
- `tests/ts/radio-agent-program-director.test.ts`
- `tests/ts/radio-agent-program-executor.test.ts`

Modify:

- `src/radio-agent/types.ts`
  - Add typed program-window, candidate-task, host-intent, context-snapshot, and assisted-action result types.
- `src/radio-agent/radioAgentRuntime.ts`
  - Build context and plan a program window on `queue_low` and selected `track_completed` events.
- `src/config.ts`
  - Add `radioAgentMode` from `RADIO_AGENT_MODE`, with safe parsing.
- `src/server.ts`
  - Instantiate the program director and executor.
  - Try assisted agent planning before old `stationDirector.pickNext()` when mode is `assisted` or `active`.
  - Save agent traces for successfully queued tracks.
- `tests/ts/radio-agent-runtime.test.ts`
- `tests/ts/radio-agent-server-wiring.test.ts`
- `tests/ts/runtime-status.test.ts` if runtime status exposes the new mode.
- `docs/superpowers/checklists/2026-06-03-hermes-radio-agent-assisted-smoke.md`

## Task 1: Agent Context Snapshot

**Files:**
- Create: `src/radio-agent/agentContext.ts`
- Modify: `src/radio-agent/types.ts`
- Test: `tests/ts/radio-agent-context.test.ts`

- [ ] **Step 1: Write the failing context tests**

Create `tests/ts/radio-agent-context.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";

import { buildRadioAgentContextSnapshot } from "../../src/radio-agent/agentContext.js";
import type { RadioAgentEvent, RadioAgentMemory } from "../../src/radio-agent/types.js";

test("agent context compacts profile, now, contract, memory, and current playback", () => {
  const events: RadioAgentEvent[] = [
    {
      uid: "42",
      sessionId: 7,
      type: "playback_started",
      priority: "warm",
      payload: { track: { id: "s1", name: "Good Days", artist: "SZA" } },
      createdAt: "2026-06-03T01:00:00.000Z",
    },
  ];
  const memories: RadioAgentMemory[] = [
    {
      uid: "42",
      key: "artist:SZA",
      kind: "taste_fact",
      value: "Listener has repeated library evidence for SZA.",
      confidence: 0.84,
      evidenceCount: 4,
      evidenceRefs: ["track:s1"],
      updatedAt: "2026-06-03T01:01:00.000Z",
    },
  ];

  const snapshot = buildRadioAgentContextSnapshot({
    uid: "42",
    sessionId: 7,
    eventType: "queue_low",
    artifacts: {
      "user_profile.md": "# User Profile\n\n## Stable Taste Facts\n- artist:SZA: Listener has repeated library evidence for SZA.",
      "station_now.md": "# Station Now\n\nlocal_time_block: late_night\ncurrent_track: Good Days - SZA (s1)",
      "program_contract.md": "# Program Contract\n\nstation_goal: keep late-night R&B coherent",
    },
    recentEvents: events,
    memories,
    currentTrack: { id: "s1", name: "Good Days", artist: "SZA" },
    readyQueue: [],
  });

  assert.equal(snapshot.uid, "42");
  assert.equal(snapshot.eventType, "queue_low");
  assert.equal(snapshot.currentTrack?.id, "s1");
  assert.match(snapshot.profile, /SZA/);
  assert.match(snapshot.now, /late_night/);
  assert.match(snapshot.contract, /late-night R&B/);
  assert.equal(snapshot.memoryFacts[0]?.key, "artist:SZA");
});

test("agent context caps large artifacts before model boundary", () => {
  const huge = `${"profile evidence\n".repeat(1000)}`;
  const snapshot = buildRadioAgentContextSnapshot({
    uid: "42",
    sessionId: 7,
    eventType: "queue_low",
    artifacts: { "user_profile.md": huge },
    recentEvents: [],
    memories: [],
    currentTrack: null,
    readyQueue: [],
  });

  assert.ok(snapshot.profile.length < huge.length);
  assert.match(snapshot.profile, /truncated for agent context/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```powershell
npm run build:test
node --test dist/tests/ts/radio-agent-context.test.js
```

Expected: FAIL because `src/radio-agent/agentContext.ts` does not exist.

- [ ] **Step 3: Add context types**

In `src/radio-agent/types.ts`, add:

```ts
export interface RadioAgentContextSnapshot {
  uid: string | null;
  sessionId: number | null;
  eventType: RadioAgentEventType;
  profile: string;
  now: string;
  contract: string;
  memoryFacts: RadioAgentMemory[];
  memoryHypotheses: RadioAgentMemory[];
  recentEvents: RadioAgentEvent[];
  currentTrack: Track | null;
  readyQueue: Track[];
}
```

- [ ] **Step 4: Implement `buildRadioAgentContextSnapshot`**

In `src/radio-agent/agentContext.ts`, implement a pure function:

```ts
export interface BuildRadioAgentContextSnapshotArgs {
  uid: string | null;
  sessionId: number | null;
  eventType: RadioAgentEventType;
  artifacts: Record<string, string | undefined>;
  recentEvents: RadioAgentEvent[];
  memories: RadioAgentMemory[];
  currentTrack?: Track | null;
  readyQueue: Track[];
}

export function buildRadioAgentContextSnapshot(args: BuildRadioAgentContextSnapshotArgs): RadioAgentContextSnapshot
```

Rules:

- Include only compact artifact text.
- Cap each artifact at 4,000 characters.
- Append `"... truncated for agent context"` when truncating.
- Split memories into `taste_fact` and `taste_hypothesis`.
- Keep recent events to the latest 12.
- Do not include raw library rows or raw NetEase JSON.

- [ ] **Step 5: Run context tests**

Run:

```powershell
npm run build:test
node --test dist/tests/ts/radio-agent-context.test.js
```

Expected: PASS.

- [ ] **Step 6: Commit**

```powershell
git add src/radio-agent/types.ts src/radio-agent/agentContext.ts tests/ts/radio-agent-context.test.ts
git commit -m "Add radio agent context snapshots"
```

## Task 2: Agent-Owned Program Director

**Files:**
- Create: `src/radio-agent/programDirector.ts`
- Modify: `src/radio-agent/types.ts`
- Test: `tests/ts/radio-agent-program-director.test.ts`

- [ ] **Step 1: Write failing program director tests**

Create `tests/ts/radio-agent-program-director.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";

import { RadioAgentProgramDirector } from "../../src/radio-agent/programDirector.js";
import type { RadioAgentContextSnapshot } from "../../src/radio-agent/types.js";

class JsonPlanningModel {
  async chat(prompt: string) {
    assert.match(prompt, /User Profile/);
    assert.match(prompt, /Program Contract/);
    return JSON.stringify({
      station_brief: "Keep a late-night R&B window with one soft bridge at most.",
      main_direction: "late-night R&B",
      allowed_adjacent: ["alt-R&B", "neo-soul"],
      bridge_budget: 1,
      disallowed: ["classical chamber music", "high-energy EDM"],
      return_requirement: "Return to vocal R&B after any bridge.",
      candidate_tasks: [
        { query: "SZA Good Days", reason: "Anchors the window in known taste.", style: "late-night R&B" },
        { query: "Frank Ocean Pink + White", reason: "Keeps the low-lit vocal lane.", style: "alt-R&B" },
      ],
      host_intent: { should_speak: true, event: "return_to_contract", reason: "set the station lane", text: "I will keep this low and close to your R&B lane." },
    });
  }
}

const context: RadioAgentContextSnapshot = {
  uid: "42",
  sessionId: 9,
  eventType: "queue_low",
  profile: "# User Profile\nListener has repeated library evidence for SZA.",
  now: "# Station Now\nlocal_time_block: late_night",
  contract: "# Program Contract\nstation_goal: keep late-night R&B coherent",
  memoryFacts: [],
  memoryHypotheses: [],
  recentEvents: [],
  currentTrack: { id: "s1", name: "Good Days", artist: "SZA" },
  readyQueue: [],
};

test("program director plans an agent-owned radio window from compact context", async () => {
  const director = new RadioAgentProgramDirector(new JsonPlanningModel() as any, () => "2026-06-03T01:02:03.000Z");
  const window = await director.plan(context);

  assert.equal(window.mainDirection, "late-night R&B");
  assert.equal(window.candidateTasks.length, 2);
  assert.equal(window.candidateTasks[0]?.query, "SZA Good Days");
  assert.equal(window.hostIntent.shouldSpeak, true);
  assert.equal(window.traceBasis.profile.includes("SZA"), true);
});

test("program director falls back to memory anchors when model planning fails", async () => {
  const director = new RadioAgentProgramDirector({ chat: async () => { throw new Error("down"); } } as any, () => "2026-06-03T01:02:03.000Z");
  const window = await director.plan({
    ...context,
    memoryFacts: [
      {
        uid: "42",
        key: "artist:SZA",
        kind: "taste_fact",
        value: "Listener has repeated library evidence for SZA.",
        confidence: 0.84,
        evidenceCount: 4,
        evidenceRefs: ["track:s1"],
        updatedAt: "2026-06-03T01:01:00.000Z",
      },
    ],
  });

  assert.equal(window.source, "deterministic_fallback");
  assert.ok(window.candidateTasks.some((task) => /SZA/i.test(task.query)));
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```powershell
npm run build:test
node --test dist/tests/ts/radio-agent-program-director.test.js
```

Expected: FAIL because `programDirector.ts` and program-window types do not exist.

- [ ] **Step 3: Add program-window types**

In `src/radio-agent/types.ts`, add:

```ts
export interface RadioAgentCandidateTask {
  query: string;
  reason: string;
  style: string;
  negativeConstraints: string[];
}

export interface RadioAgentHostIntent {
  shouldSpeak: boolean;
  event: "station_open" | "request_ack" | "bridge_entered" | "return_to_contract" | "explanation" | "correction" | "recovery" | "silent";
  reason: string;
  text: string;
}

export interface RadioAgentProgramWindow {
  id: string;
  uid: string | null;
  sessionId: number | null;
  stationBrief: string;
  mainDirection: string;
  allowedAdjacent: string[];
  bridgeBudget: number;
  disallowed: string[];
  returnRequirement: string;
  candidateTasks: RadioAgentCandidateTask[];
  hostIntent: RadioAgentHostIntent;
  traceBasis: {
    profile: string;
    now: string;
    contract: string;
    eventType: RadioAgentEventType;
  };
  source: "model" | "deterministic_fallback";
  createdAt: string;
}
```

- [ ] **Step 4: Implement `RadioAgentProgramDirector`**

In `src/radio-agent/programDirector.ts`, implement:

```ts
export interface ProgramPlanningModel {
  chat(prompt: string, options?: Record<string, unknown>): Promise<string>;
}

export class RadioAgentProgramDirector {
  constructor(private readonly model: ProgramPlanningModel | null, private readonly now = () => new Date().toISOString()) {}
  async plan(context: RadioAgentContextSnapshot): Promise<RadioAgentProgramWindow> {}
}
```

Rules:

- Build a prompt from profile, now, contract, memory facts, recent events, current track, and ready queue.
- Ask for JSON only.
- Parse snake_case and camelCase keys.
- Keep at most 5 candidate tasks.
- Drop candidate tasks that look like raw user sentences, playlists, sleep/study utility audio, or blank queries.
- Fall back to deterministic anchors from memory facts and current contract if the model fails or returns no tasks.
- Host text must be short and listener-facing.
- Never allow host text to include internal terms: `model`, `JSON`, `candidate`, `trace`, `prompt`, `verification`, `shadow mode`, `tool call`.

- [ ] **Step 5: Run program director tests**

Run:

```powershell
npm run build:test
node --test dist/tests/ts/radio-agent-program-director.test.js
```

Expected: PASS.

- [ ] **Step 6: Commit**

```powershell
git add src/radio-agent/types.ts src/radio-agent/programDirector.ts tests/ts/radio-agent-program-director.test.ts
git commit -m "Add radio agent program director"
```

## Task 3: Runtime Produces Program Windows

**Files:**
- Modify: `src/radio-agent/radioAgentRuntime.ts`
- Modify: `src/radio-agent/types.ts`
- Test: `tests/ts/radio-agent-runtime.test.ts`

- [ ] **Step 1: Write failing runtime tests**

Append to `tests/ts/radio-agent-runtime.test.ts`:

```ts
test("runtime plans an agent-owned program window on queue low", async () => {
  const store = runtimeStore({
    memories: (uid: string, kind: string, limit: number) =>
      [
        {
          uid,
          key: "artist:SZA",
          kind,
          value: "Listener has repeated library evidence for SZA.",
          confidence: 0.84,
          evidenceCount: 4,
          evidenceRefs: ["track:s1"],
          updatedAt: "2026-06-03T01:02:03.000Z",
        },
      ].slice(0, limit),
  });
  store.saveArtifact("42", "user_profile.md", "# User Profile\nSZA", "taste-distiller/v2-compact");
  store.saveArtifact("42", "station_now.md", "# Station Now\nlate_night", "station-context/v1");
  store.saveArtifact("42", "program_contract.md", "# Program Contract\nlate-night R&B", "program-contract/v1");
  const programDirector = {
    plan: async () => ({
      id: "window-1",
      uid: "42",
      sessionId: 9,
      stationBrief: "Keep late-night R&B coherent.",
      mainDirection: "late-night R&B",
      allowedAdjacent: ["alt-R&B"],
      bridgeBudget: 1,
      disallowed: ["classical chamber music"],
      returnRequirement: "Return to vocal R&B.",
      candidateTasks: [{ query: "SZA Good Days", reason: "Known anchor.", style: "R&B", negativeConstraints: [] }],
      hostIntent: { shouldSpeak: false, event: "silent", reason: "ordinary continuation", text: "" },
      traceBasis: { profile: "SZA", now: "late_night", contract: "late-night R&B", eventType: "queue_low" },
      source: "model",
      createdAt: "2026-06-03T01:02:03.000Z",
    }),
  };

  const runtime = new RadioAgentRuntime({ mode: "assisted", store, programDirector, now: () => "2026-06-03T01:02:03.000Z" } as any);
  const result = await runtime.handle({ type: "queue_low", uid: "42", sessionId: 9, currentTrack: { id: "s1", name: "Good Days", artist: "SZA" } });

  assert.equal(result.controlsPlayback, false);
  assert.equal(result.programWindow?.candidateTasks[0]?.query, "SZA Good Days");
  assert.ok(store.decisions.some((decision) => decision.decisionType === "program_window"));
});

test("shadow mode records program windows but still never controls playback", async () => {
  const store = runtimeStore();
  const programDirector = {
    plan: async () => ({
      id: "window-1",
      uid: "42",
      sessionId: 9,
      stationBrief: "Shadow plan",
      mainDirection: "R&B",
      allowedAdjacent: [],
      bridgeBudget: 0,
      disallowed: [],
      returnRequirement: "",
      candidateTasks: [{ query: "SZA Good Days", reason: "Known anchor.", style: "R&B", negativeConstraints: [] }],
      hostIntent: { shouldSpeak: false, event: "silent", reason: "shadow", text: "" },
      traceBasis: { profile: "", now: "", contract: "", eventType: "queue_low" },
      source: "deterministic_fallback",
      createdAt: "2026-06-03T01:02:03.000Z",
    }),
  };

  const runtime = new RadioAgentRuntime({ mode: "shadow", store, programDirector, now: () => "2026-06-03T01:02:03.000Z" } as any);
  const result = await runtime.handle({ type: "queue_low", uid: "42", sessionId: 9 });

  assert.equal(result.controlsPlayback, false);
  assert.equal(result.programWindow?.source, "deterministic_fallback");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```powershell
npm run build:test
node --test dist/tests/ts/radio-agent-runtime.test.js
```

Expected: FAIL because runtime has no `programDirector` dependency and `RadioAgentHandleResult` has no `programWindow`.

- [ ] **Step 3: Extend runtime dependencies and result**

In `src/radio-agent/types.ts`, extend:

```ts
export interface RadioAgentHandleResult {
  controlsPlayback: boolean;
  event: RadioAgentEvent;
  hostDecision?: RadioHostDecision;
  programWindow?: RadioAgentProgramWindow;
}
```

In `RadioAgentRuntimeDeps`, add:

```ts
programDirector?: Pick<RadioAgentProgramDirector, "plan">;
```

Use an import type for `RadioAgentProgramDirector` to avoid runtime cycles.

- [ ] **Step 4: Build context and plan on queue pressure**

In `RadioAgentRuntime.handle()`:

- after station artifacts refresh, when event type is `queue_low`, call a new private `planProgramWindow(persistedEvent)`;
- for `track_completed`, call it only when payload has `queueLow === true` or ready queue count is zero;
- save the window as `decisionType: "program_window"`;
- return it in `RadioAgentHandleResult`;
- do not set `controlsPlayback` to true yet, even in assisted mode.

- [ ] **Step 5: Run runtime tests**

Run:

```powershell
npm run build:test
node --test dist/tests/ts/radio-agent-runtime.test.js
```

Expected: PASS.

- [ ] **Step 6: Commit**

```powershell
git add src/radio-agent/types.ts src/radio-agent/radioAgentRuntime.ts tests/ts/radio-agent-runtime.test.ts
git commit -m "Plan radio agent program windows"
```

## Task 4: Program Executor Tool Adapter

**Files:**
- Create: `src/radio-agent/programExecutor.ts`
- Modify: `src/radio-agent/types.ts`
- Test: `tests/ts/radio-agent-program-executor.test.ts`

- [ ] **Step 1: Write failing executor tests**

Create `tests/ts/radio-agent-program-executor.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";

import { RadioAgentProgramExecutor } from "../../src/radio-agent/programExecutor.js";
import type { RadioAgentProgramWindow } from "../../src/radio-agent/types.js";

const window: RadioAgentProgramWindow = {
  id: "window-1",
  uid: "42",
  sessionId: 9,
  stationBrief: "Keep late-night R&B coherent.",
  mainDirection: "late-night R&B",
  allowedAdjacent: ["alt-R&B"],
  bridgeBudget: 1,
  disallowed: ["classical chamber music"],
  returnRequirement: "Return to vocal R&B.",
  candidateTasks: [
    { query: "SZA Good Days", reason: "Known taste anchor.", style: "R&B", negativeConstraints: ["classical chamber music"] },
  ],
  hostIntent: { shouldSpeak: true, event: "return_to_contract", reason: "set station lane", text: "Keeping this close to your late-night R&B lane." },
  traceBasis: { profile: "SZA", now: "late_night", contract: "late-night R&B", eventType: "queue_low" },
  source: "model",
  createdAt: "2026-06-03T01:02:03.000Z",
};

test("program executor verifies the first candidate through search tools", async () => {
  const verifier = {
    verify: async (task: any) => {
      assert.equal(task.searchGoals[0], "SZA Good Days");
      assert.deepEqual(task.negativeConstraints, ["classical chamber music"]);
      return {
        status: "verified",
        selectedSong: { id: "s1", name: "Good Days", artist: "SZA" },
        url: "/api/radio/audio/s1",
        verification: { confidence: 0.8, versionNote: "matched" },
        fallbackCandidates: [],
        recoveryOptions: [],
        usedQuery: "SZA Good Days",
      };
    },
  };

  const executor = new RadioAgentProgramExecutor(verifier as any, () => "trace-1");
  const prepared = await executor.prepareFirstPlayable(window);

  assert.equal(prepared?.track.id, "s1");
  assert.equal(prepared?.url, "/api/radio/audio/s1");
  assert.equal(prepared?.selectionReason.type, "radio_agent_program");
  assert.equal(prepared?.selectionReason.traceId, "trace-1");
  assert.equal(prepared?.segueText, "Keeping this close to your late-night R&B lane.");
  assert.equal(prepared?.decisionTrace.id, "trace-1");
});

test("program executor returns null when no candidate verifies", async () => {
  const verifier = {
    verify: async () => ({
      status: "not_found",
      verification: {},
      fallbackCandidates: [],
      recoveryOptions: [],
      failureReason: "none",
    }),
  };

  const executor = new RadioAgentProgramExecutor(verifier as any, () => "trace-2");
  const prepared = await executor.prepareFirstPlayable(window);

  assert.equal(prepared, null);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```powershell
npm run build:test
node --test dist/tests/ts/radio-agent-program-executor.test.js
```

Expected: FAIL because `programExecutor.ts` does not exist.

- [ ] **Step 3: Add prepared-track type**

In `src/radio-agent/types.ts`, add:

```ts
export interface RadioAgentPreparedTrack {
  track: Track;
  url: string;
  selectionReason: SelectionReason;
  segueText: string;
  decisionTrace: DecisionTrace;
}
```

Import `SelectionReason` from `../types.js` and `DecisionTrace` from `../radio/radioBrainTypes.js`.

- [ ] **Step 4: Implement executor**

In `src/radio-agent/programExecutor.ts`:

- Convert `RadioAgentCandidateTask` to `MusicTask`:
  - `type: "scene_genre_direction"` unless query looks like a specific artist-title pair, then `specific_track`;
  - `styleHint` from task style plus window main direction;
  - `negativeConstraints` from task plus window disallowed;
  - `searchGoals: [task.query]`;
  - `mustNotSearchLiteralUserSentence: true`.
- Call `SearchVerifyAgent.verify(task, uid, stationBrief)`.
- Return the first verified/playable result.
- Attach `SelectionReason`:
  - `type: "radio_agent_program"`;
  - `text: task.reason || window.stationBrief`;
  - `understoodIntent: window.stationBrief`;
  - `traceId`.
- Create a legacy-compatible `DecisionTrace` so the existing explanation path can use it.
- Use host intent text as `segueText` only when `hostIntent.shouldSpeak` is true and text is not internal.

- [ ] **Step 5: Run executor tests**

Run:

```powershell
npm run build:test
node --test dist/tests/ts/radio-agent-program-executor.test.js
```

Expected: PASS.

- [ ] **Step 6: Commit**

```powershell
git add src/radio-agent/types.ts src/radio-agent/programExecutor.ts tests/ts/radio-agent-program-executor.test.ts
git commit -m "Add radio agent program executor"
```

## Task 5: Assisted Mode Configuration and Server Wiring

**Files:**
- Modify: `src/config.ts`
- Modify: `src/server.ts`
- Modify: `tests/ts/radio-agent-server-wiring.test.ts`
- Test: `tests/ts/runtime-status.test.ts`

- [ ] **Step 1: Write failing config and wiring tests**

In `tests/ts/radio-agent-server-wiring.test.ts`, update or add:

```ts
test("server wires assisted radio agent planning before legacy station director fallback", () => {
  const source = fs.readFileSync("src/server.ts", "utf8");

  assert.match(source, /RadioAgentProgramDirector/);
  assert.match(source, /RadioAgentProgramExecutor/);
  assert.match(source, /config\.radioAgentMode/);
  assert.match(source, /tryRadioAgentAssistedQueue/);
  assert.match(source, /stationDirector\.pickNext/);
  assert.ok(source.indexOf("tryRadioAgentAssistedQueue") < source.indexOf("stationDirector.pickNext"));
});
```

In `tests/ts/runtime-status.test.ts`, add a source or config test that verifies `RADIO_AGENT_MODE` is surfaced without secrets if that file already covers runtime config. If the existing test is not suitable, create `tests/ts/radio-agent-config.test.ts` instead:

```ts
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

test("config exposes radio agent mode from environment", () => {
  const source = fs.readFileSync("src/config.ts", "utf8");

  assert.match(source, /RADIO_AGENT_MODE/);
  assert.match(source, /radioAgentMode/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```powershell
npm run build:test
node --test dist/tests/ts/radio-agent-server-wiring.test.js dist/tests/ts/runtime-status.test.js
```

Expected: FAIL because server does not wire the director/executor and config has no `radioAgentMode`.

- [ ] **Step 3: Add config**

In `src/config.ts`, add a helper:

```ts
function radioAgentModeEnv(): "shadow" | "assisted" | "active" {
  const value = (process.env.RADIO_AGENT_MODE || "shadow").toLowerCase();
  return value === "assisted" || value === "active" ? value : "shadow";
}
```

Add to config:

```ts
radioAgentMode: radioAgentModeEnv(),
```

Default remains `shadow` until assisted mode has live smoke evidence. Local smoke should start with `RADIO_AGENT_MODE=assisted`.

- [ ] **Step 4: Instantiate director and executor in `src/server.ts`**

Add imports:

```ts
import { RadioAgentProgramDirector } from "./radio-agent/programDirector.js";
import { RadioAgentProgramExecutor } from "./radio-agent/programExecutor.js";
```

Instantiate after `llm` and `searchVerifyAgent` exist. If constructor order needs adjustment, move `llm`, `searchVerifyAgent`, and related dependencies above runtime construction:

```ts
const radioAgentProgramDirector = new RadioAgentProgramDirector(llm);
const radioAgentProgramExecutor = new RadioAgentProgramExecutor(searchVerifyAgent);
const radioAgent = new RadioAgentRuntime({
  mode: config.radioAgentMode,
  store: radioAgentStore,
  census: libraryCensus,
  programDirector: radioAgentProgramDirector,
});
```

Keep `RadioAgentRuntime` independent from `RadioAgentProgramExecutor`; runtime plans, server executes tools.

- [ ] **Step 5: Add `tryRadioAgentAssistedQueue` helper inside `handleRadioSocket`**

Near `fillQueue`, add:

```ts
const tryRadioAgentAssistedQueue = async (): Promise<boolean> => {
  if (config.radioAgentMode !== "assisted" && config.radioAgentMode !== "active") return false;
  const result = await radioAgent.handle({
    type: "queue_low",
    uid,
    sessionId,
    currentTrack: currentTrack ? trackInfo(currentTrack) : null,
    readyQueue: queue.readyItems().map((item) => trackInfo(item.track)),
  }).catch(() => null);
  if (!result?.programWindow) return false;
  const prepared = await radioAgentProgramExecutor.prepareFirstPlayable(result.programWindow).catch(() => null);
  if (!prepared) return false;
  traceStore.save(prepared.decisionTrace);
  const ttsHash = prepared.segueText ? await synthesize(prepared.segueText).catch(() => "") : "";
  queue.addReady(prepared.track, prepared.url, prepared.selectionReason, {
    segueText: prepared.segueText,
    ttsHash,
  });
  return true;
};
```

Then in `fillQueue()`, before `stationDirector.pickNext(...)`, call:

```ts
if (await tryRadioAgentAssistedQueue()) {
  added += 1;
  continue;
}
```

- [ ] **Step 6: Preserve fallback behavior**

If assisted agent returns no window, verifier fails, TTS fails, or trace save throws, log a playback event and continue to the existing `stationDirector.pickNext()` path.

Do not let a radio-agent error break playback.

- [ ] **Step 7: Run wiring and server tests**

Run:

```powershell
npm run build:test
node --test dist/tests/ts/radio-agent-server-wiring.test.js dist/tests/ts/runtime-status.test.js
```

Expected: PASS.

- [ ] **Step 8: Commit**

```powershell
git add src/config.ts src/server.ts tests/ts/radio-agent-server-wiring.test.ts tests/ts/runtime-status.test.ts
git commit -m "Wire assisted radio agent planning"
```

## Task 6: Agent Trace Explanation Compatibility

**Files:**
- Modify: `src/radio-agent/programExecutor.ts`
- Modify: `tests/ts/host-responder.test.ts` or create `tests/ts/radio-agent-explanation.test.ts`

- [ ] **Step 1: Write failing trace compatibility test**

Create `tests/ts/radio-agent-explanation.test.ts` if no existing test fits:

```ts
import assert from "node:assert/strict";
import test from "node:test";

import { explanationFromTrace } from "../../src/radio/hostResponder.js";
import type { DecisionTrace } from "../../src/radio/radioBrainTypes.js";

test("agent-owned traces can explain the selected track", () => {
  const trace: DecisionTrace = {
    id: "trace-1",
    uid: "42",
    sessionId: 9,
    episodeId: "window-1",
    intentType: "autoplay",
    profileQuality: { level: "strong", score: 0.9, reasons: ["durable profile"] },
    environment: { scene: "late night", localTimeBlock: "late_night", summary: "late night" },
    selectedTrack: { id: "s1", name: "Good Days", artist: "SZA" },
    reason: "Known taste anchor inside the current late-night R&B program.",
    rejectedCandidates: [],
    verificationAttempts: ["SZA Good Days"],
    fallbackLevel: "episode_primary",
    latencyMs: { radioAgent: 12 },
    hostText: "Keeping this close to your late-night R&B lane.",
    createdAt: "2026-06-03T01:02:03.000Z",
  };

  const text = explanationFromTrace(trace as any, { id: "s1", name: "Good Days", artist: "SZA" });

  assert.match(text, /Good Days|SZA|late-night R&B/i);
  assert.doesNotMatch(text, /candidate|trace|verification|model|JSON/i);
});
```

If `explanationFromTrace` is not exported, either export a small pure helper from `hostResponder.ts` or test the existing public responder API.

- [ ] **Step 2: Run tests to verify they fail**

Run:

```powershell
npm run build:test
node --test dist/tests/ts/radio-agent-explanation.test.js
```

Expected: FAIL until the helper is exported or agent trace fields are compatible.

- [ ] **Step 3: Ensure executor trace shape is explanation-safe**

In `programExecutor.ts`, make sure `DecisionTrace.reason` is listener-facing:

- include the candidate task reason;
- include the station brief;
- do not include internal terms;
- include `verificationAttempts` from searched query;
- set `episodeId` to the program window id;
- set `fallbackLevel` to `episode_primary` for the first candidate and `episode_backup` for later attempts when added.

- [ ] **Step 4: Run explanation tests**

Run:

```powershell
npm run build:test
node --test dist/tests/ts/radio-agent-explanation.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add src/radio-agent/programExecutor.ts src/radio/hostResponder.ts tests/ts/radio-agent-explanation.test.ts
git commit -m "Make radio agent traces explainable"
```

## Task 7: Assisted Smoke Checklist

**Files:**
- Create: `docs/superpowers/checklists/2026-06-03-hermes-radio-agent-assisted-smoke.md`

- [ ] **Step 1: Create manual smoke checklist**

Create:

```md
# Hermes Radio Agent Assisted Smoke

- [ ] Start from `C:\Users\lacr1\Desktop\AI音乐\.worktrees\hermes-radio-agent-service`.
- [ ] Use the main project data and env.
- [ ] Set `RADIO_AGENT_MODE=assisted`.
- [ ] Start the TypeScript backend on `http://127.0.0.1:8000/`.
- [ ] Open the app and restore/login as the saved NetEase user.
- [ ] Confirm first music starts quickly.
- [ ] Confirm `/api/radio/agent/status?uid=<uid>` reports mode `assisted`.
- [ ] Let the queue drain or skip until `queue_low` is mirrored.
- [ ] Confirm a `program_window` decision appears in recent agent decisions.
- [ ] Confirm a queued track has selection reason type `radio_agent_program` when assisted planning succeeds.
- [ ] Confirm playback continues through legacy fallback when assisted planning fails.
- [ ] Confirm any host line is short and contains no internal terms.
- [ ] Ask "why this song?"
- [ ] Confirm the answer uses the agent trace or falls back gracefully.
- [ ] Restart server.
- [ ] Confirm durable profile artifacts remain available.
```

- [ ] **Step 2: Run markdown diff check**

Run:

```powershell
git diff --check
```

Expected: no whitespace errors.

- [ ] **Step 3: Commit**

```powershell
git add docs/superpowers/checklists/2026-06-03-hermes-radio-agent-assisted-smoke.md
git commit -m "Add assisted radio agent smoke checklist"
```

## Task 8: Final Verification and Local Assisted Run

**Files:**
- Modify only if verification exposes a bug.

- [ ] **Step 1: Run targeted tests**

Run:

```powershell
npm run build:test
node --test `
  dist/tests/ts/radio-agent-context.test.js `
  dist/tests/ts/radio-agent-program-director.test.js `
  dist/tests/ts/radio-agent-runtime.test.js `
  dist/tests/ts/radio-agent-program-executor.test.js `
  dist/tests/ts/radio-agent-server-wiring.test.js `
  dist/tests/ts/radio-agent-explanation.test.js
```

Expected: all targeted tests pass.

- [ ] **Step 2: Run full TypeScript checks**

Run:

```powershell
npm run typecheck
npm test
npm run build
```

Expected: exit code 0 for all commands.

- [ ] **Step 3: Restart local service in assisted mode**

Stop whatever owns port 8000, then start:

```powershell
$cmd = @'
$env:DATA_DIR = 'C:\Users\lacr1\Desktop\AI音乐\data'
$env:RADIO_DB_PATH = 'C:\Users\lacr1\Desktop\AI音乐\data\freqme.db'
$env:NETEASE_COOKIE_PATH = 'C:\Users\lacr1\Desktop\AI音乐\data\netease-cookie.json'
$env:RADIO_AGENT_MODE = 'assisted'
& node.exe -r dotenv/config dist/src/server.js dotenv_config_path='C:\Users\lacr1\Desktop\AI音乐\.env'
'@
Start-Process -FilePath "powershell.exe" -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", $cmd) -WorkingDirectory (Get-Location) -WindowStyle Hidden -PassThru
```

- [ ] **Step 4: Verify assisted status**

Run:

```powershell
Invoke-WebRequest -UseBasicParsing 'http://127.0.0.1:8000/api/radio/agent/status?uid=51992124' -TimeoutSec 20 | Select-Object -ExpandProperty Content
```

Expected:

- JSON includes `"mode":"assisted"`;
- artifacts remain present;
- recent decisions can include `program_window` after playback reaches queue pressure.

- [ ] **Step 5: Manual browser smoke**

Use the in-app browser at `http://127.0.0.1:8000/`.

Expected:

- playback starts quickly;
- queue continues when assisted agent succeeds;
- fallback continues when assisted agent fails;
- no frontend console errors introduced by this work;
- host speech, if present, is natural and short.

- [ ] **Step 6: Final commit if verification required fixes**

Only commit if verification changed files.

## Review Note

The writing-plans workflow normally dispatches a plan-document-reviewer subagent. In this Codex thread, subagents may only be spawned when the user explicitly asks for sub-agents, delegation, or parallel agent work. If the user asks for it, dispatch one reviewer with:

- plan: `docs/superpowers/plans/2026-06-03-hermes-radio-agent-phase2-plan.md`
- spec: `docs/superpowers/specs/2026-06-03-hermes-radio-agent-target-design.md`

Until then, use local review plus the verification commands above.
