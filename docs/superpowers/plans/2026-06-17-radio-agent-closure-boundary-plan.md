# Radio Agent Closure Boundary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Hermes-style radio agent the only normal playback decision center by extracting typed action execution from `src/server.ts`, ensuring legacy playback can only produce governed fallback candidates, and adding tests that prevent hidden second-DJ paths from returning.

**Architecture:** Keep the existing useful assets: `RadioAgentRuntime`, `RadioAgentService`, `RadioAgentProgramDirector`, `RadioAgentProgramExecutor`, `PlaybackGovernor`, NetEase/audio services, and current queue infrastructure. Add a narrow `RadioAgentActionRunner` for non-fallback action execution, add `LegacyFallbackTools` as candidate-producing adapters that cannot mutate playback directly, then wire `server.ts` so any legacy candidate must become an approved `play_now` action through `PlaybackGovernor` before entering the queue.

**Tech Stack:** TypeScript ESM, Node `node:test`, `npx tsx --test` for TS tests, `node --test` for JS tests, `npm run typecheck`, and `npm test` for full regression.

---

## Scope

This plan implements the first closure slice from:

- `docs/superpowers/specs/2026-06-17-radio-agent-closure-audit-design.md`

In scope:

- Action runner boundary for non-fallback actions.
- Governed legacy fallback tools that return typed actions or failure, never direct queue mutations.
- Server session-start, user-text, correction, track-end, and queue-low paths routed through the new boundaries.
- Behavior tests for fallback governance, stale request tokens, no hidden queue mutation, correction routing, queue-low routing, and explicit fallback trace visibility.
- A boundary guard that catches direct legacy planner calls outside approved fallback adapters.

Out of scope:

- full style intent registry;
- memory curator extraction;
- host controller rewrite;
- broad browser/live-smoke automation;
- deletion of all legacy radio code.

## Reviewer Fixes Applied

This plan was reviewed once and rewritten to address the high-risk issues:

- Legacy fallback tools must not call `queue.addReady`, `fillQueue`, `radioBrain`, `stationDirector`, or scheduler in a way that mutates playback directly.
- Fallback candidates must pass `PlaybackGovernor` under the active contract before becoming `play_now`.
- `ActionRunner` must not execute fallback with insufficient context.
- Server wiring string tests are allowed only as coarse guards; core guarantees need behavior tests with injected fakes.
- `queue_window` semantics are narrowed: the runner may enqueue already-prepared tracks only, and may not select new tracks.
- Host text attached to `play_now` must be treated as already-approved by service/governor or filtered before queueing.
- Contract conversion must reuse existing helpers or be covered by tests before use.
- Correction and queue-low must be explicit ownership gates, not incidental cases hidden inside `song_request` or `track_ended` code.

## File Structure

Create:

- `src/radio-agent/actionRunner.ts`
  - Executes typed non-fallback `RadioAgentAction[]` into injected queue/speech/status callbacks.
  - Refuses direct fallback execution. It may report fallback intent, but cannot call legacy systems.
  - Does not import `server.ts`, `PlaybackQueue`, `RadioBrain`, `AIStationDirector`, or scheduler.

- `tests/ts/radio-agent-action-runner.test.ts`
  - Behavior tests for action order, `play_now`, `queue_window` prepared-track semantics, `speak`, `honest_not_found`, and fallback refusal.

- `src/radio-agent/legacyFallbackTools.ts`
  - Wraps legacy candidate sources as adapters.
  - Calls an injected `governCandidate` before returning a playable action.
  - Returns `play_now`, `honest_not_found`, `empty`, or `stale`.
  - Cannot mutate queue or send websocket messages.

- `tests/ts/radio-agent-legacy-fallback-tools.test.ts`
  - Behavior tests for accepted governed fallback, rejected fallback, stale token, empty fallback, and no queue mutation.

- `tests/ts/radio-agent-boundary-ownership.test.ts`
  - Boundary guard for forbidden direct calls to legacy planners/schedulers outside allowlisted fallback adapter modules.

Modify:

- `src/radio-agent/agentActions.ts`
  - Add fallback context fields only if needed by service decisions.
  - Avoid broad type churn.

- `src/radio-agent/radioAgentService.ts`
  - Keep producing typed actions.
  - Ensure fallback actions are descriptive and do not imply direct legacy execution.

- `src/server.ts`
  - Use `runRadioAgentActions` for agent-approved session-start, user-text, correction, track-end, and queue-low actions.
  - Use `LegacyFallbackTools` to transform fallback intent into a governed typed action.
  - Remove normal-path direct legacy planner calls after agent decisions.

- `tests/ts/radio-agent-server-wiring.test.ts`
  - Keep coarse wiring checks only.
  - Add targeted checks that correction and queue-low paths execute service actions through the action runner boundary.
  - Remove or weaken brittle assertions when behavior tests cover the guarantee.

- `tests/ts/radio-agent-service.test.ts`
  - Add or adjust service action-shape tests for user text, correction, and queue-low using existing fixtures.

- `tests/js/radio-websocket.test.mjs`
  - Keep frontend retry/status behavior stable if message shape changes.

## Implementation Rules

- Use @superpowers:test-driven-development for every behavior change.
- Write a failing test before production code.
- Do not start the local dev server unless a later plan explicitly asks for browser verification.
- Do not run the old live-smoke loop.
- Do not add genre-specific patches.
- Do not stage logs, `.codex-server.log`, `dev-server*.log`, or `tmp-*`.
- Commit after each completed task with fresh verification evidence.
- Do not claim Hermes Radio Agent Closure Candidate from this slice.

## Task 0: Verify Test Command Conventions

**Files:**

- Read: `package.json`
- Read: `tests/ts/radio-agent-service.test.ts`
- Read: `tests/js/radio-websocket.test.mjs`

- [ ] **Step 1: Confirm current scripts**

Run:

```bash
Get-Content -Raw package.json
```

Expected:

- `typecheck` exists.
- `test` exists.
- Existing TS tests can be run with `npx tsx --test`.
- Existing JS tests can be run with `node --test`.

- [ ] **Step 2: Run a known passing focused TS test**

Run:

```bash
npx tsx --test tests/ts/radio-agent-service.test.ts
```

Expected:

- PASS before changes. If it fails before changes, stop and diagnose baseline.

- [ ] **Step 3: Run a known passing JS test file**

Run:

```bash
node --test tests/js/radio-websocket.test.mjs
```

Expected:

- PASS before changes. If it fails before changes, stop and diagnose baseline.

