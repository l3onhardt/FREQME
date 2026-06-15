# Hermes Radio Agent Beta Closure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Beta Closure described in `docs/superpowers/specs/2026-06-16-hermes-radio-agent-beta-closure-design.md`: an agent-owned playback loop that routes session events, listener directions, contract checks, playback governance, host speech, fallback honesty, memory evidence, and observability through one coherent service boundary.

**Architecture:** Keep the existing backend and radio-agent modules, but add explicit agent action, contract, governance, registry, and acceptance-harness boundaries. `server.ts` remains the websocket gateway; `RadioAgentService` becomes the only path that approves queue and promotion decisions; `PlaybackGovernor` provides the final hard gate for every candidate before playback.

**Tech Stack:** TypeScript, Node.js, `node:test`, existing FREQME websocket backend, existing `src/radio-agent/*`, `src/radio/*`, NetEase/audio/TTS adapters, SQLite-backed `RadioAgentStore`.

---

## Scope Discipline

This plan implements the approved Beta Closure spec. It does not attempt full Hermes AI DJ v1, perfect genre recognition, or a full rewrite of the old radio stack.

R&B, quiet jazz, focus music, and Chinese mood requests are only regression samples. Do not add one-off genre patches unless they become centralized style registry data and pass cross-style tests.

The current worktree is dirty with prior uncommitted implementation changes. Before executing tasks, preserve useful changes, avoid reverting unrelated user work, and commit only focused verified slices. Do not stage `dev-server.log` or `dev-server.err.log`.

## File Structure

Create:

- `src/radio-agent/agentActions.ts`
  - Defines typed `RadioAgentAction`, `FallbackLevel`, and action result helpers used by service and gateway.
- `src/radio-agent/contractController.ts`
  - Owns session contract creation, update, markdown conversion, and persistence-friendly contract state.
- `src/radio-agent/playbackGovernor.ts`
  - Applies final contract, duplicate, stale request, seed exhaustion, audio, and host text checks. Emits `PlaybackGovernanceTrace`.
- `src/radio-agent/styleSeedRegistry.ts`
  - Centralizes deterministic style markers, concrete queries, blocked terms, seed groups, cooldowns, and exhaustion policy.
- `tests/ts/radio-agent-contract-controller.test.ts`
  - Contract creation, not-found preservation, correction replacement, markdown conversion.
- `tests/ts/radio-agent-playback-governor.test.ts`
  - Hard gate tests for direct positive, registry style, bridge, duplicate, stale request, seed exhaustion, off-contract, and trace schema.
- `tests/ts/radio-agent-style-seed-registry.test.ts`
  - Cross-style registry behavior for R&B, quiet jazz, focus/quiet, and Chinese mood markers.
- `tests/js/radio-agent-live-smoke.test.mjs`
  - Scriptable websocket smoke harness for request + 3 track ends, correction, audio probes, duplicate rejection, host text scan, and status checks.

Modify:

- `src/radio-agent/types.ts`
  - Add shared action, contract, governance, and trace types only if they are not housed in the new focused files.
- `src/radio-agent/radioAgentService.ts`
  - Route session start, user text, correction, queue low, and track end through explicit actions and the governor.
- `src/radio-agent/programDirector.ts`
  - Consume contract semantics and style registry without adding more one-off style branches.
- `src/radio-agent/programExecutor.ts`
  - Return prepared candidates and trace data; do not directly imply final playback approval.
- `src/radio-agent/radioAgentRuntime.ts`
  - Persist contract, governance traces, and memory updates without owning websocket behavior.
- `src/radio/searchVerifyAgent.ts`
  - Replace scattered deterministic style seed logic with `styleSeedRegistry` calls.
- `src/radio/requestReadySelector.ts`
  - Keep queue utilities, but delegate contract and duplicate approval to `PlaybackGovernor` where possible.
- `src/server.ts`
  - Become a gateway that executes `RadioAgentAction`s and avoids direct station intelligence.
- `tests/ts/radio-agent-service.test.ts`
  - Expand service tests for typed actions and governor routing.
- `tests/ts/radio-agent-server-wiring.test.ts`
  - Assert server routes session/user text/correction/track end/fallback through the service.
- `tests/ts/search-verify-agent.test.ts`
  - Update style seed tests to assert registry behavior, not ad hoc branches.
- `tests/js/radio-websocket.test.mjs`
  - Keep frontend websocket behavior tests aligned with new action/status messages.
- `docs/superpowers/checklists/2026-06-11-hermes-ai-dj-v1-live-acceptance.md`
  - Update only after fresh live evidence.

Do not create a large new framework. Add small focused files and wire them into existing modules.

## Verification Commands

Use these commands throughout:

```powershell
npx tsx --test tests/ts/radio-agent-contract-controller.test.ts
npx tsx --test tests/ts/radio-agent-playback-governor.test.ts
npx tsx --test tests/ts/radio-agent-style-seed-registry.test.ts
npx tsx --test tests/ts/radio-agent-service.test.ts
npx tsx --test tests/ts/radio-agent-server-wiring.test.ts
npx tsx --test tests/ts/search-verify-agent.test.ts
node --test tests/js/radio-websocket.test.mjs
node --test tests/js/radio-agent-live-smoke.test.mjs
npm run typecheck
npm run build
```

Full final verification:

```powershell
npx tsx --test tests/ts/radio-agent-assisted-queue.test.ts tests/ts/radio-agent-program-executor.test.ts tests/ts/radio-agent-program-director.test.ts tests/ts/radio-agent-runtime.test.ts tests/ts/radio-agent-server-wiring.test.ts tests/ts/radio-agent-service.test.ts tests/ts/radio-agent-contract-controller.test.ts tests/ts/radio-agent-playback-governor.test.ts tests/ts/radio-agent-style-seed-registry.test.ts tests/ts/request-ready-selector.test.ts tests/ts/track-end-recovery.test.ts tests/ts/boundary-guard.test.ts tests/ts/search-verify-agent.test.ts
node --test tests/js/radio-websocket.test.mjs tests/js/radio-agent-live-smoke.test.mjs
npm run typecheck
npm run build
```

