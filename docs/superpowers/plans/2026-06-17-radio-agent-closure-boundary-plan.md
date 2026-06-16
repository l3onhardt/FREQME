# Radio Agent Closure Boundary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Hermes-style radio agent the only normal playback decision center by extracting action execution from `src/server.ts`, making legacy playback explicit fallback tooling, and adding behavior tests that prevent hidden second-DJ paths from returning.

**Architecture:** Keep existing useful parts: `RadioAgentRuntime`, `RadioAgentService`, `RadioAgentProgramDirector`, `RadioAgentProgramExecutor`, `PlaybackGovernor`, and current queue/audio services. Add a small `RadioAgentActionRunner` boundary so gateway code executes typed agent actions instead of inventing queue, speech, or fallback behavior. Convert old `radioBrain`, `stationDirector`, and scheduler use into explicit fallback adapters behind the agent service before deeper memory/style cleanup.

**Tech Stack:** TypeScript ESM, Node `node:test`, current FREQME backend modules under `src/`, browser JS tests under `tests/js`, TypeScript tests under `tests/ts`, `npx tsx --test`, `npm run typecheck`, and existing `npm test` for full regression.

---

## Scope

This plan covers the first project-closure slice from the spec:

- Gateway and action-runner boundary.
- Toolized legacy fallback.
- Behavior tests proving fallback and queue mutation cannot bypass the agent in normal paths.

This plan does not yet cover:

- full style registry cleanup;
- memory curator extraction;
- host controller extraction;
- broad live-smoke/browser automation;
- deleting all legacy radio code.

Those are later plans after the ownership boundary is stable.

Spec:

- `docs/superpowers/specs/2026-06-17-radio-agent-closure-audit-design.md`

## File Structure

Create:

- `src/radio-agent/actionRunner.ts`
  - Owns execution of `RadioAgentAction[]` into queue, speech, status, and fallback callbacks.
  - Has no music-selection intelligence.
  - Provides deterministic return summaries for tests and server orchestration.

- `tests/ts/radio-agent-action-runner.test.ts`
  - Behavior tests for action execution order, queue mutation, speech delivery, not-found status, and fallback delegation.

- `src/radio-agent/legacyFallbackTools.ts`
  - Wraps existing legacy playback systems in explicit fallback functions.
  - Returns typed fallback outcomes rather than mutating queue invisibly.
  - Does not import websocket/server state.

- `tests/ts/radio-agent-legacy-fallback-tools.test.ts`
  - Tests fallback labels, governor requirement hooks, stale request handling, and no hidden queue mutation.

Modify:

- `src/radio-agent/agentActions.ts`
  - Add or refine action execution metadata only if needed by `actionRunner.ts`.
  - Avoid broad type churn.

- `src/radio-agent/radioAgentService.ts`
  - Route legacy fallback requests as typed actions with levels and reasons.
  - Avoid direct assumptions that gateway will run old fallback paths.

- `src/server.ts`
  - Replace repeated action execution and direct fallback mutation with `RadioAgentActionRunner`.
  - Keep HTTP/WebSocket transport behavior stable.
  - Leave legacy fallback available only through explicit fallback adapter calls.

- `tests/ts/radio-agent-server-wiring.test.ts`
  - Reduce brittle string-order assertions as behavior tests replace them.
  - Keep only high-value wiring checks.

- `tests/ts/radio-agent-service.test.ts`
  - Add service expectations for fallback action shape and no hidden promotion.

- `tests/js/radio-websocket.test.mjs`
  - Keep frontend playback retry and status behavior stable.
  - Add only narrow tests if server message shape changes.

## Implementation Rules

- Use @superpowers:test-driven-development for every behavior change.
- Do not start the local dev server as part of these tasks unless a later task explicitly calls for browser verification.
- Do not run the old live-smoke loop while implementing this plan.
- Do not add genre-specific patches.
- Do not stage logs, `.codex-server.log`, `dev-server*.log`, or `tmp-*`.
- Commit after each completed task with fresh verification evidence.

## Task 1: Add RadioAgentActionRunner Boundary

**Files:**

- Create: `src/radio-agent/actionRunner.ts`
- Create: `tests/ts/radio-agent-action-runner.test.ts`
- Read: `src/radio-agent/agentActions.ts`
- Read: `src/radio/playbackQueue.ts`
- Read: `src/server.ts` action execution call sites around `queue.addReady`, `sendTrack`, `synthesizeAndSendDjMessage`, `send({ type: "request_status" })`

