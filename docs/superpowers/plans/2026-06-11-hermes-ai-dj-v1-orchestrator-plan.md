# Hermes AI DJ v1 Orchestrator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a bounded Hermes-style AI DJ v1 by moving scattered radio intelligence into an agent-owned orchestration service with clear acceptance gates.

**Architecture:** Add a focused `RadioAgentService` boundary that owns session start, user direction, track-end continuation, queue-low recovery, correction, and host decisions. Keep existing NetEase, search verification, audio resolution, queue, TTS, weather, boundary guard, runtime, director, executor, and memory code as tools/adapters.

**Tech Stack:** TypeScript, Node.js, `node:test`, existing FREQME websocket backend, existing `src/radio-agent/*` modules, SQLite-backed `RadioAgentStore`.

---

## Scope Discipline

This plan implements the finite v1 from `docs/superpowers/specs/2026-06-11-hermes-ai-dj-v1-scope-design.md`.

Do not add more R&B-only patches. R&B remains a regression case, not the project center.

Do not claim v1 completion until the design document's acceptance gates are verified with current code, including live browser playback.

## File Structure

- Create: `src/radio-agent/radioAgentService.ts`
  - Owns the v1 orchestration API and delegates to existing runtime/director/executor/tool adapters.
- Create: `tests/ts/radio-agent-service.test.ts`
  - Unit tests for service decisions: opening, direction, continuation, correction, degradation.
- Modify: `src/server.ts`
  - Replace direct station-intelligence wiring with calls into `RadioAgentService`.
- Modify: `src/radio-agent/types.ts`
  - Add service request/result types only when tests require them.
- Modify: `src/radio-agent/openingTrack.ts`
  - Keep as a reusable opening selector, not a server helper.
- Modify: `src/radio-agent/radioAgentRuntime.ts`
  - Keep memory/artifact responsibilities; do not make it own websocket behavior.
- Modify: `tests/ts/radio-agent-server-wiring.test.ts`
  - Assert server delegates to the service for session start/user text/track end/queue low.
- Create or update: `tests/ts/radio-agent-live-contract.test.ts`
  - Higher-level integration tests for cross-genre station contracts and no-stall continuation.

## Task 1: Freeze Current Alpha Baseline

**Files:**
- Existing modified files:
  - `src/radio-agent/openingTrack.ts`
  - `src/radio-agent/radioAgentRuntime.ts`
  - `src/server.ts`
  - `tests/ts/opening-track.test.ts`
  - `tests/ts/radio-agent-runtime.test.ts`
  - `tests/ts/radio-agent-server-wiring.test.ts`
- New docs:
  - `docs/superpowers/specs/2026-06-11-hermes-ai-dj-v1-scope-design.md`
  - `docs/superpowers/plans/2026-06-11-hermes-ai-dj-v1-orchestrator-plan.md`

- [ ] **Step 1: Inspect current diff**

Run: `git status --short --branch`

Expected: current branch is `codex/hermes-radio-agent-service`; modified code files and new docs are visible.

- [ ] **Step 2: Verify existing code baseline**

Run: `npm run typecheck`

Expected: exit 0.

- [ ] **Step 3: Verify build**

Run: `npm run build`

Expected: exit 0.

- [ ] **Step 4: Verify tests**

Run: `npm test`

Expected: all tests pass with zero failures.

- [ ] **Step 5: Commit baseline only after verification**

Run:

```bash
git add src/radio-agent/openingTrack.ts src/radio-agent/radioAgentRuntime.ts src/server.ts tests/ts/opening-track.test.ts tests/ts/radio-agent-runtime.test.ts tests/ts/radio-agent-server-wiring.test.ts docs/superpowers/specs/2026-06-11-hermes-ai-dj-v1-scope-design.md docs/superpowers/plans/2026-06-11-hermes-ai-dj-v1-orchestrator-plan.md
git commit -m "Define Hermes AI DJ v1 scope"
```

Expected: one commit that freezes the current alpha fixes and v1 scope.

## Task 2: Add RadioAgentService Session Start Contract

**Files:**
- Create: `src/radio-agent/radioAgentService.ts`
- Create: `tests/ts/radio-agent-service.test.ts`
- Modify as needed: `src/radio-agent/types.ts`

- [ ] **Step 1: Write the failing service test for fast opening**

Add a test named:

```ts
test("service starts a session with an opening track before background planning", async () => {
  // Arrange a profile with a liked track and dependencies that record call order.
  // Act: call service.startSession(...)
  // Assert: result.openingTrack is present, playback action is ready before background planning is awaited.
});
```

Expected behavior:

- `startSession` returns a playable opening decision when known evidence exists.
- Background scan/planning is scheduled or represented, but does not block opening playback.