Live server startup for manual smoke:

```powershell
$conn = Get-NetTCPConnection -LocalPort 8000 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($conn) { Stop-Process -Id $conn.OwningProcess -Force }
Start-Sleep -Milliseconds 700
Start-Process -FilePath 'npm.cmd' -ArgumentList @('run','start:local') -WorkingDirectory (Get-Location) -RedirectStandardOutput dev-server.log -RedirectStandardError dev-server.err.log -PassThru -WindowStyle Hidden
Start-Sleep -Seconds 4
Invoke-RestMethod -Uri 'http://127.0.0.1:8000/health' -UseBasicParsing
```

## Task 1: Baseline Audit And Plan Commit

**Files:**
- Read: `docs/superpowers/specs/2026-06-16-hermes-radio-agent-beta-closure-design.md`
- Read: current `git status`
- Create: this plan file

- [ ] **Step 1: Confirm branch and dirty state**

Run: `git status --short --branch`

Expected: branch is `codex/hermes-radio-agent-service`; unrelated dirty implementation changes may exist; `dev-server*.log` are untracked and must not be staged.

- [ ] **Step 2: Confirm closure spec exists and is approved**

Run:

```powershell
rg -n "Contract Match Semantics|PlaybackGovernor|Acceptance Gates|Live Smoke Matrix" docs/superpowers/specs/2026-06-16-hermes-radio-agent-beta-closure-design.md
```

Expected: all sections are present.

- [ ] **Step 3: Save this implementation plan**

Write this plan to `docs/superpowers/plans/2026-06-16-hermes-radio-agent-beta-closure-plan.md`.

- [ ] **Step 4: Run plan review loop**

Dispatch a plan reviewer with:

- plan path: `docs/superpowers/plans/2026-06-16-hermes-radio-agent-beta-closure-plan.md`
- spec path: `docs/superpowers/specs/2026-06-16-hermes-radio-agent-beta-closure-design.md`

Expected: reviewer returns Approved. Fix any blocking issues before implementation.

- [ ] **Step 5: Commit plan only**

Run:

```powershell
git add -- docs/superpowers/plans/2026-06-16-hermes-radio-agent-beta-closure-plan.md
git commit -m "Plan Hermes radio agent beta closure"
```

Expected: commit includes only the plan.

## Task 2: Define Typed Agent Actions

**Files:**
- Create: `src/radio-agent/agentActions.ts`
- Test: `tests/ts/radio-agent-service.test.ts`

- [ ] **Step 1: Write failing tests for action shape**

In `tests/ts/radio-agent-service.test.ts`, add tests that require service responses to expose explicit action intent:

```ts
test("service exposes explicit play action for a prepared opening", async () => {
  // Arrange service with chooseOpeningTrack and prepareTrack fakes.
  // Act: startSession(...)
  // Assert: result.actions includes { type: "play_now", ... } or equivalent action contract.
});

test("service exposes honest_not_found action when user direction has no playable candidate", async () => {
  // Arrange handleRadioAgentEvent returning a program window but executor/queue cannot prepare a track.
  // Act: handleUserText(...)
  // Assert: result includes action type "honest_not_found" with active contract context.
});
```

Expected RED: tests fail because service result still exposes implicit fields rather than action family.

- [ ] **Step 2: Run focused test to verify RED**

Run: `npx tsx --test tests/ts/radio-agent-service.test.ts`

Expected: FAIL for missing action contract.

- [ ] **Step 3: Create `agentActions.ts`**

Add:

```ts
import type { SelectionReason, Track } from "../types.js";
import type { RadioAgentPreparedTrack, RadioAgentProgramWindow } from "./types.js";
import type { AgentSessionContract } from "./contractController.js";

export type FallbackLevel =
  | "agent_program"
  | "same_contract_verified"
  | "same_contract_recent_safe"
  | "legacy_with_label"
  | "honest_not_found";

export type RadioAgentAction =
  | { type: "play_now"; track: Track; url: string; reason: SelectionReason; hostText?: string }
  | { type: "queue_window"; window: RadioAgentProgramWindow; prepared: RadioAgentPreparedTrack[] }
  | { type: "speak"; text: string; speechRole: "opening" | "ack" | "correction" | "recovery" | "explanation" }
  | { type: "stay_silent"; reason: string }
  | { type: "repair_contract"; contract: AgentSessionContract; reason: string }
  | { type: "fallback"; level: FallbackLevel; reason: string; action?: RadioAgentAction }
  | { type: "honest_not_found"; contract: AgentSessionContract | null; reason: string; searchedQueries: string[] };

export interface RadioAgentActionResult {
  actions: RadioAgentAction[];
}

export function actionTypes(actions: RadioAgentAction[]): string[] {
  return actions.map((action) => action.type);
}
```

If circular imports appear, move `AgentSessionContract` to `types.ts`.

- [ ] **Step 4: Add action arrays to service result types**

Modify `src/radio-agent/radioAgentService.ts` result interfaces to include:

```ts
actions: RadioAgentAction[];
```

Keep existing fields temporarily for compatibility.

- [ ] **Step 5: Make tests pass minimally**

Add `play_now`, `speak`, `stay_silent`, `fallback`, or `honest_not_found` actions in service methods without changing server behavior yet.

- [ ] **Step 6: Run focused service test**