## Task 1: Add Non-Fallback RadioAgentActionRunner

**Files:**

- Create: `src/radio-agent/actionRunner.ts`
- Create: `tests/ts/radio-agent-action-runner.test.ts`
- Read: `src/radio-agent/agentActions.ts`
- Read: `src/radio-agent/hostDelivery.ts`

- [ ] **Step 1: Write failing test for `play_now` execution**

Create `tests/ts/radio-agent-action-runner.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";

import { runRadioAgentActions } from "../../src/radio-agent/actionRunner.js";
import type { RadioAgentAction } from "../../src/radio-agent/agentActions.js";

function deps(calls: string[] = []) {
  return {
    queuePlayNow: async ({ track, url, reason, hostText }: any) => {
      calls.push(`queue:${track.id}:${url}:${reason.type}:${hostText}`);
    },
    queuePrepared: async ({ prepared }: any) => {
      calls.push(`prepared:${prepared.track.id}`);
    },
    speak: async ({ text }: any) => calls.push(`speak:${text}`),
    staySilent: async ({ reason }: any) => calls.push(`silent:${reason}`),
    reportNotFound: async ({ reason }: any) => calls.push(`not-found:${reason}`),
    reportFallback: async ({ level, reason }: any) => calls.push(`fallback:${level}:${reason}`),
  };
}

test("action runner queues a play_now action without choosing music", async () => {
  const calls: string[] = [];
  const actions: RadioAgentAction[] = [
    {
      type: "play_now",
      track: { id: "track-1", name: "Song", artist: "Artist" },
      url: "/api/radio/audio/track-1",
      reason: { type: "radio_agent_program", text: "Agent approved." },
      hostText: "Short handoff.",
    },
  ];

  const result = await runRadioAgentActions(actions, deps(calls));

  assert.deepEqual(calls, ["queue:track-1:/api/radio/audio/track-1:radio_agent_program:Short handoff."]);
  assert.deepEqual(result.executedTypes, ["play_now"]);
  assert.equal(result.playbackQueued, true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
npx tsx --test tests/ts/radio-agent-action-runner.test.ts
```

Expected:

- FAIL because `src/radio-agent/actionRunner.ts` does not exist.

- [ ] **Step 3: Implement minimal non-fallback action runner**

Create `src/radio-agent/actionRunner.ts`:

```ts
import type { SelectionReason, Track } from "../types.js";
import type { AgentActionContract, FallbackLevel, RadioAgentAction } from "./agentActions.js";
import type { PlaybackGovernanceTrace } from "./playbackGovernor.js";
import type { RadioAgentPreparedTrack } from "./types.js";

type SpeechRole = Extract<RadioAgentAction, { type: "speak" }>["speechRole"];

export interface RadioAgentActionRunnerDeps {
  queuePlayNow(args: {
    track: Track;
    url: string;
    reason: SelectionReason;
    hostText: string;
    governanceTrace?: PlaybackGovernanceTrace;
  }): Promise<void> | void;
  queuePrepared?(args: { prepared: RadioAgentPreparedTrack; windowId: string }): Promise<void> | void;
  speak(args: { text: string; speechRole: SpeechRole }): Promise<void> | void;
  staySilent(args: { reason: string }): Promise<void> | void;
  repairContract?(args: { contract: Extract<RadioAgentAction, { type: "repair_contract" }>["contract"]; reason: string }): Promise<void> | void;
  reportNotFound(args: {
    contract: AgentActionContract | null;
    reason: string;
    searchedQueries: string[];
    governanceTrace?: PlaybackGovernanceTrace;
  }): Promise<void> | void;
  reportFallback(args: { level: FallbackLevel; reason: string; action?: RadioAgentAction }): Promise<void> | void;
}

export interface RadioAgentActionRunnerResult {
  executedTypes: RadioAgentAction["type"][];
  playbackQueued: boolean;
  preparedQueued: number;
  spoke: boolean;
  notFound: boolean;
  fallbackLevels: FallbackLevel[];
}

export async function runRadioAgentActions(
  actions: RadioAgentAction[],
  deps: RadioAgentActionRunnerDeps,
): Promise<RadioAgentActionRunnerResult> {
  const result: RadioAgentActionRunnerResult = {
    executedTypes: [],
    playbackQueued: false,
    preparedQueued: 0,
    spoke: false,
    notFound: false,
    fallbackLevels: [],
  };

  for (const action of actions) {
    result.executedTypes.push(action.type);

    if (action.type === "play_now") {
      await deps.queuePlayNow({
        track: action.track,
        url: action.url,
        reason: action.reason,
        hostText: action.hostText || "",
        governanceTrace: action.governanceTrace,
      });
      result.playbackQueued = true;
      continue;
    }

    if (action.type === "queue_window") {
      for (const prepared of action.prepared) {
        await deps.queuePrepared?.({ prepared, windowId: action.window.id });
        result.preparedQueued += 1;
      }
      continue;
    }

    if (action.type === "speak") {
      await deps.speak({ text: action.text, speechRole: action.speechRole });
      result.spoke = true;
      continue;
    }

    if (action.type === "stay_silent") {
      await deps.staySilent({ reason: action.reason });
      continue;
    }

    if (action.type === "repair_contract") {
      await deps.repairContract?.({ contract: action.contract, reason: action.reason });
      continue;
    }

    if (action.type === "honest_not_found") {
      await deps.reportNotFound({
        contract: action.contract,
        reason: action.reason,
        searchedQueries: action.searchedQueries,
        governanceTrace: action.governanceTrace,
      });
      result.notFound = true;
      continue;
    }

    await deps.reportFallback({ level: action.level, reason: action.reason, action: action.action });
    result.fallbackLevels.push(action.level);
  }

  return result;
}
```

Important:

- `fallback` is reported only. The runner must not call legacy systems.
- `queue_window` queues only `prepared` tracks supplied by the action. It must not call a planner, verifier, resolver, or window executor.

- [ ] **Step 4: Run test to verify it passes**

Run:

```bash
npx tsx --test tests/ts/radio-agent-action-runner.test.ts
```

Expected:

- PASS for the first test.

- [ ] **Step 5: Add behavior tests for action order, prepared queue, not-found, and fallback refusal**

Append tests:

```ts
test("action runner preserves speak before play order", async () => {
  const calls: string[] = [];
  await runRadioAgentActions(
    [
      { type: "speak", text: "Got it.", speechRole: "ack" },
      {
        type: "play_now",
        track: { id: "track-2", name: "Next", artist: "Artist" },
        url: "/api/radio/audio/track-2",
        reason: { type: "radio_agent_program", text: "Approved." },
      },
    ],
    deps(calls),
  );

  assert.deepEqual(calls, ["speak:Got it.", "queue:track-2:/api/radio/audio/track-2:radio_agent_program:"]);
});

test("action runner queues only prepared tracks from queue_window", async () => {
  const calls: string[] = [];
  await runRadioAgentActions(
    [
      {
        type: "queue_window",
        window: {
          id: "window-1",
          uid: "42",
          sessionId: 7,
          stationBrief: "Brief.",
          mainDirection: "quiet",
          allowedAdjacent: [],
          bridgeBudget: 0,
          disallowed: [],
          returnRequirement: "Stay quiet.",
          candidateTasks: [{ query: "should not execute", reason: "data only", style: "quiet", negativeConstraints: [] }],
          hostIntent: { shouldSpeak: false, event: "silent", reason: "test", text: "" },
          traceBasis: { profile: "", now: "", contract: "", eventType: "queue_low" },
          source: "deterministic_fallback",
          createdAt: "2026-06-17T00:00:00.000Z",
        },
        prepared: [
          {
            track: { id: "prepared-1", name: "Prepared", artist: "Artist" },
            url: "/api/radio/audio/prepared-1",
            selectionReason: { type: "radio_agent_program", text: "Already prepared." },
            segueText: "",
            decisionTrace: { id: "trace-1", trackId: "prepared-1", source: "radio_agent", reason: "Already prepared.", createdAt: "2026-06-17T00:00:00.000Z" },
          },
        ],
      },
    ],
    deps(calls),
  );

  assert.deepEqual(calls, ["prepared:prepared-1"]);
});

test("action runner reports honest_not_found without queue mutation", async () => {
  const calls: string[] = [];
  const result = await runRadioAgentActions(
    [{ type: "honest_not_found", contract: null, reason: "reject_off_contract", searchedQueries: ["bad query"] }],
    deps(calls),
  );

  assert.deepEqual(calls, ["not-found:reject_off_contract"]);
  assert.equal(result.notFound, true);
  assert.equal(result.playbackQueued, false);
});

test("action runner reports fallback but does not execute legacy playback", async () => {
  const calls: string[] = [];
  const result = await runRadioAgentActions(
    [{ type: "fallback", level: "legacy_with_label", reason: "agent_timeout" }],
    deps(calls),
  );

  assert.deepEqual(calls, ["fallback:legacy_with_label:agent_timeout"]);
  assert.deepEqual(result.fallbackLevels, ["legacy_with_label"]);
  assert.equal(result.playbackQueued, false);
});
```

- [ ] **Step 6: Run action runner tests**

Run:

```bash
npx tsx --test tests/ts/radio-agent-action-runner.test.ts
```

Expected:

- PASS.

- [ ] **Step 7: Run typecheck**

Run:

```bash
npm run typecheck
```

Expected:

- PASS.

- [ ] **Step 8: Commit**

Run:

```bash
git add src/radio-agent/actionRunner.ts tests/ts/radio-agent-action-runner.test.ts
git commit -m "Add radio agent action runner boundary"
```

## Task 2: Add Governed Legacy Fallback Tools

**Files:**

- Create: `src/radio-agent/legacyFallbackTools.ts`
- Create: `tests/ts/radio-agent-legacy-fallback-tools.test.ts`
- Read: `src/radio-agent/playbackGovernor.ts`
- Read: `src/radio-agent/agentActions.ts`

- [ ] **Step 1: Write failing tests for governed fallback**

Create `tests/ts/radio-agent-legacy-fallback-tools.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";

import { createLegacyFallbackTools } from "../../src/radio-agent/legacyFallbackTools.js";
import type { Track } from "../../src/types.js";

test("legacy fallback converts an accepted governed candidate into play_now", async () => {
  const calls: string[] = [];
  const candidate: Track = { id: "safe-1", name: "Safe Song", artist: "Safe Artist" };
  const tools = createLegacyFallbackTools({
    candidateSource: async ({ reason }) => {
      calls.push(`candidate:${reason}`);
      return {
        track: candidate,
        url: "/api/radio/audio/safe-1",
        reason: { type: "radio_agent_legacy_fallback", text: "Legacy fallback candidate." },
      };
    },
    governCandidate: async ({ candidate, fallbackLevel }) => {
      calls.push(`govern:${candidate.id}:${fallbackLevel}`);
      return {
        status: "accepted",
        track: candidate,
        url: "/api/radio/audio/safe-1",
        trace: {
          status: "accepted",
          contractId: "contract-1",
          requestToken: 3,
          candidateKey: "safeartist::safesong",
          decision: "direct_positive",
          evidence: ["legacy candidate passed active contract"],
          fallbackLevel: "legacy_with_label",
        },
      };
    },
  });

  const result = await tools.fallbackToAction({
    source: "track_end",
    level: "legacy_with_label",
    reason: "queue_empty",
    activeRequestToken: 3,
    contract: { id: "contract-1", mainDirection: "quiet", allowedAdjacent: [], disallowed: [] },
    currentTrack: null,
    recentTracks: [],
    readyQueue: [],
  });

  assert.deepEqual(calls, ["candidate:queue_empty", "govern:safe-1:legacy_with_label"]);
  assert.equal(result.status, "action");
  assert.equal(result.action.type, "play_now");
  if (result.action.type !== "play_now") throw new Error("expected play_now");
  assert.equal(result.action.track.id, "safe-1");
  assert.equal(result.action.governanceTrace?.fallbackLevel, "legacy_with_label");
});

test("legacy fallback rejection returns honest_not_found and does not enqueue", async () => {
  const calls: string[] = [];
  const tools = createLegacyFallbackTools({
    candidateSource: async () => ({
      track: { id: "bad-1", name: "Off Contract", artist: "Wrong Artist" },
      url: "/api/radio/audio/bad-1",
      reason: { type: "radio_agent_legacy_fallback", text: "Legacy fallback candidate." },
    }),
    governCandidate: async ({ candidate }) => {
      calls.push(`govern:${candidate.id}`);
      return {
        status: "rejected",
        reason: "reject_off_contract",
        trace: {
          status: "rejected",
          contractId: "contract-1",
          requestToken: 3,
          candidateKey: "wrongartist::offcontract",
          decision: "reject_off_contract",
          evidence: ["candidate violates active contract"],
          fallbackLevel: "legacy_with_label",
        },
      };
    },
  });

  const result = await tools.fallbackToAction({
    source: "request",
    level: "legacy_with_label",
    reason: "agent_timeout",
    requestText: "play quiet jazz",
    activeRequestToken: 3,
    contract: { id: "contract-1", mainDirection: "quiet jazz", allowedAdjacent: [], disallowed: ["wrong artist"] },
    currentTrack: null,
    recentTracks: [],
    readyQueue: [],
  });

  assert.deepEqual(calls, ["govern:bad-1"]);
  assert.equal(result.status, "action");
  assert.equal(result.action.type, "honest_not_found");
  if (result.action.type !== "honest_not_found") throw new Error("expected honest_not_found");
  assert.equal(result.action.reason, "reject_off_contract");
  assert.equal(result.action.governanceTrace?.decision, "reject_off_contract");
});

test("legacy fallback ignores stale request token before candidate lookup", async () => {
  const calls: string[] = [];
  const tools = createLegacyFallbackTools({
    candidateSource: async () => {
      calls.push("candidate");
      return null;
    },
    governCandidate: async () => {
      calls.push("govern");
      throw new Error("should not govern stale fallback");
    },
  });

  const result = await tools.fallbackToAction({
    source: "request",
    level: "legacy_with_label",
    reason: "agent_timeout",
    requestText: "play quiet jazz",
    activeRequestToken: 5,
    expectedRequestToken: 4,
    contract: null,
    currentTrack: null,
    recentTracks: [],
    readyQueue: [],
  });

  assert.deepEqual(calls, []);
  assert.equal(result.status, "stale");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
npx tsx --test tests/ts/radio-agent-legacy-fallback-tools.test.ts
```