- [ ] **Step 1: Write failing test for `play_now` execution**

Add `tests/ts/radio-agent-action-runner.test.ts` with a minimal dependency harness:

```ts
import assert from "node:assert/strict";
import test from "node:test";

import { runRadioAgentActions } from "../../src/radio-agent/actionRunner.js";
import type { RadioAgentAction } from "../../src/radio-agent/agentActions.js";

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

  const result = await runRadioAgentActions(actions, {
    queuePlayNow: async ({ track, url, reason, hostText }) => {
      calls.push(`queue:${track.id}:${url}:${reason.type}:${hostText}`);
    },
    speak: async () => calls.push("speak"),
    staySilent: async () => calls.push("silent"),
    reportNotFound: async () => calls.push("not-found"),
    runFallback: async () => calls.push("fallback"),
  });

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

- FAIL because `src/radio-agent/actionRunner.ts` does not exist or `runRadioAgentActions` is not exported.

- [ ] **Step 3: Implement minimal action runner**

Create `src/radio-agent/actionRunner.ts`:

```ts
import type { SelectionReason, Track } from "../types.js";
import type { FallbackLevel, RadioAgentAction } from "./agentActions.js";
import type { AgentActionContract } from "./agentActions.js";
import type { PlaybackGovernanceTrace } from "./playbackGovernor.js";
import type { RadioAgentPreparedTrack, RadioAgentProgramWindow } from "./types.js";

export interface RadioAgentActionRunnerDeps {
  queuePlayNow(args: {
    track: Track;
    url: string;
    reason: SelectionReason;
    hostText: string;
    governanceTrace?: PlaybackGovernanceTrace;
  }): Promise<void> | void;
  queueWindow?(args: { window: RadioAgentProgramWindow; prepared: RadioAgentPreparedTrack[] }): Promise<void> | void;
  speak(args: { text: string; speechRole: Extract<RadioAgentAction, { type: "speak" }>["speechRole"] }): Promise<void> | void;
  staySilent(args: { reason: string }): Promise<void> | void;
  repairContract?(args: { contract: Extract<RadioAgentAction, { type: "repair_contract" }>["contract"]; reason: string }): Promise<void> | void;
  reportNotFound(args: {
    contract: AgentActionContract | null;
    reason: string;
    searchedQueries: string[];
    governanceTrace?: PlaybackGovernanceTrace;
  }): Promise<void> | void;
  runFallback(args: { level: FallbackLevel; reason: string; action?: RadioAgentAction }): Promise<void> | void;
}

export interface RadioAgentActionRunnerResult {
  executedTypes: RadioAgentAction["type"][];
  playbackQueued: boolean;
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
      await deps.queueWindow?.({ window: action.window, prepared: action.prepared });
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
    await deps.runFallback({ level: action.level, reason: action.reason, action: action.action });
    result.fallbackLevels.push(action.level);
  }

  return result;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:

```bash
npx tsx --test tests/ts/radio-agent-action-runner.test.ts
```

Expected:

- PASS.

- [ ] **Step 5: Add tests for speak, honest_not_found, fallback, and action order**

Extend `tests/ts/radio-agent-action-runner.test.ts`:

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
    {
      queuePlayNow: ({ track }) => calls.push(`queue:${track.id}`),
      speak: ({ text }) => calls.push(`speak:${text}`),
      staySilent: ({ reason }) => calls.push(`silent:${reason}`),
      reportNotFound: ({ reason }) => calls.push(`not-found:${reason}`),
      runFallback: ({ level }) => calls.push(`fallback:${level}`),
    },
  );

  assert.deepEqual(calls, ["speak:Got it.", "queue:track-2"]);
});

test("action runner reports honest not found without fallback mutation", async () => {
  const calls: string[] = [];
  const result = await runRadioAgentActions(
    [{ type: "honest_not_found", contract: null, reason: "reject_off_contract", searchedQueries: ["bad query"] }],
    {
      queuePlayNow: () => calls.push("queue"),
      speak: () => calls.push("speak"),
      staySilent: () => calls.push("silent"),
      reportNotFound: ({ reason, searchedQueries }) => calls.push(`not-found:${reason}:${searchedQueries.join("|")}`),
      runFallback: () => calls.push("fallback"),
    },
  );

  assert.deepEqual(calls, ["not-found:reject_off_contract:bad query"]);
  assert.equal(result.notFound, true);
  assert.equal(result.playbackQueued, false);
});