Run: `npx tsx --test tests/ts/radio-agent-service.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit**

Run:

```powershell
git add src/radio-agent/agentActions.ts src/radio-agent/radioAgentService.ts tests/ts/radio-agent-service.test.ts
git commit -m "Add typed radio agent actions"
```

## Task 3: Add ContractController

**Files:**
- Create: `src/radio-agent/contractController.ts`
- Create: `tests/ts/radio-agent-contract-controller.test.ts`
- Modify: `src/radio-agent/types.ts` only if shared types are better centralized there.

- [ ] **Step 1: Write failing tests**

Create tests:

```ts
test("explicit listener direction creates a session contract immediately", () => {
  const controller = new ContractController({ now: () => "2026-06-16T00:00:00.000Z" });
  const contract = controller.fromUserDirection({
    uid: null,
    sessionId: -1,
    text: "play quiet jazz for reading",
    sourceEventId: "event-1",
  });
  assert.equal(contract.rawUserText, "play quiet jazz for reading");
  assert.match(contract.stationBrief, /quiet jazz/i);
  assert.equal(contract.sourceEventId, "event-1");
});

test("not-found does not clear active contract", () => {
  const controller = new ContractController({ now: () => "2026-06-16T00:00:00.000Z" });
  const contract = controller.fromUserDirection({ uid: null, sessionId: -1, text: "play rnb", sourceEventId: "event-1" });
  const retained = controller.recordNotFound(contract, { searchedQueries: ["Daniel Caesar Japanese Denim"] });
  assert.equal(retained.id, contract.id);
  assert.equal(retained.status, "active");
});

test("correction replaces incompatible contract and records repair reason", () => {
  // quiet jazz -> correction to late-night R&B should create a new active contract with prior id in repairedFrom.
});
```

Expected RED: module missing.

- [ ] **Step 2: Run RED**

Run: `npx tsx --test tests/ts/radio-agent-contract-controller.test.ts`

Expected: FAIL because `contractController.ts` does not exist.

- [ ] **Step 3: Implement minimal contract controller**

Create:

```ts
export interface AgentSessionContract {
  id: string;
  uid: string | null;
  sessionId: number | null;
  rawUserText: string;
  stationBrief: string;
  positiveAnchors: string[];
  disallowed: string[];
  allowedAdjacent: string[];
  bridgeBudget: number;
  returnRequirement: string;
  sourceEventId: string;
  status: "active" | "repaired" | "expired";
  repairedFrom?: string;
  createdAt: string;
  updatedAt: string;
}
```

Add methods:

- `fromUserDirection(args)`
- `recordNotFound(contract, args)`
- `repairFromCorrection(contract, args)`
- `toProgramContractMarkdown(contract)`
- `fromProgramWindow(window)`
- `fromMarkdown(markdown)`

Use conservative deterministic anchors:

- R&B marker creates anchors `["R&B", "alt-R&B", "neo-soul", "soul"]`.
- Jazz marker creates anchors `["jazz", "soft jazz piano", "light acoustic jazz"]`.
- Focus/quiet marker creates anchors `["quiet", "focus", "soft", "low energy"]`.
- Chinese mood text keeps raw text and normalized broad anchors; do not overclaim.

- [ ] **Step 4: Run contract controller tests**

Run: `npx tsx --test tests/ts/radio-agent-contract-controller.test.ts`

Expected: PASS.

- [ ] **Step 5: Add markdown round-trip test**

Add:

```ts
test("contract markdown round-trips fields used by runtime artifacts", () => {
  // toProgramContractMarkdown then fromMarkdown preserves stationBrief, anchors, disallowed, bridgeBudget.
});
```

Run and expect PASS.

- [ ] **Step 6: Commit**

Run:

```powershell
git add src/radio-agent/contractController.ts tests/ts/radio-agent-contract-controller.test.ts src/radio-agent/types.ts
git commit -m "Add radio agent contract controller"
```

## Task 4: Add PlaybackGovernor Hard Gate

**Files:**
- Create: `src/radio-agent/playbackGovernor.ts`
- Test: `tests/ts/radio-agent-playback-governor.test.ts`
- Modify: `src/radio-agent/agentActions.ts` if `FallbackLevel` or trace types need importing.
- Reuse: `src/radio/boundaryGuard.ts`

- [ ] **Step 1: Write failing tests for accepted direct-positive candidate**

Create:

```ts
test("governor accepts direct positive evidence inside active contract", async () => {
  const governor = new PlaybackGovernor({ boundaryGuard: new BoundaryGuard(), resolveAudio: playableAudio });
  const result = await governor.evaluate({
    contract: rnbContract(),
    requestToken: 1,
    activeRequestToken: 1,
    candidate: { id: "sza", name: "Good Days", artist: "SZA" },
    url: "/api/radio/audio/sza",
    currentTrack: null,
    recentTracks: [],
    readyQueue: [],
    seedState: emptySeedState(),
    hostText: "I will keep this in R&B.",
  });
  assert.equal(result.status, "accepted");
  assert.equal(result.trace.decision, "direct_positive");
});
```

Expected RED: module missing.

- [ ] **Step 2: Write failing rejection tests**

Tests:

- rejects stale request token;
- rejects same id as current track;
- rejects normalized artist/title in last 8 recent tracks;
- rejects duplicate ready queue item;
- rejects off-contract candidate under active explicit contract;
- rejects query/source laundering as positive evidence;
- rejects audio resolution failure before semantic acceptance;
- rejects exhausted seed group;
- rejects unsafe host text;
- emits trace with `contractId`, `candidateKey`, `decision`, `evidence`.
- accepts `model_semantic` when deterministic metadata is insufficient but a fake semantic evaluator returns structured fit evidence.
- refuses `model_semantic` acceptance when stale request, hard blocks, duplicate current/recent/ready items, audio rejection, seed exhaustion, or unsafe host text apply. Assert the fake evaluator is not called on those hard rejection paths.

- [ ] **Step 3: Run RED**

Run: `npx tsx --test tests/ts/radio-agent-playback-governor.test.ts`

Expected: FAIL because module missing.

- [ ] **Step 4: Implement governor types**

Add:

```ts
export interface PlaybackGovernanceTrace { ... }
export type PlaybackGovernanceDecision = ...
export interface ModelSemanticFitEvaluator {
  evaluate(args: {
    contract: AgentSessionContract;
    candidate: Track;
    negativeConstraints: string[];
  }): Promise<{ accepted: boolean; evidence: string[] }>;
}
export interface PlaybackGovernorArgs { ... }
export type PlaybackGovernorResult =
  | { status: "accepted"; track: Track; url: string; trace: PlaybackGovernanceTrace }
  | { status: "rejected"; reason: PlaybackGovernanceDecision; trace: PlaybackGovernanceTrace };