Expected:

- FAIL because `legacyFallbackTools.ts` does not exist.

- [ ] **Step 3: Implement candidate-producing fallback tools**

Create `src/radio-agent/legacyFallbackTools.ts`:

```ts
import type { SelectionReason, Track } from "../types.js";
import type { AgentActionContract, FallbackLevel, RadioAgentAction } from "./agentActions.js";
import type { PlaybackGovernorResult } from "./playbackGovernor.js";

export type LegacyFallbackSource = "opening" | "request" | "correction" | "track_end" | "continuation";

export interface LegacyFallbackCandidate {
  track: Track;
  url: string;
  reason: SelectionReason;
  hostText?: string;
}

export interface LegacyFallbackContext {
  source: LegacyFallbackSource;
  level: FallbackLevel;
  reason: string;
  requestText?: string;
  activeRequestToken?: number | null;
  expectedRequestToken?: number | null;
  contract: AgentActionContract | null;
  currentTrack: Track | null;
  recentTracks: Track[];
  readyQueue: Track[];
}

export type LegacyFallbackResult =
  | { status: "action"; action: RadioAgentAction }
  | { status: "empty"; reason: string }
  | { status: "stale" };

export interface LegacyFallbackToolsDeps {
  candidateSource(context: LegacyFallbackContext): Promise<LegacyFallbackCandidate | null>;
  governCandidate(args: {
    context: LegacyFallbackContext;
    candidate: Track;
    url: string;
    fallbackLevel: FallbackLevel;
    hostText?: string;
  }): Promise<PlaybackGovernorResult>;
}

export interface LegacyFallbackTools {
  fallbackToAction(context: LegacyFallbackContext): Promise<LegacyFallbackResult>;
}

export function createLegacyFallbackTools(deps: LegacyFallbackToolsDeps): LegacyFallbackTools {
  return {
    async fallbackToAction(context) {
      if (
        context.expectedRequestToken != null &&
        context.activeRequestToken != null &&
        context.expectedRequestToken !== context.activeRequestToken
      ) {
        return { status: "stale" };
      }

      const candidate = await deps.candidateSource(context);
      if (!candidate) return { status: "empty", reason: context.reason };

      const governed = await deps.governCandidate({
        context,
        candidate: candidate.track,
        url: candidate.url,
        fallbackLevel: context.level,
        hostText: candidate.hostText,
      });

      if (governed.status === "accepted") {
        return {
          status: "action",
          action: {
            type: "play_now",
            track: governed.track,
            url: governed.url,
            reason: candidate.reason,
            ...(candidate.hostText ? { hostText: candidate.hostText } : {}),
            governanceTrace: governed.trace,
          },
        };
      }

      return {
        status: "action",
        action: {
          type: "honest_not_found",
          contract: context.contract,
          reason: governed.reason,
          searchedQueries: [],
          governanceTrace: governed.trace,
        },
      };
    },
  };
}
```

Important:

- This module must not accept or import a queue object.
- This module must not call `fillQueue`, `queue.addReady`, `queue.promoteNext`, websocket `send`, or TTS.
- Legacy systems may be wrapped only as `candidateSource` providers. Candidate source output is not playable until `governCandidate` accepts it.

- [ ] **Step 4: Run fallback tool tests**

Run:

```bash
npx tsx --test tests/ts/radio-agent-legacy-fallback-tools.test.ts
```

Expected:

- PASS.

- [ ] **Step 5: Run typecheck**

Run:

```bash
npm run typecheck
```

Expected:

- PASS.

- [ ] **Step 6: Commit**

Run:

```bash
git add src/radio-agent/legacyFallbackTools.ts tests/ts/radio-agent-legacy-fallback-tools.test.ts
git commit -m "Add governed legacy fallback tools"
```

## Task 3: Add Boundary Ownership Guard

**Files:**

- Create: `tests/ts/radio-agent-boundary-ownership.test.ts`
- Read: `src/server.ts`
- Read: `src/radio-agent/legacyFallbackTools.ts`

- [ ] **Step 1: Write failing boundary guard for forbidden direct legacy calls**

Create `tests/ts/radio-agent-boundary-ownership.test.ts`:

```ts
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const forbiddenInServer = [
  /radioBrain\.handleUserText/g,
  /radioBrain\.startSession/g,
  /stationDirector\.pickNext/g,
  /stationDirector\.handleUserRequest/g,
  /scheduler\.pickNext/g,
  /fillQueue\(1,\s*false\)/g,
];

test("server does not call legacy decision systems outside explicit fallback helpers", () => {
  const source = fs.readFileSync("src/server.ts", "utf8");
  const allowedHelpers = [
    "const buildLegacyFallbackCandidate",
    "const legacyFallbackCandidateSource",
    "const runGovernedLegacyFallback",
  ];

  for (const pattern of forbiddenInServer) {
    for (const match of source.matchAll(pattern)) {
      const index = match.index ?? 0;
      const window = source.slice(Math.max(0, index - 500), index + 500);
      assert.ok(
        allowedHelpers.some((helper) => window.includes(helper)),
        `Forbidden legacy call ${match[0]} outside allowed fallback helper near index ${index}`,
      );
    }
  }
});

test("legacy fallback tools module cannot mutate playback directly", () => {
  const source = fs.readFileSync("src/radio-agent/legacyFallbackTools.ts", "utf8");
  assert.doesNotMatch(source, /queue\.addReady|queue\.promoteNext|fillQueue|send\(|synthesizeAndSendDjMessage|radioBrain|stationDirector|scheduler/);
});
```