- [ ] **Step 2: Run the test to verify RED**

Run: `npm run build:test && node --test dist/tests/ts/radio-agent-service.test.js`

Expected: FAIL because `RadioAgentService` does not exist.

- [ ] **Step 3: Implement minimal `RadioAgentService.startSession`**

Create a service class/function with dependencies injected for:

- opening selector;
- audio preparer;
- runtime event handler;
- background planner hook.

Return a typed result:

```ts
interface RadioAgentSessionStartResult {
  opening?: RadioAgentPreparedTrack;
  hostText?: string;
  backgroundStarted: boolean;
  fallbackReason?: string;
}
```

- [ ] **Step 4: Run focused service test**

Run: `npm run build:test && node --test dist/tests/ts/radio-agent-service.test.js`

Expected: PASS.

- [ ] **Step 5: Run related tests**

Run:

```bash
npm run build:test
node --test dist/tests/ts/opening-track.test.js dist/tests/ts/radio-agent-runtime.test.js dist/tests/ts/radio-agent-service.test.js
```

Expected: PASS.

## Task 3: Move Server Handshake Opening Into RadioAgentService

**Files:**
- Modify: `src/server.ts`
- Modify: `tests/ts/radio-agent-server-wiring.test.ts`
- Modify as needed: `src/radio-agent/radioAgentService.ts`

- [ ] **Step 1: Write failing server wiring test**

Add an assertion that the websocket handshake delegates opening selection through `RadioAgentService` rather than calling `chooseOpeningTrack` directly from `src/server.ts`.

Expected RED: test fails because server still imports/calls opening selector directly.

- [ ] **Step 2: Refactor server handshake**

Remove station intelligence from handshake:

- server gathers websocket/session inputs;
- service decides opening;
- server sends the returned track/host payload;
- legacy fallback remains after service result says no safe opening.

- [ ] **Step 3: Run focused tests**

Run:

```bash
npm run build:test
node --test dist/tests/ts/radio-agent-server-wiring.test.js dist/tests/ts/radio-agent-service.test.js
```

Expected: PASS.

- [ ] **Step 4: Run typecheck**

Run: `npm run typecheck`

Expected: PASS.

## Task 4: Add Direction Handling To RadioAgentService

**Files:**
- Modify: `src/radio-agent/radioAgentService.ts`
- Modify: `tests/ts/radio-agent-service.test.ts`
- Modify as needed: `src/radio-agent/types.ts`

- [ ] **Step 1: Write failing direction test**

Add a test named:

```ts
test("service turns explicit listener direction into a program window and host acknowledgement", async () => {
  // "play quiet jazz for reading" should create a contract-backed window,
  // prepare at least one playable item, and produce a short listener-facing acknowledgement.
});
```

Expected RED: service lacks `handleUserText` or does not return a program action.

- [ ] **Step 2: Implement minimal `handleUserText` delegation**

The service should:

- send the event to `RadioAgentRuntime`;
- receive or fetch the latest program window;
- ask `ProgramExecutor` to prepare a playable item;
- return host speech only when the host policy says it is useful;
- expose whether incompatible queue items should be cleared.

- [ ] **Step 3: Run focused tests**

Run: `npm run build:test && node --test dist/tests/ts/radio-agent-service.test.js`

Expected: PASS.

## Task 5: Add Track-End Continuation And No-Stall Behavior

**Files:**
- Modify: `src/radio-agent/radioAgentService.ts`
- Modify: `tests/ts/radio-agent-service.test.ts`
- Modify: `tests/ts/radio-agent-live-contract.test.ts`

- [ ] **Step 1: Write failing continuation test**

Add a test named:

```ts
test("service continues from the active contract when a track ends and queue is empty", async () => {
  // Arrange an active contract and empty queue.
  // Assert service returns either a prepared next track or explicit recovery/fallback.
});
```

Expected RED: no track-end API exists.

- [ ] **Step 2: Implement `handleTrackEnded`**

The service should:

- inspect ready queue;
- promote ready item if present;
- if empty, continue from active contract;
- if agent cannot prepare a safe item, return a legacy fallback instruction;
- never return silent no-op.

- [ ] **Step 3: Run focused tests**

Run: `npm run build:test && node --test dist/tests/ts/radio-agent-service.test.js`

Expected: PASS.

## Task 6: Generalize Contract Tests Beyond R&B

**Files:**
- Create or modify: `tests/ts/radio-agent-live-contract.test.ts`
- Modify as needed: existing contract/boundary tests

- [ ] **Step 1: Write failing cross-genre contract tests**

Cover at least:

- R&B vocal/groove direction;
- quiet jazz reading direction;
- quiet focus direction;
- Chinese-language mood request.

Each test should assert:

- active contract is created;
- next 3 planned tasks remain compatible;
- disallowed or bridge-only items are not accepted as ordinary continuation.

- [ ] **Step 2: Run tests to verify RED**

Run: `npm run build:test && node --test dist/tests/ts/radio-agent-live-contract.test.js`

Expected: FAIL where non-R&B directions are not yet contract guarded.

- [ ] **Step 3: Implement general contract guard behavior**

Update contract manager/director/boundary logic only enough to pass the cross-genre tests. Avoid hardcoded single-genre patches.

- [ ] **Step 4: Run related planner tests**

Run:

```bash
npm run build:test
node --test dist/tests/ts/radio-agent-program-director.test.js dist/tests/ts/radio-agent-live-contract.test.js
```

Expected: PASS.

## Task 7: Add Correction Loop Service API

**Files:**
- Modify: `src/radio-agent/radioAgentService.ts`
- Modify: `tests/ts/radio-agent-service.test.ts`
- Modify as needed: `src/radio-agent/radioAgentRuntime.ts`

- [ ] **Step 1: Write failing correction test**

Add a test named:

```ts
test("service repairs the active window after explicit negative feedback", async () => {
  // User says "not this artist" or "this is not what I asked for".
  // Assert incompatible queued items are removed, memory receives session evidence,
  // and the next prepared item reflects the repaired contract.
});
```

Expected RED: correction is not owned by the service.

- [ ] **Step 2: Implement correction flow**

The service should:

- classify explicit negative feedback;
- call runtime for memory/session evidence;
- update or repair the active contract;
- request queue pruning from the server adapter;
- prepare a replacement item;
- return a natural correction acknowledgement if host policy permits.

- [ ] **Step 3: Run focused tests**

Run: `npm run build:test && node --test dist/tests/ts/radio-agent-service.test.js`

Expected: PASS.

## Task 8: Govern Host Speech Naturalness In Service Results

**Files:**
- Modify: `src/radio-agent/radioAgentService.ts`
- Modify: `src/radio-agent/hostPolicy.ts`
- Modify: `tests/ts/radio-agent-service.test.ts`
- Modify: `tests/ts/radio-agent-host-delivery.test.ts`

- [ ] **Step 1: Write failing host text safety tests**

Test that service-returned speech for opening, acknowledgement, correction, recovery, and explanation does not contain banned internal terms or vague fake-DJ phrases.

- [ ] **Step 2: Run RED**

Run:

```bash
npm run build:test
node --test dist/tests/ts/radio-agent-service.test.js dist/tests/ts/radio-agent-host-delivery.test.js
```

Expected: FAIL on missing service-level host filtering.

- [ ] **Step 3: Implement service-level host speech guard**

Ensure all host text leaving the service passes through one listener-facing policy function. Unsafe text should become silence or a safe fallback line.

- [ ] **Step 4: Run related tests**

Expected: PASS.

## Task 9: Wire Live Browser Acceptance Checks

**Files:**
- Modify: existing frontend/browser tests if appropriate
- Add checklist: `docs/superpowers/checklists/2026-06-11-hermes-ai-dj-v1-live-acceptance.md`

- [ ] **Step 1: Write the live acceptance checklist**

Include:

- fast start;
- no end stall;
- user direction;
- correction;
- host naturalness;
- diagnostics visibility.

- [ ] **Step 2: Restart local service with current build**

Run: `npm run dev`

Expected: backend available at `http://127.0.0.1:8000`.

- [ ] **Step 3: Use the in-app browser to perform live checks**

Verify:

- first track starts;
- after simulated or natural track end, next track starts or recovery is visible;
- user direction produces a coherent 3-track continuation;
- correction repairs the next item;
- host speech is natural or silent.

- [ ] **Step 4: Record evidence**

Update the checklist with pass/fail notes and exact failures that remain.

## Task 10: Final v1 Verification Gate

**Files:**
- No production file changes unless failures are found.

- [ ] **Step 1: Run full static verification**

Run:

```bash
npm run typecheck
npm run build
git diff --check
```

Expected: all exit 0; line-ending warnings are acceptable only if `git diff --check` exits 0.

- [ ] **Step 2: Run full tests**

Run: `npm test`

Expected: all tests pass with zero failures.

- [ ] **Step 3: Run live acceptance**

Use the checklist from Task 9.

Expected: all v1 gates pass with evidence.

- [ ] **Step 4: Only then describe status as v1**

If any gate is missing, report the remaining gap and keep status as Alpha/Beta foundation.

If all gates pass, the project may be called Hermes-style AI DJ Radio v1.