```

- [ ] **Step 5: Implement identity helpers**

Functions:

- `trackKey(track): string`
- `sameTrack(left, right): boolean`
- `recentDuplicate(candidate, currentTrack, recentTracks, windowSize = 8)`
- `readyDuplicate(candidate, readyQueue)`
- `detectAlternatingLoop(promotedKeys, windowSize = 6)`

Use normalized lower-case artist + title and id comparison.

- [ ] **Step 6: Implement deterministic contract checks**

Use `BoundaryGuard` plus contract-controller anchors:

- hard blocks always reject;
- direct positive evidence checks candidate metadata only;
- source/query/reason are diagnostics but not positive evidence;
- bridge allowed only with remaining budget and return requirement;
- if hard/stale/duplicate/seed/audio/host rejection paths do not apply and deterministic metadata is insufficient, call optional `ModelSemanticFitEvaluator` with the active contract, candidate, and negative constraints;
- accept semantic fit only when the evaluator returns `{ accepted: true, evidence: [...] }`, persist evidence in trace, and set `trace.decision` to `model_semantic`;
- reject semantic non-fit as off-contract/honest fallback evidence, never as a silent pass-through.

- [ ] **Step 7: Implement host text safety check**

Reject if host text contains:

- `prompt`
- `model`
- `JSON`
- `candidate`
- `trace`
- `contract`
- `tool call`
- `verification`
- `pipeline`
- `shadow mode`
- `main line`
- `texture beside it`
- mojibake/replacement characters.

- [ ] **Step 8: Run governor tests**

Run: `npx tsx --test tests/ts/radio-agent-playback-governor.test.ts`

Expected: PASS.

- [ ] **Step 9: Run existing boundary tests**

Run:

```powershell
npx tsx --test tests/ts/boundary-guard.test.ts tests/ts/radio-agent-playback-governor.test.ts
```

Expected: PASS.

- [ ] **Step 10: Commit**

Run:

```powershell
git add src/radio-agent/playbackGovernor.ts tests/ts/radio-agent-playback-governor.test.ts
git commit -m "Add radio agent playback governor"
```

## Task 5: Add StyleSeedRegistry

**Files:**
- Create: `src/radio-agent/styleSeedRegistry.ts`
- Test: `tests/ts/radio-agent-style-seed-registry.test.ts`
- Modify later: `src/radio/searchVerifyAgent.ts`

- [ ] **Step 1: Write failing registry tests**

Create tests:

```ts
test("registry resolves R&B markers without making R&B the product center", () => {
  const registry = defaultStyleSeedRegistry();
  const match = registry.match("play rnb");
  assert.equal(match?.id, "rnb");
  assert.ok(match?.concreteQueries.some((query) => /Daniel Caesar|SZA|Frank Ocean/i.test(query)));
});

test("registry resolves quiet jazz markers", () => {
  const match = defaultStyleSeedRegistry().match("play quiet jazz for reading");
  assert.equal(match?.id, "quiet_jazz");
});

test("registry resolves focus quiet markers", () => {
  const match = defaultStyleSeedRegistry().match("play quiet focus music");
  assert.equal(match?.id, "quiet_focus");
});

test("registry keeps Chinese mood as a bounded style profile", () => {
  const chineseQuietMood = "\u653e\u70b9\u665a\u4e0a\u5b89\u9759\u4e00\u70b9\u7684\u6b4c";
  const match = defaultStyleSeedRegistry().match(chineseQuietMood);
  assert.ok(match);
});

test("registry reports seed group exhaustion after cooldown window", () => {
  // Given recent promoted keys from the same group, next query group is exhausted.
});
```

Expected RED: module missing.

Use Unicode escapes for Chinese test strings and harness constants in source files. This keeps PowerShell, git, and terminal encodings from corrupting regression fixtures.

- [ ] **Step 2: Run RED**

Run: `npx tsx --test tests/ts/radio-agent-style-seed-registry.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement registry**

Define:

```ts
export interface StyleSeedDefinition {
  id: string;
  markers: string[];
  concreteQueries: string[];
  blockedTerms: string[];
  allowedAdjacent: string[];
  seedGroups: Array<{ id: string; queryKeys: string[]; cooldownTracks: number }>;
  exhaustion: "honest_not_found" | "widen_with_contract" | "legacy_with_label";
}
```

Add definitions for:

- `rnb`
- `quiet_jazz`
- `quiet_focus`
- `chinese_quiet_mood`

Keep the query list short and testable. Do not add a large music database.

- [ ] **Step 4: Implement seed state helpers**

Add helpers:

- `match(text)`
- `queriesFor(text, recentTracks)`
- `isSeedGroupExhausted(definition, groupId, recentTrackKeys)`
- `blockedTermsFor(text)`

- [ ] **Step 5: Run registry tests**