This test will fail before server cleanup. Keep it failing until Tasks 4-6 remove or isolate the direct calls.

- [ ] **Step 2: Run boundary guard to verify it fails or partially fails**

Run:

```bash
npx tsx --test tests/ts/radio-agent-boundary-ownership.test.ts
```

Expected:

- FAIL until `server.ts` legacy calls are isolated behind allowed fallback helper names.

- [ ] **Step 3: Commit the failing guard only when paired with same-task implementation**

Do not commit a permanently failing test. Implement the server helper in Task 6 before committing this test.

## Task 4: Wire ActionRunner For Agent-Approved Actions Only

**Files:**

- Modify: `src/server.ts`
- Modify: `tests/ts/radio-agent-server-wiring.test.ts`
- Test: `tests/ts/radio-agent-action-runner.test.ts`

- [ ] **Step 1: Add coarse wiring test for ActionRunner usage**

In `tests/ts/radio-agent-server-wiring.test.ts`, add:

```ts
test("server executes approved radio agent actions through the action runner boundary", () => {
  const source = fs.readFileSync("src/server.ts", "utf8");
  assert.match(source, /runRadioAgentActions/);
  assert.match(source, /const executeRadioAgentActions\s*=/);
  assert.match(source, /executeRadioAgentActions\(result\.actions\)/);
  assert.match(source, /executeRadioAgentActions\(agentTextResult\.actions\)/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
npx tsx --test tests/ts/radio-agent-server-wiring.test.ts
```

Expected:

- FAIL because `server.ts` does not use `runRadioAgentActions`.

- [ ] **Step 3: Add `executeRadioAgentActions` helper in `server.ts`**

Import:

```ts
import { runRadioAgentActions } from "./radio-agent/actionRunner.js";
```

Inside `handleRadioSocket`, after queue/speech helpers exist, add:

```ts
  const executeRadioAgentActions = async (actions: RadioAgentAction[]) =>
    await runRadioAgentActions(actions, {
      queuePlayNow: ({ track, url, reason, hostText, governanceTrace }) => {
        const safeHostText = hostTextForRadioAgentDelivery({
          eventType: "program_track_queued",
          decision: hostText ? { shouldSpeak: true, event: "service_delivery", reason: "approved action host text", text: hostText } : undefined,
        });
        queue.addReady(track, url, reason, { segueText: safeHostText });
        if (governanceTrace) {
          mirrorSocketRadioAgent({
            type: "program_track_queued",
            uid,
            sessionId,
            track: trackInfo(track),
            governanceTrace,
            selectionReason: reason.text || "",
            hostText: safeHostText,
            currentTrack: currentTrack ? trackInfo(currentTrack) : null,
            recentTracks: recentPlaybackTrackInfos(),
            readyQueue: queue.readyItems().map((readyItem) => trackInfo(readyItem.track)),
          });
        }
      },
      queuePrepared: ({ prepared }) => {
        const safeHostText = hostTextForRadioAgentDelivery({
          eventType: "program_track_queued",
          decision: prepared.segueText ? { shouldSpeak: true, event: "service_delivery", reason: "approved prepared host text", text: prepared.segueText } : undefined,
        });
        queue.addReady(prepared.track, prepared.url, prepared.selectionReason, { segueText: safeHostText });
      },
      speak: ({ text }) => synthesizeAndSendDjMessage(text),
      staySilent: () => undefined,
      repairContract: ({ contract }) => {
        activeAgentStationContract = stationContractFromAgentContract(contract);
      },
      reportNotFound: ({ reason, governanceTrace }) => {
        mirrorSocketRadioAgent({
          type: "playback_recovery_needed",
          uid,
          sessionId,
          reason,
          governanceTrace,
          currentTrack: currentTrack ? trackInfo(currentTrack) : null,
          recentTracks: recentPlaybackTrackInfos(),
          readyQueue: queue.readyItems().map((readyItem) => trackInfo(readyItem.track)),
        });
        send({ type: "request_status", status: "not_found", text: "I could not find a safe playable match for that direction yet." });
      },
      reportFallback: ({ level, reason }) => {
        store.logPlaybackEvent("radio_agent_fallback_intent", { uid, reason, payload: { level, sessionId } });
      },
    });
```

Use an existing contract conversion helper if present. If not present, do not invent a lossy converter silently:

- first inspect existing helpers near `stationContractFromAgentProgramWindow`;
- reuse one when possible;
- if a new converter is required, add tests for positive anchors, disallowed moves, bridge budget, and return requirement before using it.

- [ ] **Step 4: Replace session-start direct queueing**

In `tryQueueRadioAgentOpeningTrack`, replace direct `queue.addReady(result.opening...)` with:

```ts
const actionSummary = await executeRadioAgentActions(result.actions);
return actionSummary.playbackQueued;
```

Preserve existing fallback behavior only through explicit fallback handling in Task 6.

- [ ] **Step 5: Replace user-direction direct queueing for already-approved actions**

In `song_request`, after `agentTextResult` and token checks:

```ts
const actionSummary = await executeRadioAgentActions(agentTextResult.actions);
```

Then:

- if `actionSummary.playbackQueued`, send ready status and call `sendPreparedNext` with request token;
- if `actionSummary.notFound`, do not run legacy fallback unless the service also returned an explicit fallback action and Task 6's governed fallback path accepts a candidate;
- remove duplicate direct `queue.addReady(agentTextResult.preparedTrack.track...)` for the same action.

- [ ] **Step 6: Run focused tests**

Run:

```bash
npx tsx --test tests/ts/radio-agent-action-runner.test.ts tests/ts/radio-agent-server-wiring.test.ts tests/ts/radio-agent-service.test.ts
```

Expected:

- PASS, except the boundary ownership guard is not committed yet.

- [ ] **Step 7: Run typecheck**

Run:

```bash
npm run typecheck
```