test("action runner delegates fallback explicitly", async () => {
  const calls: string[] = [];
  const result = await runRadioAgentActions(
    [{ type: "fallback", level: "legacy_with_label", reason: "agent_timeout" }],
    {
      queuePlayNow: () => calls.push("queue"),
      speak: () => calls.push("speak"),
      staySilent: () => calls.push("silent"),
      reportNotFound: () => calls.push("not-found"),
      runFallback: ({ level, reason }) => calls.push(`fallback:${level}:${reason}`),
    },
  );

  assert.deepEqual(calls, ["fallback:legacy_with_label:agent_timeout"]);
  assert.deepEqual(result.fallbackLevels, ["legacy_with_label"]);
});
```

- [ ] **Step 6: Run action runner tests**

Run:

```bash
npx tsx --test tests/ts/radio-agent-action-runner.test.ts
```

Expected:

- PASS, all action runner tests.

- [ ] **Step 7: Run focused typecheck**

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

## Task 2: Route Session Start And User Direction Through ActionRunner

**Files:**

- Modify: `src/server.ts`
- Modify: `tests/ts/radio-agent-server-wiring.test.ts`
- Modify: `tests/ts/radio-agent-service.test.ts` only if service action shape needs a small adjustment.
- Test: `tests/ts/radio-agent-action-runner.test.ts`

- [ ] **Step 1: Write failing server wiring test for ActionRunner import and usage**

Add to `tests/ts/radio-agent-server-wiring.test.ts`:

```ts
test("server executes radio agent actions through the action runner boundary", () => {
  const source = fs.readFileSync("src/server.ts", "utf8");
  const importIndex = source.indexOf("runRadioAgentActions");
  const socketStart = source.indexOf("async function handleRadioSocket");
  const serviceConstruction = source.indexOf("const radioAgentService = new RadioAgentService", socketStart);
  const firstRunnerUse = source.indexOf("runRadioAgentActions", serviceConstruction + 1);

  assert.ok(importIndex >= 0);
  assert.ok(socketStart >= 0);
  assert.ok(serviceConstruction > socketStart);
  assert.ok(firstRunnerUse > serviceConstruction);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
npx tsx --test tests/ts/radio-agent-server-wiring.test.ts
```

Expected:

- FAIL because `server.ts` does not import or use `runRadioAgentActions`.

- [ ] **Step 3: Add server helper that executes agent actions**

In `src/server.ts`, import:

```ts
import { runRadioAgentActions } from "./radio-agent/actionRunner.js";
```

Inside `handleRadioSocket`, after `radioAgentService` construction or near queue helpers, add a narrow helper:

```ts
  const executeRadioAgentActions = async (actions: RadioAgentAction[]): Promise<void> => {
    await runRadioAgentActions(actions, {
      queuePlayNow: ({ track, url, reason, hostText }) => {
        queue.addReady(track, url, reason, { segueText: hostText });
      },
      queueWindow: async ({ window }) => {
        await queueRadioAgentWindow(window);
      },
      speak: ({ text }) => {
        synthesizeAndSendDjMessage(text);
      },
      staySilent: () => undefined,
      repairContract: ({ contract }) => {
        activeAgentStationContract = stationContractFromAgentSessionContract(contract);
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
      runFallback: async ({ level, reason }) => {
        await runExplicitLegacyFallback(level, reason);
      },
    });
  };
```

The exact Chinese listener text can use the existing safe recovery copy already present in `server.ts`, but do not introduce mojibake.

If `stationContractFromAgentSessionContract` does not exist, add a small converter next to existing station-contract conversion helpers:

```ts
function stationContractFromAgentSessionContract(contract: import("./radio-agent/contractController.js").AgentSessionContract): StationContract {
  return {
    id: contract.id,
    mainDirection: contract.stationBrief,
    rawUserText: contract.rawUserText,
    allowedAdjacent: contract.allowedAdjacent,
    softBridge: contract.allowedAdjacent,
    disallowed: contract.disallowed,
    positiveSeeds: contract.positiveAnchors,
    negativeConstraints: contract.disallowed,
    driftBudget: contract.bridgeBudget,
    bridgeCount: 0,
    mustReturnToContract: Boolean(contract.returnRequirement),
    createdAt: contract.createdAt,
    updatedAt: contract.updatedAt,
  };
}
```

- [ ] **Step 4: Run server wiring test**

Run:

```bash
npx tsx --test tests/ts/radio-agent-server-wiring.test.ts
```

Expected:

- The new test passes.
- Existing tests may fail because old string-order expectations still reflect direct queue mutation. Keep failures and address them in the next steps.

- [ ] **Step 5: Replace session-start direct action execution**

Find `tryQueueRadioAgentOpeningTrack` in `src/server.ts`.

Change it so after:

```ts
const result = await radioAgentService.startSession(...)
```

it calls:

```ts
await executeRadioAgentActions(result.actions);
```

Then keep only result-specific bookkeeping that cannot live in the action runner. Remove duplicate `queue.addReady(result.opening.track, ...)` if the `play_now` action already queued it.

- [ ] **Step 6: Add or update test proving session start uses action runner**

In `tests/ts/radio-agent-server-wiring.test.ts`, update the existing "server delegates the first playback attempt..." test so it asserts:

```ts
assert.match(source.slice(openingHelper, openingAttempt), /executeRadioAgentActions\(result\.actions\)/);
assert.doesNotMatch(source.slice(openingHelper, openingAttempt), /queue\.addReady\(result\.opening\.track/);
```

- [ ] **Step 7: Run server wiring test**

Run:

```bash
npx tsx --test tests/ts/radio-agent-server-wiring.test.ts
```

Expected:

- PASS or only failures related to the next request path.

- [ ] **Step 8: Replace user-direction direct action execution**

In the `song_request` handler, after `agentTextResult` is returned and stale-token checks pass:

- use `executeRadioAgentActions(agentTextResult.actions)` for `repair_contract`, `speak`, `queue_window`, `play_now`, `honest_not_found`, and `fallback`;
- remove duplicate `queue.clearReady()` and `queue.addReady(agentTextResult.preparedTrack.track...)` where equivalent action execution now handles it;
- preserve `sendPreparedNext("played", { allowContinuation: false, skipPrewarmWait: true, requestToken })` only after action runner queued a `play_now` item;
- keep existing `request_status` delivery behavior if it is still needed for frontend, but do not use it to mutate queue independently.

Expected pattern:

```ts
const actionSummary = await executeRadioAgentActions(agentTextResult.actions);
if (actionSummary.playbackQueued) {
  send({ type: "request_status", status: "ready", text: ..., next_track: ... });
  await sendPreparedNext("played", { allowContinuation: false, skipPrewarmWait: true, requestToken });
  ...
}
if (actionSummary.notFound) {
  ...
}
```

If `executeRadioAgentActions` currently returns void, update it to return the `RadioAgentActionRunnerResult`.

- [ ] **Step 9: Update tests away from old direct queue assumptions**

In `tests/ts/radio-agent-server-wiring.test.ts`, replace brittle assertions that require `queue.addReady(agentTextResult.preparedTrack.track...)` with action-runner assertions:

```ts
assert.match(source.slice(agentProgramQueue, legacyBrainRequest), /executeRadioAgentActions\(agentTextResult\.actions\)/);
assert.doesNotMatch(source.slice(agentProgramQueue, legacyBrainRequest), /queue\.addReady\(agentTextResult\.preparedTrack\.track/);
```

Keep assertions that the agent service is called before legacy fallback.

- [ ] **Step 10: Run focused tests**

Run:

```bash
npx tsx --test tests/ts/radio-agent-action-runner.test.ts tests/ts/radio-agent-server-wiring.test.ts tests/ts/radio-agent-service.test.ts
```

Expected:

- PASS.

- [ ] **Step 11: Run typecheck**

Run:

```bash
npm run typecheck
```

Expected:

- PASS.

- [ ] **Step 12: Commit**

Run:

```bash
git add src/server.ts tests/ts/radio-agent-server-wiring.test.ts tests/ts/radio-agent-service.test.ts src/radio-agent/actionRunner.ts
git commit -m "Route radio agent gateway actions through runner"
```

## Task 3: Toolize Legacy Request And Continuation Fallback

**Files:**

- Create: `src/radio-agent/legacyFallbackTools.ts`
- Create: `tests/ts/radio-agent-legacy-fallback-tools.test.ts`
- Modify: `src/server.ts`
- Modify: `src/radio-agent/radioAgentService.ts`
- Modify: `tests/ts/radio-agent-server-wiring.test.ts`
- Modify: `tests/ts/radio-agent-service.test.ts`

- [ ] **Step 1: Write failing tests for fallback adapter**

Create `tests/ts/radio-agent-legacy-fallback-tools.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";

import { createLegacyFallbackTools } from "../../src/radio-agent/legacyFallbackTools.js";

test("legacy fallback tool reports explicit level and reason", async () => {
  const calls: string[] = [];
  const tools = createLegacyFallbackTools({
    requestFallback: async ({ text, reason }) => {
      calls.push(`request:${text}:${reason}`);
      return { status: "queued", level: "legacy_with_label", reason };
    },
    continuationFallback: async ({ reason }) => {
      calls.push(`continuation:${reason}`);
      return { status: "queued", level: "legacy_with_label", reason };
    },
  });

  const result = await tools.request({ text: "play something safe", reason: "agent_timeout" });

  assert.deepEqual(calls, ["request:play something safe:agent_timeout"]);
  assert.equal(result.status, "queued");
  assert.equal(result.level, "legacy_with_label");
});

test("legacy fallback tool does not hide failed fallback", async () => {
  const tools = createLegacyFallbackTools({
    requestFallback: async ({ reason }) => ({ status: "failed", level: "legacy_with_label", reason }),
    continuationFallback: async ({ reason }) => ({ status: "failed", level: "legacy_with_label", reason }),
  });

  const result = await tools.continuation({ reason: "queue_empty" });

  assert.equal(result.status, "failed");
  assert.equal(result.reason, "queue_empty");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
npx tsx --test tests/ts/radio-agent-legacy-fallback-tools.test.ts
```

Expected:

- FAIL because `legacyFallbackTools.ts` does not exist.

- [ ] **Step 3: Implement minimal fallback tools module**

Create `src/radio-agent/legacyFallbackTools.ts`:

```ts
import type { FallbackLevel } from "./agentActions.js";

export type LegacyFallbackStatus = "queued" | "played" | "failed" | "skipped";

export interface LegacyFallbackOutcome {
  status: LegacyFallbackStatus;
  level: FallbackLevel;
  reason: string;
}

export interface LegacyRequestFallbackArgs {
  text: string;
  reason: string;
}

export interface LegacyContinuationFallbackArgs {
  reason: string;
}

export interface LegacyFallbackToolDeps {
  requestFallback(args: LegacyRequestFallbackArgs): Promise<LegacyFallbackOutcome>;
  continuationFallback(args: LegacyContinuationFallbackArgs): Promise<LegacyFallbackOutcome>;
}

export interface LegacyFallbackTools {
  request(args: LegacyRequestFallbackArgs): Promise<LegacyFallbackOutcome>;
  continuation(args: LegacyContinuationFallbackArgs): Promise<LegacyFallbackOutcome>;
}

export function createLegacyFallbackTools(deps: LegacyFallbackToolDeps): LegacyFallbackTools {
  return {
    request: (args) => deps.requestFallback(args),
    continuation: (args) => deps.continuationFallback(args),
  };
}
```

- [ ] **Step 4: Run fallback tool tests**

Run:

```bash
npx tsx --test tests/ts/radio-agent-legacy-fallback-tools.test.ts
```

Expected:

- PASS.

- [ ] **Step 5: Wire fallback tools into `server.ts`**

Import:

```ts
import { createLegacyFallbackTools } from "./radio-agent/legacyFallbackTools.js";
```

Inside `handleRadioSocket`, create:

```ts
  const legacyFallbackTools = createLegacyFallbackTools({
    requestFallback: async ({ text, reason }) => {
      const queued = await runStationDirectorRequestFallback(text, snapshotReadyItems(queue), reason, activeRequestToken ?? undefined);
      return { status: queued ? "queued" : "failed", level: "legacy_with_label", reason };
    },
    continuationFallback: async ({ reason }) => {
      await fillQueue(1, false);
      return { status: queue.readyItems().length ? "queued" : "failed", level: "legacy_with_label", reason };
    },
  });
```

If order makes this awkward because helpers are declared later, either:

- move creation below helper declarations; or
- keep `runFallback` callback lazy and call helper functions that are declared before use.

Do not change playback behavior yet except making fallback explicit.

- [ ] **Step 6: Update action runner fallback callback**

In `executeRadioAgentActions`, change `runFallback` to call `legacyFallbackTools` based on reason/source:

```ts
runFallback: async ({ level, reason }) => {
  if (level !== "legacy_with_label") {
    store.logPlaybackEvent("radio_agent_fallback_action", { uid, reason, payload: { level, sessionId } });
    return;
  }
  await legacyFallbackTools.continuation({ reason });
},
```

For user-request fallback, pass text explicitly from the request branch when needed. Do not guess text inside generic action runner if it is not available.

- [ ] **Step 7: Add server wiring test for explicit legacy tools**

Add:

```ts
test("server wraps legacy request and continuation fallback as explicit radio agent tools", () => {
  const source = fs.readFileSync("src/server.ts", "utf8");
  assert.match(source, /createLegacyFallbackTools/);
  assert.match(source, /legacyFallbackTools\.request/);
  assert.match(source, /legacyFallbackTools\.continuation/);
  assert.doesNotMatch(source, /runFallback:\s*async\s*\(\{ level, reason \}\)\s*=>\s*\{\s*await fillQueue\(1,\s*false\)/);
});
```

- [ ] **Step 8: Run focused tests**

Run:

```bash
npx tsx --test tests/ts/radio-agent-legacy-fallback-tools.test.ts tests/ts/radio-agent-action-runner.test.ts tests/ts/radio-agent-server-wiring.test.ts
```

Expected:

- PASS.

- [ ] **Step 9: Update service tests for fallback semantics**

In `tests/ts/radio-agent-service.test.ts`, add:

```ts
test("service exposes legacy fallback as an explicit action instead of hidden playback", async () => {
  const service = new RadioAgentService({
    chooseOpeningTrack: () => null,
    prepareTrack: async () => null,
    handleRadioAgentEvent: async () => null,
  });

  const result = await service.handleTrackEnded({
    uid: "42",
    sessionId: 7,
    previousEvent: "played",
    currentTrack: null,
    readyQueue: [],
  });

  assert.ok(result.actions.some((action) => action.type === "fallback"));
  assert.equal(result.action, "legacy_fallback");
});
```

Adjust expected reason to current implementation if needed, but do not allow queue mutation inside service.

- [ ] **Step 10: Run service tests**

Run:

```bash
npx tsx --test tests/ts/radio-agent-service.test.ts tests/ts/radio-agent-legacy-fallback-tools.test.ts
```

Expected:

- PASS.

- [ ] **Step 11: Run typecheck**

Run:

```bash
npm run typecheck
```

Expected:

- PASS.

- [ ] **Step 12: Commit**

Run:

```bash
git add src/radio-agent/legacyFallbackTools.ts tests/ts/radio-agent-legacy-fallback-tools.test.ts src/server.ts src/radio-agent/radioAgentService.ts tests/ts/radio-agent-server-wiring.test.ts tests/ts/radio-agent-service.test.ts
git commit -m "Make legacy radio fallback explicit tooling"
```

## Task 4: Remove Hidden Normal-Path Legacy Brain Calls After Agent Decisions

**Files:**

- Modify: `src/server.ts`
- Modify: `tests/ts/radio-agent-server-wiring.test.ts`
- Modify: `tests/js/radio-websocket.test.mjs` only if message timing changes.

- [ ] **Step 1: Write failing server test for no normal hidden legacy request planner after agent action result**

Add to `tests/ts/radio-agent-server-wiring.test.ts`:

```ts
test("server does not call legacy radioBrain directly after executable agent request actions", () => {
  const source = fs.readFileSync("src/server.ts", "utf8");
  const songRequestHandler = source.indexOf('if (type === "song_request")');
  const agentResult = source.indexOf("const agentTextResult =", songRequestHandler);
  const executeActions = source.indexOf("executeRadioAgentActions(agentTextResult.actions)", agentResult);
  const legacyBrainRequest = source.indexOf("radioBrain.handleUserText", executeActions);
  const explicitFallbackTool = source.indexOf("legacyFallbackTools.request", executeActions);

  assert.ok(songRequestHandler >= 0);
  assert.ok(agentResult > songRequestHandler);
  assert.ok(executeActions > agentResult);
  assert.ok(explicitFallbackTool > executeActions);
  assert.ok(legacyBrainRequest === -1 || legacyBrainRequest > explicitFallbackTool);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
npx tsx --test tests/ts/radio-agent-server-wiring.test.ts
```

Expected:

- FAIL if old `radioBrain.handleUserText` is still a normal branch before explicit fallback.

- [ ] **Step 3: Move legacy request planning behind explicit fallback**

In `src/server.ts`, in the `song_request` handler:

- keep `radioAgentService.handleUserText` / `handleCorrection` as first decision path;
- execute actions;
- if action runner queued playback, promote via `sendPreparedNext`;
- if action runner returned not-found, report and stop;
- if action runner returned fallback or timeout, call `legacyFallbackTools.request({ text: requestText, reason })`;
- remove direct normal `radioBrain.handleUserText` branch from the request path.

Old `radioBrain.handleUserText` may still exist inside `legacyFallbackTools.request` implementation, but not as a parallel normal decision branch.

- [ ] **Step 4: Update old tests to explicit fallback expectations**

In `tests/ts/radio-agent-server-wiring.test.ts`:

- keep "agent service before legacy fallback" checks;
- replace "legacyBrainRequest after agentProgramQueue" with "legacyFallbackTools.request after execute actions";
- remove any assertion that relies on old `radioBrain.handleUserText` in the normal request handler.

- [ ] **Step 5: Run focused tests**

Run:

```bash
npx tsx --test tests/ts/radio-agent-server-wiring.test.ts tests/ts/radio-agent-action-runner.test.ts tests/ts/radio-agent-legacy-fallback-tools.test.ts
```

Expected:

- PASS.

- [ ] **Step 6: Run websocket JS tests**

Run:

```bash
node --test tests/js/radio-websocket.test.mjs
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
git add src/server.ts tests/ts/radio-agent-server-wiring.test.ts tests/js/radio-websocket.test.mjs
git commit -m "Remove hidden legacy planner from request path"
```

## Task 5: Track-End Continuation Ownership Cleanup

**Files:**

- Modify: `src/server.ts`
- Modify: `src/radio/trackEndRecovery.ts` only if necessary.
- Modify: `tests/ts/track-end-recovery.test.ts`
- Modify: `tests/ts/radio-agent-server-wiring.test.ts`
- Modify: `tests/ts/radio-agent-service.test.ts`

- [ ] **Step 1: Write failing test that track-end recovery uses explicit fallback tool labels**

In `tests/ts/radio-agent-server-wiring.test.ts`, add:

```ts
test("server track-end recovery calls explicit continuation fallback tool after agent continuation fails", () => {
  const source = fs.readFileSync("src/server.ts", "utf8");
  const sendPreparedNextStart = source.indexOf("const runSendPreparedNext =");
  const serviceContinuation = source.indexOf("radioAgentService.handleTrackEnded", sendPreparedNextStart);
  const recoveryCall = source.indexOf("ensureTrackEndReadyItem", serviceContinuation);
  const fallbackTool = source.indexOf("legacyFallbackTools.continuation", serviceContinuation);

  assert.ok(sendPreparedNextStart >= 0);
  assert.ok(serviceContinuation > sendPreparedNextStart);
  assert.ok(fallbackTool > serviceContinuation);
  assert.ok(recoveryCall === -1 || recoveryCall > serviceContinuation);
});
```

- [ ] **Step 2: Run test to verify current ownership gap**

Run:

```bash
npx tsx --test tests/ts/radio-agent-server-wiring.test.ts
```

Expected:

- FAIL if `ensureTrackEndReadyItem` still calls raw `fillQueue`, `kickBrainContinuation`, or recent fallback directly without explicit tool labeling.

- [ ] **Step 3: Refactor track-end recovery callback names and labels**

Option A, minimal:

- keep `ensureTrackEndReadyItem`;
- change its callback wiring so legacy fill and brain continuation are implemented through `legacyFallbackTools.continuation`;
- preserve existing no-stall behavior.

Option B, slightly cleaner:

- introduce `runTrackEndFallbackRecovery` inside `server.ts` that wraps `ensureTrackEndReadyItem`;
- all callbacks inside that helper are labeled legacy fallback actions.

Do not remove `ensureTrackEndReadyItem` unless tests prove equivalent behavior.

- [ ] **Step 4: Update `track-end-recovery` tests if callback names change**

Run:

```bash
npx tsx --test tests/ts/track-end-recovery.test.ts
```

Expected:

- PASS.

- [ ] **Step 5: Run focused track-end suite**

Run:

```bash
npx tsx --test tests/ts/radio-agent-service.test.ts tests/ts/radio-agent-server-wiring.test.ts tests/ts/track-end-recovery.test.ts
```

Expected:

- PASS.

- [ ] **Step 6: Run typecheck**

Run:

```bash
npm run typecheck
```

Expected:

- PASS.

- [ ] **Step 7: Commit**

Run:

```bash
git add src/server.ts src/radio/trackEndRecovery.ts tests/ts/track-end-recovery.test.ts tests/ts/radio-agent-server-wiring.test.ts tests/ts/radio-agent-service.test.ts
git commit -m "Label track-end legacy recovery behind agent fallback"
```

## Task 6: Replace Brittle Server String Tests With Boundary Tests Where Possible

**Files:**

- Modify: `tests/ts/radio-agent-server-wiring.test.ts`
- Create: `tests/ts/radio-agent-gateway-boundary.test.ts` if useful.
- Modify: `src/radio-agent/actionRunner.ts` only if test seams need exported helpers.

- [ ] **Step 1: Inventory brittle tests**

Run:

```bash
rg -n "source\\.indexOf|assert\\.match\\(source|assert\\.doesNotMatch\\(source" tests/ts/radio-agent-server-wiring.test.ts
```

Expected:

- List current string-based assertions.

- [ ] **Step 2: Decide which tests can become behavior tests now**

Convert only tests made obsolete by Tasks 1-5:

- action execution order -> `radio-agent-action-runner.test.ts`;
- explicit legacy fallback -> `radio-agent-legacy-fallback-tools.test.ts`;
- service action shape -> `radio-agent-service.test.ts`.

Keep string checks only for wiring that cannot yet be tested without larger server extraction.

- [ ] **Step 3: Remove duplicated brittle assertions**

Edit `tests/ts/radio-agent-server-wiring.test.ts` to remove assertions that now duplicate behavior tests and block harmless refactors.

Do not lower coverage for:

- agent service first chance;
- no direct normal legacy planner after agent result;
- status endpoint;
- radio agent mode wiring.

- [ ] **Step 4: Run tests**

Run:

```bash
npx tsx --test tests/ts/radio-agent-server-wiring.test.ts tests/ts/radio-agent-action-runner.test.ts tests/ts/radio-agent-legacy-fallback-tools.test.ts tests/ts/radio-agent-service.test.ts
```

Expected:

- PASS.

- [ ] **Step 5: Commit**

Run:

```bash
git add tests/ts/radio-agent-server-wiring.test.ts tests/ts/radio-agent-action-runner.test.ts tests/ts/radio-agent-legacy-fallback-tools.test.ts
git commit -m "Reduce brittle radio agent server wiring assertions"
```

## Task 7: Full Verification For Boundary Slice

**Files:**

- No production changes unless verification exposes a bug.
- Possibly update docs/checklist if exact acceptance status changed.

- [ ] **Step 1: Run focused TypeScript agent suite**

Run:

```bash
npx tsx --test tests/ts/radio-agent-action-runner.test.ts tests/ts/radio-agent-legacy-fallback-tools.test.ts tests/ts/radio-agent-service.test.ts tests/ts/radio-agent-server-wiring.test.ts tests/ts/track-end-recovery.test.ts tests/ts/request-ready-selector.test.ts tests/ts/boundary-guard.test.ts
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

- [ ] **Step 4: Run full test suite if focused suite passes**

Run:

```bash
npm test
```

Expected:

- PASS.

- [ ] **Step 5: Check git status and logs**

Run:

```bash
git status --short --branch
git ls-files --others --exclude-standard
```

Expected:

- Only intentional source/test/doc changes.
- No logs or temp files.

- [ ] **Step 6: Update closure checklist**

If the implementation proves ownership gate progress, update:

- `docs/superpowers/checklists/2026-06-11-hermes-ai-dj-v1-live-acceptance.md`

Mark only what the tests prove:

- gateway/action-runner boundary improved;
- legacy fallback is explicit;
- live/browser gates still require later evidence.

- [ ] **Step 7: Commit final docs if changed**

Run:

```bash
git add docs/superpowers/checklists/2026-06-11-hermes-ai-dj-v1-live-acceptance.md
git commit -m "Update radio agent boundary acceptance status"
```

## Final Handoff

After all tasks:

- Report commit hashes.
- State exactly which acceptance gates improved.
- State which gates remain unproven.
- Do not claim Hermes Radio Agent Closure Candidate unless live/browser acceptance gates have passed.

Expected remaining work after this plan:

- style intent registry and contract matcher cleanup;
- memory curator extraction;
- host controller cleanup;
- closure harness and live acceptance proof.