Run: `npx tsx --test tests/ts/radio-agent-style-seed-registry.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

Run:

```powershell
git add src/radio-agent/styleSeedRegistry.ts tests/ts/radio-agent-style-seed-registry.test.ts
git commit -m "Add radio agent style seed registry"
```

## Task 6: Integrate Registry Into SearchVerifyAgent Without Expanding Genre Patches

**Files:**
- Modify: `src/radio/searchVerifyAgent.ts`
- Modify: `tests/ts/search-verify-agent.test.ts`
- Use: `src/radio-agent/styleSeedRegistry.ts`

- [ ] **Step 1: Write failing tests for registry-backed query generation**

Update existing tests so `SearchVerifyAgent.queries(...)` uses registry output for:

- R&B;
- quiet jazz;
- focus/quiet;
- Chinese quiet mood.

Add assertion that no new style-specific branch name appears in `SearchVerifyAgent`:

```ts
test("style fallback queries come from registry instead of local ad hoc branches", async () => {
  // Arrange registry-like style request.
  // Assert queries match registry definitions.
});
```

Expected RED: current query behavior may be ad hoc or missing focus/Chinese mood registry paths.

- [ ] **Step 2: Run focused tests**

Run:

```powershell
npx tsx --test tests/ts/search-verify-agent.test.ts tests/ts/radio-agent-style-seed-registry.test.ts
```

Expected: FAIL for missing registry integration.

- [ ] **Step 3: Inject or import registry**

Modify `SearchVerifyAgent` to accept optional registry dependency or use `defaultStyleSeedRegistry()`.

Keep constructor backward compatible:

```ts
constructor(llm, netease, audioResolver, llmTimeoutMs = 12000, styleRegistry = defaultStyleSeedRegistry()) {}
```

- [ ] **Step 4: Replace style seed methods**

Refactor:

- `fastStyleQueries`
- `styleSeedQueries`
- `recentLocalSeedQueryKeys`

so they call registry methods and seed group cooldowns.

Do not remove existing tests until new registry-backed behavior passes.

- [ ] **Step 5: Run search verifier tests**

Run: `npx tsx --test tests/ts/search-verify-agent.test.ts tests/ts/radio-agent-style-seed-registry.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

Run:

```powershell
git add src/radio/searchVerifyAgent.ts tests/ts/search-verify-agent.test.ts src/radio-agent/styleSeedRegistry.ts tests/ts/radio-agent-style-seed-registry.test.ts
git commit -m "Route style seeds through radio agent registry"
```

## Task 7: Route RadioAgentService Through ContractController And PlaybackGovernor

**Files:**
- Modify: `src/radio-agent/radioAgentService.ts`
- Modify: `src/radio-agent/contractController.ts`
- Modify: `src/radio-agent/playbackGovernor.ts`
- Modify: `tests/ts/radio-agent-service.test.ts`

- [ ] **Step 1: Write failing user direction contract test**

Add:

```ts
test("service creates and retains a contract when explicit direction cannot queue a playable item", async () => {
  // handleRadioAgentEvent returns no programWindow or queueProgramWindow returns false.
  // Act handleUserText("play quiet jazz for reading")
  // Assert actions include repair_contract or honest_not_found with active contract.
  // Assert service exposes active contract for later track end.
});
```

Expected RED: service currently can return not-found/fallback without durable contract action.

- [ ] **Step 2: Write failing governor routing test**

Add:

```ts
test("service rejects prepared duplicate through playback governor before queueing", async () => {
  // Arrange preparedTrack same normalized artist/title as recentTracks.
  // Assert queue.addReady not called and actions include honest_not_found or fallback reason reject_duplicate_recent.
});
```

Expected RED: assisted queue or service may not apply a single governor path.

- [ ] **Step 3: Run RED**

Run: `npx tsx --test tests/ts/radio-agent-service.test.ts`

Expected: FAIL.

- [ ] **Step 4: Inject dependencies**

Extend `RadioAgentServiceDeps`:

```ts
contractController?: ContractController;
playbackGovernor?: PlaybackGovernor;
activeContractStore?: {
  get(uid: string | null, sessionId: number | null): AgentSessionContract | null;
  set(contract: AgentSessionContract): void;
};
```

Use in-memory fallback for anonymous sessions if no store is supplied. Store keys must be explicit and must never collapse anonymous listeners into a global `anon` bucket:

```ts
function contractStoreKey(uid: string | null, sessionId: number | null): string {
  if (uid) return `uid:${uid}`;
  if (sessionId != null) return `session:${sessionId}`;
  throw new Error("radio agent contract requires uid or sessionId");
}
```

Anonymous websocket sessions must receive a stable per-socket `sessionId` before any contract write. Clear that in-memory anonymous contract on socket/session close.

- [ ] **Step 5: Update user text flow**

In `handleUserText` and `handleCorrection`:

- create or repair contract immediately;
- clear incompatible queue when requested;
- run program window preparation;
- evaluate prepared candidate through governor before queueing;
- return explicit actions and governance trace;
- preserve contract after not-found.

- [ ] **Step 6: Update track end flow**

In `handleTrackEnded`:

- if ready item exists, require governor revalidation before promotion action;
- if queue empty, trigger queue-low planning with active contract;
- if no safe candidate, return `honest_not_found` or honest fallback action;
- do not drop contract.

- [ ] **Step 6a: Add queue-low contract/gateway ordering test**

Add a focused service test proving the queue-low path retrieves the active contract and applies the playback governor before the gateway/server sees a promotable action:

```ts
test("queue-low continuation uses active contract and governor before gateway promotion", async () => {
  // Arrange active contract, empty ready queue, and a prepared candidate requiring governance.
  // Assert contractStore.get is called with uid/session key, governor.evaluate runs, and emitted action includes governanceTrace before any play/segue action.
});
```

Expected RED: current queue-low path may bypass active contract or governor ordering.

- [ ] **Step 7: Run service tests**

Run: `npx tsx --test tests/ts/radio-agent-service.test.ts tests/ts/radio-agent-contract-controller.test.ts tests/ts/radio-agent-playback-governor.test.ts`

Expected: PASS.

- [ ] **Step 8: Commit**

Run:

```powershell
git add src/radio-agent/radioAgentService.ts src/radio-agent/contractController.ts src/radio-agent/playbackGovernor.ts tests/ts/radio-agent-service.test.ts
git commit -m "Route radio agent service through contract and governor"
```

## Task 8: Gateway Server Executes Actions Instead Of Owning Station Intelligence