Expected:

- PASS.

- [ ] **Step 8: Commit**

Run:

```bash
git add src/server.ts tests/ts/radio-agent-server-wiring.test.ts
git commit -m "Route approved radio agent actions through runner"
```

## Task 5: Route Correction And Queue-Low Through Agent Boundary

**Files:**

- Modify: `src/server.ts`
- Modify: `tests/ts/radio-agent-server-wiring.test.ts`
- Modify: `tests/ts/radio-agent-service.test.ts`
- Test: `tests/ts/radio-agent-action-runner.test.ts`

- [ ] **Step 1: Add failing correction wiring test**

In `tests/ts/radio-agent-server-wiring.test.ts`, add a targeted source-boundary test:

```ts
test("server executes correction actions through the action runner before any fallback", () => {
  const source = fs.readFileSync("src/server.ts", "utf8");
  const correctionCall = source.indexOf("radioAgentService.handleCorrection");
  const actionExecution = source.indexOf("executeRadioAgentActions(agentTextResult.actions)", correctionCall);
  const fallbackAfterCorrection = source.indexOf("runGovernedLegacyFallback", correctionCall);
  const oldFallbackAfterCorrection = source.indexOf("runStationDirectorRequestFallback", correctionCall);

  assert.ok(correctionCall >= 0, "expected correction to enter radioAgentService.handleCorrection");
  assert.ok(actionExecution > correctionCall, "correction result actions must be executed through action runner");
  assert.ok(fallbackAfterCorrection === -1 || fallbackAfterCorrection > actionExecution);
  assert.ok(oldFallbackAfterCorrection === -1 || oldFallbackAfterCorrection > actionExecution);

  const preExecutionWindow = source.slice(correctionCall, actionExecution);
  assert.doesNotMatch(preExecutionWindow, /queue\.addReady|fillQueue\(1,\s*false\)|radioBrain\.handleUserText/);
});
```

Expected:

- FAIL until correction flow executes `agentTextResult.actions` before fallback or direct queue mutation.

- [ ] **Step 2: Add failing queue-low wiring test**

In `tests/ts/radio-agent-server-wiring.test.ts`, add:

```ts
test("server routes queue-low continuation through service actions before recovery fallback", () => {
  const source = fs.readFileSync("src/server.ts", "utf8");
  const trackEndCall = source.indexOf("radioAgentService.handleTrackEnded");
  const actionExecution = source.indexOf("executeRadioAgentActions(trackEndResult.actions)", trackEndCall);
  const recoveryCall = source.indexOf("ensureTrackEndReadyItem", trackEndCall);

  assert.ok(trackEndCall >= 0, "expected queue-low/track-end to enter radioAgentService.handleTrackEnded");
  assert.ok(actionExecution > trackEndCall, "track-end queue-low actions must be executed through action runner");
  assert.ok(recoveryCall === -1 || recoveryCall > actionExecution, "legacy recovery must run only after action execution");

  const preExecutionWindow = source.slice(trackEndCall, actionExecution);
  assert.doesNotMatch(preExecutionWindow, /queue\.addReady|fillQueue\(1,\s*false\)|kickBrainContinuation|addRecentPlayableFallback/);
});
```

Expected:

- FAIL until `runSendPreparedNext` executes `trackEndResult.actions` before `ensureTrackEndReadyItem` or any legacy recovery callback.

- [ ] **Step 3: Add service tests for correction and queue-low action shape**

In `tests/ts/radio-agent-service.test.ts`, add or adjust tests proving:

- `handleCorrection(...)` returns typed actions and uses `speechRole: "correction"` or the existing equivalent correction role;
- correction either returns an approved `play_now` / `queue_window`, or an explicit `honest_not_found` / `fallback` action;
- `handleTrackEnded(...)` with an empty ready queue sends a `queue_low` event to `handleRadioAgentEvent`;
- queue-low continuation returns typed actions that can be executed by the action runner.

Use existing fixtures in `radio-agent-service.test.ts` rather than creating a new test harness unless necessary.

- [ ] **Step 4: Run tests to verify failure before implementation**

Run:

```bash
npx tsx --test tests/ts/radio-agent-server-wiring.test.ts tests/ts/radio-agent-service.test.ts
```

Expected:

- FAIL for the new server wiring assertions if `server.ts` still queues or recovers directly before action execution.
- Existing service tests should stay stable; if new service tests fail, confirm whether the service or only server wiring needs change.

- [ ] **Step 5: Route correction through the shared action execution path**

In `src/server.ts`, keep intent classification, but after `radioAgentService.handleCorrection(...)` returns:

```ts
const actionSummary = await executeRadioAgentActions(agentTextResult.actions);
```

Apply the same post-action handling as user text:

- if `actionSummary.playbackQueued`, send ready status and promote with the active request token;
- if `actionSummary.notFound`, report the honest not-found result and do not run legacy fallback in this task;
- if `actionSummary.fallbackLevels.length > 0`, log `radio_agent_fallback_intent` and return without calling legacy systems until Task 6 wires governed fallback;
- clear or sanitize incompatible ready items only through service-approved actions or existing contract sanitizers, not through direct legacy planner choice.

Do not leave a separate correction-specific direct queue, `radioBrain.handleUserText`, or `runStationDirectorRequestFallback` branch before action execution.

- [ ] **Step 6: Route queue-low/track-end continuation through the shared action execution path**

In `runSendPreparedNext`, after `radioAgentService.handleTrackEnded(...)` and before `ensureTrackEndReadyItem(...)`:

```ts
const actionSummary = await executeRadioAgentActions(trackEndResult.actions);
```

Then:

- if `actionSummary.playbackQueued`, continue to sanitize/promote the newly queued approved item;
- if `actionSummary.preparedQueued > 0`, sanitize/promote prepared items without invoking legacy recovery first;
- if `actionSummary.notFound`, mirror the recovery-needed status and stop without invoking legacy recovery in this task;
- if `actionSummary.fallbackLevels.length > 0`, log `radio_agent_fallback_intent` and stop without invoking legacy recovery until Task 6 wires governed fallback;
- do not call `ensureTrackEndReadyItem(...)` for service-owned queue-low fallback or not-found actions in this task. Existing non-agent recovery branches may remain only if the new queue-low test proves they run after service action execution and do not call legacy mutation for service fallback/not-found.

This makes queue-low an agent-owned continuation event, not a hidden legacy refill trigger.

- [ ] **Step 7: Run focused tests**

Run:

```bash
npx tsx --test tests/ts/radio-agent-action-runner.test.ts tests/ts/radio-agent-server-wiring.test.ts tests/ts/radio-agent-service.test.ts tests/ts/track-end-recovery.test.ts
```

Expected:

- PASS.

- [ ] **Step 8: Run typecheck**

Run:

```bash
npm run typecheck
```

Expected:

- PASS.

- [ ] **Step 9: Commit**

Run:

```bash
git add src/server.ts tests/ts/radio-agent-server-wiring.test.ts tests/ts/radio-agent-service.test.ts
git commit -m "Route correction and queue-low through radio agent actions"
```

## Task 6: Wire Governed Fallback Candidate Flow

**Files:**

- Modify: `src/server.ts`
- Modify: `tests/ts/radio-agent-server-wiring.test.ts`
- Add/commit: `tests/ts/radio-agent-boundary-ownership.test.ts`
- Test: `tests/ts/radio-agent-legacy-fallback-tools.test.ts`

Task 5 intentionally stops after reporting fallback intent so that it can typecheck and commit without a half-built legacy bridge. This task is where request, correction, track-end, and queue-low fallback intent becomes governed fallback action execution.

- [ ] **Step 1: Add server behavior seam for fallback candidate source**

Inside `handleRadioSocket`, create a helper that returns a candidate only:

```ts
  const legacyFallbackCandidateSource = async (context: LegacyFallbackContext): Promise<LegacyFallbackCandidate | null> => {
    if ((context.source === "request" || context.source === "correction") && context.requestText) {
      return await buildLegacyRequestFallbackCandidate(context.requestText, context.reason);
    }
    return await buildLegacyContinuationFallbackCandidate(context.reason);
  };
```

The `buildLegacy*Candidate` helpers may call old systems, but must return a candidate object. They must not enqueue or promote. If existing old helpers mutate queue today, first split them so candidate selection and queue mutation are separate. Do not wrap a mutating helper and call it "candidate source".

- [ ] **Step 1.5: Add server guard that candidate helpers do not mutate queue**

In `tests/ts/radio-agent-server-wiring.test.ts`, add a focused guard around the actual helper implementations:

```ts
test("server legacy fallback candidate helpers do not mutate playback directly", () => {
  const source = fs.readFileSync("src/server.ts", "utf8");
  for (const helperName of ["buildLegacyRequestFallbackCandidate", "buildLegacyContinuationFallbackCandidate"]) {
    const helperStart = source.indexOf(`const ${helperName}`);
    assert.ok(helperStart >= 0, `expected ${helperName} helper to exist`);
    const nextHelper = source.indexOf("\n  const ", helperStart + 1);
    const helperBody = source.slice(helperStart, nextHelper > helperStart ? nextHelper : helperStart + 2000);
    assert.doesNotMatch(helperBody, /queue\.addReady|queue\.promoteNext|sendTrack\(|fillQueue\(1,\s*false\)|synthesizeAndSendDjMessage/);
  }
});
```

Expected:

- FAIL if the candidate helper wraps an old mutating fallback function instead of splitting candidate selection from queue mutation.

- [ ] **Step 2: Add governed fallback tool instance**

Import:

```ts
import { createLegacyFallbackTools, type LegacyFallbackCandidate, type LegacyFallbackContext } from "./radio-agent/legacyFallbackTools.js";
```

Create:

```ts
  const legacyFallbackTools = createLegacyFallbackTools({
    candidateSource: legacyFallbackCandidateSource,
    governCandidate: async ({ context, candidate, url, fallbackLevel, hostText }) =>
      await radioAgentPlaybackGovernor.evaluate({
        contract: agentContractForGovernor(context.contract),
        requestToken: context.expectedRequestToken ?? context.activeRequestToken ?? 1,
        activeRequestToken: context.activeRequestToken ?? context.expectedRequestToken ?? 1,
        candidate,
        url,
        currentTrack: context.currentTrack,
        recentTracks: context.recentTracks,
        readyQueue: context.readyQueue.map((track) => ({ track })),
        seedState: {},
        hostText: hostText || "",
        fallbackLevel,
      }),
  });
```

Use existing contract conversion helpers where possible. If `agentContractForGovernor` is needed, test it before use.

- [ ] **Step 3: Add request fallback handling through governed action**

In the request path, when fallback is needed:

```ts
const fallbackResult = await legacyFallbackTools.fallbackToAction({
  source: "request",
  level: "legacy_with_label",
  reason: agentTextResult.fallbackReason || "agent_request_fallback",
  requestText,
  activeRequestToken,
  expectedRequestToken: requestToken,
  contract: currentAgentActionContract(),
  currentTrack: currentTrack ? trackInfo(currentTrack) : null,
  recentTracks: recentPlaybackTracks(),
  readyQueue: queue.readyItems().map((readyItem) => readyItem.track),
});
if (fallbackResult.status === "action") {
  const fallbackSummary = await executeRadioAgentActions([fallbackResult.action]);
  if (fallbackSummary.playbackQueued) {
    await sendPreparedNext("played", { allowContinuation: false, skipPrewarmWait: true, requestToken });
  }
}
```

Do not call `runStationDirectorRequestFallback` directly from the normal request path. If its current implementation mutates queue, split it before use.

- [ ] **Step 4: Add correction fallback handling through governed action**

In the correction path, when `actionSummary.fallbackLevels.length > 0` after `radioAgentService.handleCorrection(...)`, call `legacyFallbackTools.fallbackToAction` and execute any returned action through the same action runner:

```ts
const fallbackResult = await legacyFallbackTools.fallbackToAction({
  source: "correction",
  level: "legacy_with_label",
  reason: agentTextResult.fallbackReason || "agent_correction_fallback",
  requestText,
  activeRequestToken,
  expectedRequestToken: requestToken,
  contract: currentAgentActionContract(),
  currentTrack: currentTrack ? trackInfo(currentTrack) : null,
  recentTracks: recentPlaybackTracks(),
  readyQueue: queue.readyItems().map((readyItem) => readyItem.track),
});
if (fallbackResult.status === "action") {
  const fallbackSummary = await executeRadioAgentActions([fallbackResult.action]);
  if (fallbackSummary.playbackQueued) {
    await sendPreparedNext("played", { allowContinuation: false, skipPrewarmWait: true, requestToken });
  }
}
```

Use the same stale-token handling as request fallback. Do not leave correction fallback permanently logged-and-dropped.

- [ ] **Step 5: Add track-end fallback handling through governed action**