**Files:**
- Modify: `src/server.ts`
- Modify: `tests/ts/radio-agent-server-wiring.test.ts`
- Modify: `tests/js/radio-websocket.test.mjs`

- [ ] **Step 1: Write failing wiring tests**

Add assertions:

- websocket handshake calls `radioAgentService.startSession`;
- `song_request` calls `handleUserText` or `handleCorrection`;
- `track_ended` calls `handleTrackEnded`;
- final queue promotion occurs only after service/governor-approved path;
- legacy fallback is executed only from explicit fallback action or no active contract.

Expected RED: direct server paths still exist.

- [ ] **Step 2: Run RED**

Run: `npx tsx --test tests/ts/radio-agent-server-wiring.test.ts`

Expected: FAIL.

- [ ] **Step 3: Add action executor helper in server**

Inside `handleRadioSocket`, add a small helper:

```ts
const executeRadioAgentActions = async (actions: RadioAgentAction[]): Promise<boolean> => {
  // speak -> synthesizeAndSendDjMessage
  // play_now -> queue/promote/send track
  // queue_window -> add approved prepared tracks
  // honest_not_found -> request_status not_found
  // fallback -> execute nested action or labeled legacy fallback only if allowed
};
```

Keep it gateway-level. Do not add planning logic here.

- [ ] **Step 4: Replace direct promotion paths**

Update:

- handshake opening path;
- `song_request`;
- `track_ended`;
- `skip` correction path;
- queue-low continuation path.

Server may still call old `fillQueue` only through a labeled fallback action or when no active explicit contract exists.

- [ ] **Step 5: Keep browser message compatibility**

Ensure existing websocket messages still include:

- `session_start`
- `intro`
- `request_status`
- `dj_message`
- `play_track`
- `segue`
- `error`

- [ ] **Step 6: Run server and websocket tests**

Run:

```powershell
npx tsx --test tests/ts/radio-agent-server-wiring.test.ts tests/ts/radio-agent-service.test.ts
node --test tests/js/radio-websocket.test.mjs
```

Expected: PASS.

- [ ] **Step 7: Commit**

Run:

```powershell
git add src/server.ts tests/ts/radio-agent-server-wiring.test.ts tests/js/radio-websocket.test.mjs
git commit -m "Execute radio playback through agent actions"
```

## Task 9: Persist Governance Traces And Status

**Files:**
- Modify: `src/radio-agent/radioAgentRuntime.ts`
- Modify: `src/radio-agent/contextArtifacts.ts`
- Modify: `src/radio-agent/types.ts`
- Modify: `tests/ts/radio-agent-runtime.test.ts`
- Modify: `tests/ts/radio-agent-context.test.ts`

- [ ] **Step 1: Write failing trace persistence test**

Add:

```ts
test("runtime records playback governance traces for accepted and rejected candidates", async () => {
  // Persist an event with governanceTrace payload.
  // Assert status/explainability or recent decisions include contractId, candidateKey, decision, evidence.
});
```

Expected RED: runtime does not expose governance trace.

- [ ] **Step 2: Run RED**

Run: `npx tsx --test tests/ts/radio-agent-runtime.test.ts tests/ts/radio-agent-context.test.ts`

Expected: FAIL.

- [ ] **Step 3: Add governance trace payload support**

Update event normalization and status building to include compact traces:

- accepted direct-positive fixture;
- bridge-allowed fixture;
- rejected duplicate/off-contract fixture.

- [ ] **Step 4: Add status endpoint explainability fields**

Expose listener-safe summary:

```ts
governance: {
  lastAccepted?: { contractId; candidateKey; decision; evidence }
  lastRejected?: { contractId; candidateKey; decision; evidence }
}
```

- [ ] **Step 5: Run focused tests**

Run: `npx tsx --test tests/ts/radio-agent-runtime.test.ts tests/ts/radio-agent-context.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

Run:

```powershell
git add src/radio-agent/radioAgentRuntime.ts src/radio-agent/contextArtifacts.ts src/radio-agent/types.ts tests/ts/radio-agent-runtime.test.ts tests/ts/radio-agent-context.test.ts
git commit -m "Expose radio agent governance traces"
```

## Task 10: HostController Corpus Tightening

**Files:**
- Modify: `src/radio-agent/hostDelivery.ts`
- Modify: `src/radio-agent/programDirector.ts`
- Modify: `src/radio-agent/programExecutor.ts`
- Modify: `tests/ts/radio-agent-program-director.test.ts`
- Modify: `tests/ts/radio-agent-program-executor.test.ts`
- Modify: `tests/ts/radio-agent-service.test.ts`

- [ ] **Step 1: Write host corpus tests**

Add tests for:

- opening speech allowed;
- direction acknowledgement allowed;
- correction acknowledgement allowed;
- recovery speech allowed;
- explanation speech allowed;
- ordinary on-contract continuation silent;
- internal words rejected;
- mojibake/replacement characters rejected.

Example:

```ts
test("ordinary on-contract continuation stays silent after initial acknowledgement", async () => {
  // Build active contract + current track + ready queue.
  // Assert hostIntent.shouldSpeak is false for ordinary continuation.
});
```

Expected RED: some paths still speak too often or allow unsafe text.

- [ ] **Step 2: Run RED**

Run:

```powershell
npx tsx --test tests/ts/radio-agent-program-director.test.ts tests/ts/radio-agent-program-executor.test.ts tests/ts/radio-agent-service.test.ts
```

Expected: FAIL for host corpus gaps.

- [ ] **Step 3: Centralize host text safety**

Create or reuse one function:

```ts
export function safeListenerHostText(text: string, role: HostSpeechRole): string;
```

Apply it consistently in director, executor, service delivery, and server gateway.

- [ ] **Step 4: Enforce host density**

Track speech role in service result or session state so request + 3 track-end flow has no more than one non-recovery ordinary continuation speech after the first acknowledgement.

- [ ] **Step 5: Run host tests**

Run focused host tests.

Expected: PASS.

- [ ] **Step 6: Commit**

Run:

```powershell
git add src/radio-agent/hostDelivery.ts src/radio-agent/programDirector.ts src/radio-agent/programExecutor.ts src/radio-agent/radioAgentService.ts tests/ts/radio-agent-program-director.test.ts tests/ts/radio-agent-program-executor.test.ts tests/ts/radio-agent-service.test.ts
git commit -m "Tighten radio agent host speech corpus"
```

## Task 11: Memory Persistence Gate

**Files:**
- Modify: `src/radio-agent/tasteDistiller.ts`
- Modify: `src/radio-agent/radioAgentRuntime.ts`
- Modify: `src/radio-agent/contractController.ts`
- Modify: `tests/ts/radio-agent-runtime.test.ts`
- Add if needed: `tests/ts/radio-agent-memory-persistence.test.ts`

- [ ] **Step 1: Write failing memory persistence test**

Add:

```ts
test("three explicit avoid signals survive restart and influence later continuation", async () => {
  // Arrange in-memory or temp store.
  // Emit three explicit avoid events for same artist/style.
  // Recreate runtime/service to simulate restart.
  // Assert memory artifact contains durable avoid.
  // Assert later planning/contract context includes avoid and service does not use it as positive anchor.
});
```

Expected RED: restart influence is incomplete or not asserted.

- [ ] **Step 2: Write one-skip-not-durable test**

Add:

```ts
test("one skip remains session evidence and does not become durable dislike", async () => {
  // Emit one skipped track.
  // Restart.
  // Assert no durable avoid fact is created.
});
```

- [ ] **Step 3: Run RED**

Run:

```powershell
npx tsx --test tests/ts/radio-agent-runtime.test.ts tests/ts/radio-agent-memory-persistence.test.ts
```

Expected: FAIL.

- [ ] **Step 4: Implement distillation threshold**

Update distiller/runtime:

- 3 explicit preference signals -> durable preference fact;
- 3 explicit avoid signals -> durable avoid fact;
- one skip -> session evidence only;
- durable avoid never becomes positive anchor.

- [ ] **Step 5: Run memory tests**

Run focused memory tests.

Expected: PASS.

- [ ] **Step 6: Commit**

Run:

```powershell
git add src/radio-agent/tasteDistiller.ts src/radio-agent/radioAgentRuntime.ts src/radio-agent/contractController.ts tests/ts/radio-agent-runtime.test.ts tests/ts/radio-agent-memory-persistence.test.ts
git commit -m "Persist explicit radio agent memory signals"
```

## Task 12: Live Websocket Smoke Harness

**Files:**
- Create: `tests/js/radio-agent-live-smoke.test.mjs`
- Modify: `package.json` only if adding a script is useful.

- [ ] **Step 1: Write failing live smoke harness**

Create a Node test that:

- connects to `ws://127.0.0.1:8000/ws`;
- handshakes anonymous session;
- waits for first playable `play_track` or `segue`;
- sends each required direction;
- waits for request track;
- sends 3 `track_ended`;
- probes each audio URL with `Range: bytes=0-8191`;
- fails on websocket `error`;
- fails on duplicate normalized artist/title key;
- fails on unsafe host text;
- checks `/api/radio/agent/status` for active contract and governance traces.

Use ASCII source and Unicode escapes for unsafe text checks to avoid PowerShell encoding corruption.

Define request fixtures as source-safe constants:

```js
const DIRECTIONS = {
  rnb: "play rnb",
  quietJazz: "play quiet jazz for reading",
  quietFocus: "play quiet focus music",
  chineseQuietMood: "\u653e\u70b9\u665a\u4e0a\u5b89\u9759\u4e00\u70b9\u7684\u6b4c",
  correction: "do not play jazz, switch to late-night R&B",
};
```

Expected: FAIL until service/gateway/governor work is complete and server is running.

- [ ] **Step 2: Add server availability guard**

If `/health` is unavailable, skip with a clear message:

```js
test('live smoke requires local server', { skip: !(await serverAvailable()) }, async () => {});
```

Do not make CI depend on a running local server unless intended.

- [ ] **Step 3: Add focused direction scenario helper**

Implement:

```js
async function runDirectionScenario(requestText, options) {
  // handshake, request, 3 track_ended, probes, assertions
}
```

Call this helper with `DIRECTIONS.rnb`, `DIRECTIONS.quietJazz`, `DIRECTIONS.quietFocus`, and `DIRECTIONS.chineseQuietMood`. These are regression samples for agent contract behavior, not separate genre-specific product centers.

- [ ] **Step 4: Add correction scenario**

Implement:

```js
await runCorrectionScenario(DIRECTIONS.quietJazz, DIRECTIONS.correction);
```

Assert no old-direction item is emitted after correction timestamp.

- [ ] **Step 5: Run harness against current server**

Start server:

```powershell
npm run start:local
```

Run:

```powershell
node --test tests/js/radio-agent-live-smoke.test.mjs
```

Expected before final integration: may FAIL with meaningful details. After final integration: PASS.

- [ ] **Step 6: Commit harness**

Run:

```powershell
git add tests/js/radio-agent-live-smoke.test.mjs package.json
git commit -m "Add radio agent live smoke harness"
```

## Task 13: Browser Guest Smoke Alignment

**Files:**
- Modify: `tests/js/radio-websocket.test.mjs`
- Modify: `frontend/js/radio.js` only if frontend needs to handle new action/status messages.
- Optional: add browser-driven manual checklist to `docs/superpowers/checklists/2026-06-11-hermes-ai-dj-v1-live-acceptance.md` after evidence.

- [ ] **Step 1: Write failing browser behavior tests if needed**

Ensure tests cover:

- guest start reaches player;
- first audio starts;
- synthetic ended event sends `track_ended`;
- next approved track starts;
- request status does not overwrite playback locally;
- stale host text clears.