When `radioAgentService.handleTrackEnded` returns fallback intent and no approved ready item exists, call `legacyFallbackTools.fallbackToAction` with `source: "track_end"` and execute returned action through `executeRadioAgentActions`.

Do not wire `ensureTrackEndReadyItem` callbacks to raw `fillQueue`, `kickBrainContinuation`, or recent fallback queue mutation unless those callbacks are themselves candidate sources that return through the governed fallback path.

- [ ] **Step 6: Update boundary ownership guard**

Commit `tests/ts/radio-agent-boundary-ownership.test.ts` from Task 3 after adjusting allowed helper names to match actual implementation.

Allowed legacy calls in `src/server.ts` should be inside helpers with names like:

- `legacyFallbackCandidateSource`
- `buildLegacyRequestFallbackCandidate`
- `buildLegacyContinuationFallbackCandidate`
- `runGovernedLegacyFallback`

Forbidden normal-path direct calls remain:

- `radioBrain.handleUserText`
- `radioBrain.startSession`
- `stationDirector.pickNext`
- `stationDirector.handleUserRequest`
- `scheduler.pickNext`
- raw `fillQueue(1, false)` after agent decisions

- [ ] **Step 7: Run focused tests**

Run:

```bash
npx tsx --test tests/ts/radio-agent-legacy-fallback-tools.test.ts tests/ts/radio-agent-action-runner.test.ts tests/ts/radio-agent-boundary-ownership.test.ts tests/ts/radio-agent-server-wiring.test.ts tests/ts/radio-agent-service.test.ts
```

Expected:

- PASS.

- [ ] **Step 8: Run websocket tests**

Run:

```bash
node --test tests/js/radio-websocket.test.mjs
```

Expected:

- PASS.

- [ ] **Step 9: Run typecheck**

Run:

```bash
npm run typecheck
```

Expected:

- PASS.

- [ ] **Step 10: Commit**

Run:

```bash
git add src/server.ts tests/ts/radio-agent-boundary-ownership.test.ts tests/ts/radio-agent-server-wiring.test.ts
git commit -m "Route legacy fallback through governed agent actions"
```

## Task 7: Reduce Brittle Server String Tests

**Files:**

- Modify: `tests/ts/radio-agent-server-wiring.test.ts`
- Read: `tests/ts/radio-agent-action-runner.test.ts`
- Read: `tests/ts/radio-agent-legacy-fallback-tools.test.ts`
- Read: `tests/ts/radio-agent-boundary-ownership.test.ts`

- [ ] **Step 1: Inventory brittle tests**

Run:

```bash
rg -n "source\\.indexOf|assert\\.match\\(source|assert\\.doesNotMatch\\(source" tests/ts/radio-agent-server-wiring.test.ts
```

Expected:

- List string assertions.

- [ ] **Step 2: Remove duplicate string checks now covered by behavior tests**

Remove or simplify assertions that duplicate:

- action execution order covered by `radio-agent-action-runner.test.ts`;
- fallback governance covered by `radio-agent-legacy-fallback-tools.test.ts`;
- forbidden legacy ownership covered by `radio-agent-boundary-ownership.test.ts`.

Keep coarse checks for:

- `RadioAgentRuntime` wiring;
- `/api/radio/agent/status`;
- `RadioAgentService` construction;
- mode config;
- action runner import;
- fallback tool import.

- [ ] **Step 3: Run focused tests**

Run:

```bash
npx tsx --test tests/ts/radio-agent-server-wiring.test.ts tests/ts/radio-agent-action-runner.test.ts tests/ts/radio-agent-legacy-fallback-tools.test.ts tests/ts/radio-agent-boundary-ownership.test.ts
```

Expected:

- PASS.

- [ ] **Step 4: Commit**

Run:

```bash
git add tests/ts/radio-agent-server-wiring.test.ts
git commit -m "Reduce brittle radio agent server wiring assertions"
```

## Task 8: Boundary Slice Verification

**Files:**

- No production changes unless verification exposes a bug.
- Optionally modify `docs/superpowers/checklists/2026-06-11-hermes-ai-dj-v1-live-acceptance.md` to reflect proven boundary progress.

- [ ] **Step 1: Run focused agent boundary suite**

Run:

```bash
npx tsx --test tests/ts/radio-agent-action-runner.test.ts tests/ts/radio-agent-legacy-fallback-tools.test.ts tests/ts/radio-agent-boundary-ownership.test.ts tests/ts/radio-agent-service.test.ts tests/ts/radio-agent-server-wiring.test.ts tests/ts/track-end-recovery.test.ts tests/ts/request-ready-selector.test.ts tests/ts/boundary-guard.test.ts
```

Expected:

- PASS.

- [ ] **Step 2: Run websocket frontend unit tests**

Run:

```bash
node --test tests/js/radio-websocket.test.mjs
```

Expected:

- PASS.

- [ ] **Step 3: Run typecheck**

Run:

```bash
npm run typecheck
```

Expected:

- PASS.

- [ ] **Step 4: Run full test suite**

Run:

```bash
npm test
```

Expected:

- PASS. If this fails because of unrelated pre-existing tests, document exact failing tests and do not claim full regression.

- [ ] **Step 5: Check git status and untracked files**

Run:

```bash
git status --short --branch
git ls-files --others --exclude-standard
```

Expected:

- Only intentional files, ideally clean after commits.
- No logs or temp files.

- [ ] **Step 6: Update acceptance checklist only for proven progress**

If focused and full verification pass, update:

- `docs/superpowers/checklists/2026-06-11-hermes-ai-dj-v1-live-acceptance.md`

Allowed claims:

- action runner boundary exists;
- correction and queue-low routes execute service actions through the action runner boundary;
- legacy fallback is explicit and governed in unit tests;
- hidden normal-path legacy planner calls are guarded.

Forbidden claims:

- live/browser closure proven;
- cross-style retention proven;
- memory persistence proven;
- full Hermes Radio Agent Closure Candidate.

- [ ] **Step 7: Commit docs if changed**

Run:

```bash
git add docs/superpowers/checklists/2026-06-11-hermes-ai-dj-v1-live-acceptance.md
git commit -m "Update radio agent boundary acceptance status"
```

## Final Handoff

After execution:

- Report commit hashes.
- State which acceptance gates improved.
- State which gates remain unproven.
- Do not claim project closure without live/browser acceptance evidence.

Expected remaining plans:

- style intent registry and contract matcher cleanup;
- memory curator extraction;
- host controller cleanup;
- closure harness and live acceptance proof.