Expected: fail only for behavior not already covered.

- [ ] **Step 2: Update frontend message handling if action/status payloads changed**

Keep existing message types compatible. Do not expose internal agent terms to UI.

- [ ] **Step 3: Run frontend websocket tests**

Run: `node --test tests/js/radio-websocket.test.mjs`

Expected: PASS.

- [ ] **Step 4: Commit**

Run:

```powershell
git add frontend/js/radio.js tests/js/radio-websocket.test.mjs
git commit -m "Keep browser radio flow aligned with agent actions"
```

## Task 14: Safe Degradation Failure Injection

**Files:**
- Modify: `tests/ts/radio-agent-service.test.ts`
- Modify: `tests/ts/radio-agent-playback-governor.test.ts`
- Modify: `tests/ts/radio-agent-server-wiring.test.ts`
- Modify: service/governor/server files as required by failing tests.

- [ ] **Step 1: Add model failure test**

Agent runtime/model throws. Expected:

- no unhandled rejection;
- action is `fallback` or `honest_not_found`;
- status records fallback reason.

- [ ] **Step 2: Add search failure test**

Search tool throws. Expected bounded fallback or honest not found.

- [ ] **Step 3: Add TTS failure test**

TTS throws. Expected music playback continues and host speech is text-only or omitted.

- [ ] **Step 4: Add audio unplayable test**

Audio resolver returns failure/404. Expected candidate rejected with `reject_audio_unplayable`, not promoted.

- [ ] **Step 5: Add legacy candidate rejection test**

Active explicit contract exists; legacy fallback proposes off-contract candidate. Expected:

- governor rejects;
- no playback of that candidate;
- action is `honest_not_found` or same-contract recovery.

- [ ] **Step 6: Run failure injection tests**

Run:

```powershell
npx tsx --test tests/ts/radio-agent-service.test.ts tests/ts/radio-agent-playback-governor.test.ts tests/ts/radio-agent-server-wiring.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

Run:

```powershell
git add src/radio-agent/radioAgentService.ts src/radio-agent/playbackGovernor.ts src/server.ts tests/ts/radio-agent-service.test.ts tests/ts/radio-agent-playback-governor.test.ts tests/ts/radio-agent-server-wiring.test.ts
git commit -m "Bound radio agent degradation paths"
```

## Task 15: Final Verification And Live Acceptance Update

**Files:**
- Modify: `docs/superpowers/checklists/2026-06-11-hermes-ai-dj-v1-live-acceptance.md`
- Do not stage: `dev-server.log`, `dev-server.err.log`

- [ ] **Step 1: Run full focused TS tests**

Run:

```powershell
npx tsx --test tests/ts/radio-agent-assisted-queue.test.ts tests/ts/radio-agent-program-executor.test.ts tests/ts/radio-agent-program-director.test.ts tests/ts/radio-agent-runtime.test.ts tests/ts/radio-agent-server-wiring.test.ts tests/ts/radio-agent-service.test.ts tests/ts/radio-agent-contract-controller.test.ts tests/ts/radio-agent-playback-governor.test.ts tests/ts/radio-agent-style-seed-registry.test.ts tests/ts/request-ready-selector.test.ts tests/ts/track-end-recovery.test.ts tests/ts/boundary-guard.test.ts tests/ts/search-verify-agent.test.ts
```

Expected: PASS with 0 failures.

- [ ] **Step 2: Run JS tests**

Run:

```powershell
node --test tests/js/radio-websocket.test.mjs tests/js/radio-agent-live-smoke.test.mjs
```

Expected: PASS when server is available; live smoke may skip only if server is intentionally not running. For closure claim, run with server available.

- [ ] **Step 3: Run typecheck and build**

Run:

```powershell
npm run typecheck
npm run build
```

Expected: both exit 0.

- [ ] **Step 4: Restart local server**

Run the server startup block from this plan.

Expected:

- port 8000 listening;
- `/health` returns `{ status: "ok", backend: "typescript" }`.

- [ ] **Step 5: Run live websocket smoke matrix**

Run:

```powershell
node --test tests/js/radio-agent-live-smoke.test.mjs
```

Expected:

- fast start under 30s;
- no end stall under 15s;
- each direction request gets request track + 3 continuations;
- no duplicate normalized track key in retention window;
- no off-contract tracks;
- no unsafe host text;
- audio probes return 200/206 and bytes;
- status exposes active contract and governance traces.

- [ ] **Step 6: Run browser guest smoke**

Use in-app browser at `http://127.0.0.1:8000/`.

Verify:

- guest radio enters player;
- audio starts;
- ended event advances to next approved track;
- request status updates safely;
- host text is listener-facing.

- [ ] **Step 7: Update acceptance checklist with evidence**

Record:

- command outputs;
- smoke scenario summary;
- representative tracks;
- audio probe status;
- status endpoint evidence;
- remaining gaps, if any.

- [ ] **Step 8: Final git status audit**

Run:

```powershell
git status --short --branch
```

Expected:

- only intentional files changed;
- no `dev-server*.log` staged;
- no unrelated user changes reverted.

- [ ] **Step 9: Commit acceptance evidence**

Run:

```powershell
git add docs/superpowers/checklists/2026-06-11-hermes-ai-dj-v1-live-acceptance.md
git commit -m "Record radio agent beta closure acceptance"
```

## Completion Criteria

The Beta Closure can be claimed only when:

- all acceptance gates in the spec are verified with current code;
- full focused automated tests pass;
- typecheck and build pass;
- live websocket matrix passes with server running;
- browser guest smoke passes;
- acceptance checklist contains fresh evidence;
- implementation commits are focused and logs are not committed.

If any gate remains unverified, report the exact remaining gap and keep the label as:

> Hermes Radio Agent Beta Foundation

Only after all gates pass may the label become:

> Hermes Radio Agent Beta Closure
