# Agentic Radio DJ Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the agentic radio DJ layer described in `docs/superpowers/specs/2026-06-02-agentic-radio-dj-design.md`: persistent station contracts, drift/boundary checks, and real DJ narration for meaningful transitions.

**Architecture:** Keep the current `RadioBrain -> EpisodePlanner -> QueueWarmer -> PlaybackQueue` spine, and add focused modules around it. `StationContractManager` owns the session objective, `BoundaryGuard` decides whether verified songs fit the contract, and `HostNarrationLayer` turns agent decisions into short DJ speech and optional TTS-backed segues.

**Tech Stack:** TypeScript, Node.js built-in test runner, WebSocket playback, existing `LLMRouter`, existing `TTSService`, existing SQLite-backed `MemoryStore`.

---

## File Map

Create:

- `src/radio/stationContract.ts` - builds and updates the active station contract from listener intent and session context.
- `src/radio/boundaryGuard.ts` - evaluates verified candidates against the active station contract.
- `src/radio/hostNarrationLayer.ts` - decides when and how the DJ should speak.
- `tests/ts/station-contract.test.ts` - contract creation and update tests.
- `tests/ts/boundary-guard.test.ts` - off-contract, bridge, and entity-mismatch tests.
- `tests/ts/host-narration-layer.test.ts` - narration cadence and copy-safety tests.

Modify:

- `src/radio/radioBrainTypes.ts` - add contract, boundary, and narration types.
- `src/radio/intentRouter.ts` - classify broad `play some...` direction requests correctly.
- `src/radio/radioBrain.ts` - maintain contract state and pass it into planning/warming.
- `src/radio/episodePlanner.ts` - include the contract in prompts and normalize contract-fit fields.
- `src/radio/queueWarmer.ts` - call BoundaryGuard before queue insertion; attach narration metadata.
- `src/radio/playbackQueue.ts` - keep optional segue/narration fields on queue items.
- `src/server.ts` - construct new modules, synthesize narration, and send segue/DJ messages.
- `frontend/js/radio.js` - render short DJ state and play narration for agentic segues.
- `tests/ts/intent-router.test.ts` - regression for broad direction requests.
- `tests/ts/radio-brain.test.ts` - contract propagation and continuation behavior.
- `tests/ts/episode-planner.test.ts` - contract-aware prompt and fallback behavior.
- `tests/ts/queue-warmer.test.ts` - guard integration and narration metadata.
- `tests/js/radio-websocket.test.mjs` - WebSocket narration and TTS-failure behavior.
- `docs/superpowers/checklists/2026-06-01-continuous-ai-radio-host-smoke.md` - add agentic DJ smoke checks.

Do not stage or commit the existing unrelated `package-lock.json` working-tree change unless a later task intentionally changes dependencies.

---

### Task 1: Fix Broad Direction Classification

**Files:**
- Modify: `src/radio/intentRouter.ts`
- Modify: `tests/ts/intent-router.test.ts`

- [ ] **Step 1: Add failing tests for broad play-verb directions**

Append tests that prove broad directions are not specific track requests:

```ts
test("play verb plus broad scene/style remains a music direction", () => {
  const router = new IntentRouter();
  const cases = [
    "放点深夜听的rnb",
    "播放一点晚上听的 r&b",
    "想听适合深夜的R&B",
    "放点安静但有推动力的电子",
  ];

  for (const text of cases) {
    const intent = router.classify(text);
    assert.equal(intent.type, "music_direction_request", text);
    assert.equal(intent.shouldReplan, true, text);
    assert.equal(intent.shouldClearQueue, true, text);
  }
});
```

- [ ] **Step 2: Run the intent-router test and verify the new test fails**

Run:

```powershell
npm run build:test
node --test dist/tests/ts/intent-router.test.js
```

Expected: test fails because at least `放点深夜听的rnb` is currently classified as `specific_track_request`.

- [ ] **Step 3: Implement broad-direction guard**

In `IntentRouter`, add a helper such as:

```ts
private looksLikeBroadDirection(text: string): boolean {
  return /(放点|播放一点|来点|一些|适合|感觉|氛围|风格|深夜|晚上|下午|早上|工作|写代码|专注|安静|轻|舒缓|r\s*&?\s*b|rnb|jazz|ambient|city\s*pop|shoegaze|电子|电音|摇滚|民谣)/iu.test(text);
}
```

Use it in the direct-request branch:

```ts
const direct = text.match(/^(?:放|播放|点一首|我想听|想听)\s*(.{2,80})$/iu);
if (direct?.[1] && !this.looksLikeBroadDirection(direct[1])) {
  return this.intent("specific_track_request", text, compactText(direct[1], 120), [], negativeConstraints, true, true, false, "我找一下这首。");
}
```

Keep exact-title requests such as `放 Nils Frahm Says` classified as `specific_track_request`.

- [ ] **Step 4: Run tests**

Run:

```powershell
npm run build:test
node --test dist/tests/ts/intent-router.test.js
```

Expected: all intent-router tests pass.

- [ ] **Step 5: Commit**

```powershell
git add src/radio/intentRouter.ts tests/ts/intent-router.test.ts
git commit -m "Fix broad radio direction intent routing"
```

---

### Task 2: Add Station Contract Types and Manager

**Files:**
- Create: `src/radio/stationContract.ts`
- Modify: `src/radio/radioBrainTypes.ts`
- Create: `tests/ts/station-contract.test.ts`

- [ ] **Step 1: Add failing contract tests**

Create `tests/ts/station-contract.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";

import { StationContractManager } from "../../src/radio/stationContract.js";
import type { ListeningIntentDecision } from "../../src/radio/radioBrainTypes.js";

function intent(overrides: Partial<ListeningIntentDecision> = {}): ListeningIntentDecision {
  return {
    type: "music_direction_request",
    rawText: "放点深夜听的rnb",
    query: "",
    positiveSeeds: ["R&B", "深夜"],
    negativeConstraints: [],
    shouldReplan: true,
    shouldClearQueue: true,
    shouldExplain: false,
    confidence: "high",
    ackText: "收到，我按这个方向重新排接下来的几首。",
    ...overrides,
  };
}

test("creates a late-night R&B station contract from direction intent", () => {
  const manager = new StationContractManager();
  const contract = manager.update(null, intent());

  assert.equal(contract.mainDirection.toLowerCase().includes("r&b"), true);
  assert.ok(contract.allowedAdjacent.some((item) => /alt|neo|soul|downtempo|electronic/i.test(item)));
  assert.ok(contract.disallowed.some((item) => /classical|古典/i.test(item)));
  assert.equal(contract.driftBudget, 1);
  assert.equal(contract.bridgeCount, 0);
  assert.equal(contract.mustReturnToContract, false);
});

test("correction merges negative constraints into the active contract", () => {
  const manager = new StationContractManager();
  const base = manager.update(null, intent());
  const updated = manager.update(base, intent({
    type: "correction",
    rawText: "不要古典，拉回人声rnb",
    positiveSeeds: ["人声R&B"],
    negativeConstraints: ["古典"],
    shouldClearQueue: true,
  }));

  assert.ok(updated.negativeConstraints.includes("古典"));
  assert.ok(updated.disallowed.some((item) => item.includes("古典")));
  assert.match(updated.mainDirection, /R&B|r&b/i);
});
```

- [ ] **Step 2: Run tests to verify failure**

Run:

```powershell
npm run build:test
node --test dist/tests/ts/station-contract.test.js
```

Expected: build fails because `stationContract.ts` does not exist.

- [ ] **Step 3: Add contract types**

In `src/radio/radioBrainTypes.ts`, add:

```ts
export type DriftState = "on_contract" | "adjacent" | "bridge" | "off_contract";

export interface StationContract {
  id: string;
  mainDirection: string;
  rawUserText: string;
  allowedAdjacent: string[];
  softBridge: string[];
  disallowed: string[];
  positiveSeeds: string[];
  negativeConstraints: string[];
  driftBudget: number;
  bridgeCount: number;
  mustReturnToContract: boolean;
  hostStyle: "quiet" | "standard" | "companion";
  createdAt: string;
  updatedAt: string;
}
```

- [ ] **Step 4: Implement `StationContractManager`**

Create `src/radio/stationContract.ts` with a small deterministic manager:

```ts
import { compactText, dedupe } from "../utils/text.js";
import type { ListeningIntentDecision, StationContract } from "./radioBrainTypes.js";

export class StationContractManager {
  update(existing: StationContract | null | undefined, intent: ListeningIntentDecision): StationContract {
    const now = new Date().toISOString();
    const mainDirection = this.mainDirection(existing, intent);
    const isRnb = /r\s*&?\s*b|rnb|节奏布鲁斯/i.test([mainDirection, intent.rawText, ...intent.positiveSeeds].join(" "));
    const base: StationContract = existing || {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      mainDirection,
      rawUserText: intent.rawText,
      allowedAdjacent: [],
      softBridge: [],
      disallowed: [],
      positiveSeeds: [],
      negativeConstraints: [],
      driftBudget: 1,
      bridgeCount: 0,
      mustReturnToContract: false,
      hostStyle: "standard",
      createdAt: now,
      updatedAt: now,
    };

    return {
      ...base,
      mainDirection,
      rawUserText: intent.rawText || base.rawUserText,
      allowedAdjacent: dedupe([...(isRnb ? ["alt-R&B", "neo-soul", "soft vocal", "downtempo", "R&B-adjacent electronic"] : []), ...base.allowedAdjacent]),
      softBridge: dedupe([...(isRnb ? ["ambient electronic", "piano ambient"] : []), ...base.softBridge]),
      disallowed: dedupe([...base.disallowed, ...(isRnb ? ["classical chamber music", "pure classical piano", "high-energy EDM", "utility audio", "playlist"] : []), ...intent.negativeConstraints]),
      positiveSeeds: dedupe([...base.positiveSeeds, ...intent.positiveSeeds]),
      negativeConstraints: dedupe([...base.negativeConstraints, ...intent.negativeConstraints]),
      updatedAt: now,
    };
  }

  private mainDirection(existing: StationContract | null | undefined, intent: ListeningIntentDecision): string {
    if (intent.type === "continuation" && existing?.mainDirection) return existing.mainDirection;
    return compactText(intent.positiveSeeds.join(" / ") || intent.query || intent.rawText || existing?.mainDirection || "AI radio", 120);
  }
}
```

- [ ] **Step 5: Run station contract tests**

Run:

```powershell
npm run build:test
node --test dist/tests/ts/station-contract.test.js
```

Expected: tests pass.

- [ ] **Step 6: Commit**

```powershell
git add src/radio/radioBrainTypes.ts src/radio/stationContract.ts tests/ts/station-contract.test.ts
git commit -m "Add station contract manager"
```

---

### Task 3: Thread Station Contract Through RadioBrain

**Files:**
- Modify: `src/radio/radioBrain.ts`
- Modify: `src/radio/radioBrainTypes.ts`
- Modify: `src/radio/episodePlanner.ts`
- Modify: `tests/ts/radio-brain.test.ts`
- Modify: `tests/ts/episode-planner.test.ts`

- [ ] **Step 1: Add failing RadioBrain contract propagation test**

In `tests/ts/radio-brain.test.ts`, add a test that injects a fake contract manager and checks the planner receives the active contract during a continuation:

```ts
test("continuation planning preserves the active station contract", async () => {
  const queue = new PlaybackQueue();
  const activeContract = {
    id: "contract-1",
    mainDirection: "late-night R&B",
    rawUserText: "放点深夜听的rnb",
    allowedAdjacent: ["alt-R&B"],
    softBridge: ["ambient electronic"],
    disallowed: ["classical chamber music"],
    positiveSeeds: ["R&B"],
    negativeConstraints: [],
    driftBudget: 1,
    bridgeCount: 0,
    mustReturnToContract: false,
    hostStyle: "standard" as const,
    createdAt: "2026-06-02T00:00:00.000Z",
    updatedAt: "2026-06-02T00:00:00.000Z",
  };
  let receivedContract: unknown = null;
  const radio = brain({
    intentRouter: { classify: (text) => intent({ type: "continuation", rawText: text, shouldReplan: true, shouldClearQueue: false }) },
    contractManager: { update: () => activeContract } as any,
    planner: {
      plan: async (planArgs: any) => {
        receivedContract = planArgs.stationContract;
        return episode("autoplay");
      },
    },
  } as any);

  await radio.handleUserText({ ...args(queue), text: "继续保持这个感觉" });
  await flushBackground();

  assert.equal((receivedContract as any)?.mainDirection, "late-night R&B");
});
```

- [ ] **Step 2: Run RadioBrain tests to verify failure**

Run:

```powershell
npm run build:test
node --test dist/tests/ts/radio-brain.test.js
```

Expected: fails because `contractManager` dependency and planner arg are not supported yet.

- [ ] **Step 3: Extend RadioBrain dependencies and session state**

In `RadioBrainDeps`, add optional:

```ts
contractManager?: { update(existing: StationContract | null | undefined, intent: ListeningIntentDecision): StationContract };
```

In `RadioBrainSessionState`, add:

```ts
stationContract?: StationContract;
```

Update `PlanAndWarmArgs` and `EpisodePlanArgs` to carry:

```ts
stationContract?: StationContract;
```

- [ ] **Step 4: Update `handleUserText` and startup path**

For user directions, corrections, preferences, and continuation:

```ts
if (this.deps.contractManager && intent.shouldReplan) {
  state.stationContract = this.deps.contractManager.update(state.stationContract, intent);
  args.contextPack.sessionWorkingMemory.stationContract = state.stationContract;
}
```

Pass `stationContract: state.stationContract` to `startBackgroundPlan`.

For startup intent, keep contract optional until a user direction exists.

- [ ] **Step 5: Update `EpisodePlanner` args and prompt**

Add `stationContract?: StationContract` to `EpisodePlanArgs`. Include the contract above playback context in the prompt:

```ts
Station contract:
${JSON.stringify(args.stationContract || null, null, 2)}
```

Ask the model to return `contract_fit`, `return_plan`, and `narration_cue` per item, but keep parsing backward-compatible.

- [ ] **Step 6: Run focused tests**

Run:

```powershell
npm run build:test
node --test dist/tests/ts/radio-brain.test.js dist/tests/ts/episode-planner.test.js
```

Expected: tests pass.

- [ ] **Step 7: Commit**

```powershell
git add src/radio/radioBrain.ts src/radio/radioBrainTypes.ts src/radio/episodePlanner.ts tests/ts/radio-brain.test.ts tests/ts/episode-planner.test.ts
git commit -m "Thread station contracts through radio planning"
```

---

### Task 4: Add BoundaryGuard and Integrate QueueWarmer

**Files:**
- Create: `src/radio/boundaryGuard.ts`
- Modify: `src/radio/radioBrainTypes.ts`
- Modify: `src/radio/queueWarmer.ts`
- Create: `tests/ts/boundary-guard.test.ts`
- Modify: `tests/ts/queue-warmer.test.ts`

- [ ] **Step 1: Add failing BoundaryGuard tests**

Create `tests/ts/boundary-guard.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";

import { BoundaryGuard } from "../../src/radio/boundaryGuard.js";
import type { StationContract } from "../../src/radio/radioBrainTypes.js";
import type { Track } from "../../src/types.js";

const contract: StationContract = {
  id: "contract-1",
  mainDirection: "late-night R&B",
  rawUserText: "放点深夜听的rnb",
  allowedAdjacent: ["alt-R&B", "neo-soul", "soft vocal", "downtempo", "R&B-adjacent electronic"],
  softBridge: ["ambient electronic", "piano ambient"],
  disallowed: ["classical chamber music", "pure classical piano", "high-energy EDM"],
  positiveSeeds: ["R&B", "深夜"],
  negativeConstraints: [],
  driftBudget: 1,
  bridgeCount: 0,
  mustReturnToContract: false,
  hostStyle: "standard",
  createdAt: "2026-06-02T00:00:00.000Z",
  updatedAt: "2026-06-02T00:00:00.000Z",
};

function song(name: string, artist: string): Track {
  return { id: `${artist}-${name}`, name, artist };
}

test("rejects classical chamber music inside late-night R&B contract", () => {
  const guard = new BoundaryGuard();
  const decision = guard.evaluate({
    contract,
    query: "Max Richter piano ambient instrumental",
    candidate: song("Piano Quintet No. 2 in C Minor, Op. 64:II. Vivace (Live)", "Sviatoslav Richter"),
    fallbackLevel: "episode_backup",
    itemStyle: "piano ambient",
  });

  assert.equal(decision.status, "reject_entity_mismatch");
});

test("allows one ambient electronic bridge", () => {
  const guard = new BoundaryGuard();
  const decision = guard.evaluate({
    contract,
    query: "Jon Hopkins ambient electronic deep",
    candidate: song("A Drifting Down", "Jon Hopkins"),
    fallbackLevel: "episode_backup",
    itemStyle: "ambient electronic",
  });

  assert.equal(decision.status, "accept_as_bridge");
});
```

- [ ] **Step 2: Run tests to verify failure**

Run:

```powershell
npm run build:test
node --test dist/tests/ts/boundary-guard.test.js
```

Expected: build fails because BoundaryGuard is missing.

- [ ] **Step 3: Add boundary types**

In `radioBrainTypes.ts`:

```ts
export type BoundaryDecisionStatus =
  | "accept"
  | "accept_as_adjacent"
  | "accept_as_bridge"
  | "reject_off_contract"
  | "reject_entity_mismatch"
  | "reject_low_confidence";

export interface BoundaryDecision {
  status: BoundaryDecisionStatus;
  reason: string;
  contractId?: string;
}
```

Extend `DecisionTrace`:

```ts
boundaryDecision?: BoundaryDecision;
```

- [ ] **Step 4: Implement deterministic BoundaryGuard**

Create `src/radio/boundaryGuard.ts`. Start deterministic and conservative:

```ts
import { normalizeMatchText } from "../utils/text.js";
import type { Track } from "../types.js";
import type { BoundaryDecision, DecisionTrace, StationContract } from "./radioBrainTypes.js";

export interface BoundaryGuardArgs {
  contract?: StationContract | null;
  query: string;
  candidate: Track;
  fallbackLevel: DecisionTrace["fallbackLevel"];
  itemStyle?: string;
}

export class BoundaryGuard {
  evaluate(args: BoundaryGuardArgs): BoundaryDecision {
    if (!args.contract) return { status: "accept", reason: "No active station contract." };
    const searchable = normalizeMatchText([args.query, args.itemStyle, args.candidate.name, args.candidate.artist].join(" "));
    const query = normalizeMatchText(args.query);
    const artist = normalizeMatchText(args.candidate.artist);
    const name = normalizeMatchText(args.candidate.name);

    if (query.includes("maxrichter") && artist.includes("sviatoslavrichter")) {
      return { status: "reject_entity_mismatch", reason: "Query intended Max Richter but candidate is Sviatoslav Richter.", contractId: args.contract.id };
    }

    if (this.isLateNightRnb(args.contract)) {
      if (/pianoquintet|symphony|concerto|quartet|sonata|sviatoslavrichter/.test(name + artist)) {
        return { status: "reject_off_contract", reason: "Classical chamber/performance result is outside the active R&B contract.", contractId: args.contract.id };
      }
      if (/jonhopkins|nilsfrahm|ambient|pianoambient/.test(searchable)) {
        return args.contract.bridgeCount < args.contract.driftBudget
          ? { status: "accept_as_bridge", reason: "Allowed one instrumental/electronic bridge under the active contract.", contractId: args.contract.id }
          : { status: "reject_off_contract", reason: "Bridge budget already used; must return to the main direction.", contractId: args.contract.id };
      }
      if (/rnb|randb|neosoul|altsoul|frankocean|sza|danielcaesar|her/.test(searchable)) {
        return { status: "accept", reason: "Candidate fits the active R&B contract.", contractId: args.contract.id };
      }
    }

    return { status: "accept_as_adjacent", reason: "No deterministic boundary violation found.", contractId: args.contract.id };
  }

  private isLateNightRnb(contract: StationContract): boolean {
    return /r\s*&?\s*b|rnb/i.test([contract.mainDirection, ...contract.positiveSeeds].join(" "));
  }
}
```

- [ ] **Step 5: Inject BoundaryGuard into QueueWarmer**

Add optional dependency:

```ts
constructor(
  private readonly verifier: SearchVerifyAgent,
  private readonly traceStore: DecisionTraceStore,
  private readonly boundaryGuard?: Pick<BoundaryGuard, "evaluate">,
) {}
```

Extend `QueueWarmArgs` with `stationContract?: StationContract`.

After verification succeeds and before `queue.addReady`, call:

```ts
const boundaryDecision = this.boundaryGuard?.evaluate({
  contract: args.stationContract,
  query,
  candidate: verification.selectedSong,
  fallbackLevel,
  itemStyle: item.style,
}) || { status: "accept", reason: "No boundary guard configured." };

if (boundaryDecision.status.startsWith("reject_")) {
  rejectedCandidates.push(`${query}: ${boundaryDecision.reason}`);
  continue;
}
```

Save `boundaryDecision` in the trace.

- [ ] **Step 6: Add queue-warmer integration tests**

In `tests/ts/queue-warmer.test.ts`, add:

```ts
test("queue warmer skips candidates rejected by boundary guard", async () => {
  const queue = new PlaybackQueue(2);
  const verifier = new FakeVerifier();
  const traceStore = new FakeTraceStore();
  const guard = { evaluate: () => ({ status: "reject_off_contract" as const, reason: "outside contract", contractId: "c1" }) };
  const warmer = new QueueWarmer(verifier as any, traceStore as any, guard);

  const added = await warmer.warm({
    ...warmArgs(queue, singlePrimaryEpisode),
    stationContract: {
      id: "c1",
      mainDirection: "late-night R&B",
      rawUserText: "放点深夜听的rnb",
      allowedAdjacent: [],
      softBridge: [],
      disallowed: ["classical"],
      positiveSeeds: ["R&B"],
      negativeConstraints: [],
      driftBudget: 1,
      bridgeCount: 0,
      mustReturnToContract: false,
      hostStyle: "standard",
      createdAt: "2026-06-02T00:00:00.000Z",
      updatedAt: "2026-06-02T00:00:00.000Z",
    },
  });

  assert.equal(added, 0);
  assert.equal(queue.readyDepth(), 0);
});
```

- [ ] **Step 7: Run focused tests**

Run:

```powershell
npm run build:test
node --test dist/tests/ts/boundary-guard.test.js dist/tests/ts/queue-warmer.test.js
```

Expected: tests pass.

- [ ] **Step 8: Commit**

```powershell
git add src/radio/boundaryGuard.ts src/radio/radioBrainTypes.ts src/radio/queueWarmer.ts tests/ts/boundary-guard.test.ts tests/ts/queue-warmer.test.ts
git commit -m "Guard radio queue candidates against contract drift"
```

---

### Task 5: Add HostNarrationLayer

**Files:**
- Create: `src/radio/hostNarrationLayer.ts`
- Modify: `src/radio/radioBrainTypes.ts`
- Create: `tests/ts/host-narration-layer.test.ts`

- [ ] **Step 1: Add failing narration tests**

Create `tests/ts/host-narration-layer.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";

import { HostNarrationLayer } from "../../src/radio/hostNarrationLayer.js";
import type { BoundaryDecision, StationContract } from "../../src/radio/radioBrainTypes.js";

const contract: StationContract = {
  id: "contract-1",
  mainDirection: "late-night R&B",
  rawUserText: "放点深夜听的rnb",
  allowedAdjacent: ["alt-R&B"],
  softBridge: ["ambient electronic"],
  disallowed: ["classical chamber music"],
  positiveSeeds: ["R&B"],
  negativeConstraints: [],
  driftBudget: 1,
  bridgeCount: 0,
  mustReturnToContract: false,
  hostStyle: "standard",
  createdAt: "2026-06-02T00:00:00.000Z",
  updatedAt: "2026-06-02T00:00:00.000Z",
};

test("narrates bridge entry in listener-facing language", async () => {
  const layer = new HostNarrationLayer();
  const boundary: BoundaryDecision = { status: "accept_as_bridge", reason: "Allowed bridge", contractId: contract.id };
  const result = await layer.forQueueItem({
    stationContract: contract,
    boundaryDecision: boundary,
    track: { id: "jon", name: "A Drifting Down", artist: "Jon Hopkins" },
    reason: "ambient electronic bridge",
    recentNarrationCount: 0,
  });

  assert.equal(result.shouldSpeak, true);
  assert.match(result.text, /桥|过渡|拉回|R&B/i);
  assert.doesNotMatch(result.text, /profile|algorithm|model|candidate|trace|JSON|verification/i);
});

test("suppresses ordinary on-contract continuations", async () => {
  const layer = new HostNarrationLayer();
  const result = await layer.forQueueItem({
    stationContract: contract,
    boundaryDecision: { status: "accept", reason: "fits", contractId: contract.id },
    track: { id: "rnb", name: "Pink + White", artist: "Frank Ocean" },
    reason: "fits contract",
    recentNarrationCount: 1,
  });

  assert.equal(result.shouldSpeak, false);
});
```

- [ ] **Step 2: Run tests to verify failure**

Run:

```powershell
npm run build:test
node --test dist/tests/ts/host-narration-layer.test.js
```

Expected: build fails because HostNarrationLayer is missing.

- [ ] **Step 3: Add narration types**

In `radioBrainTypes.ts`:

```ts
export interface HostNarration {
  event: "station_open" | "request_ack" | "direction_changed" | "bridge_entered" | "return_to_contract" | "track_explanation" | "drift_corrected" | "still_planning" | "recovery";
  text: string;
  ttsHash?: string;
  spoken: boolean;
}
```

Extend `DecisionTrace` with:

```ts
narration?: HostNarration;
```

- [ ] **Step 4: Implement deterministic first-pass HostNarrationLayer**

Create `src/radio/hostNarrationLayer.ts`:

```ts
import type { Track } from "../types.js";
import { compactText } from "../utils/text.js";
import type { BoundaryDecision, HostNarration, StationContract } from "./radioBrainTypes.js";

export interface QueueNarrationArgs {
  stationContract?: StationContract | null;
  boundaryDecision?: BoundaryDecision | null;
  track: Track;
  reason: string;
  recentNarrationCount: number;
}

export interface QueueNarrationResult {
  shouldSpeak: boolean;
  text: string;
  event?: HostNarration["event"];
}

export class HostNarrationLayer {
  async forQueueItem(args: QueueNarrationArgs): Promise<QueueNarrationResult> {
    const status = args.boundaryDecision?.status;
    if (status === "accept_as_bridge") {
      const direction = args.stationContract?.mainDirection || "刚才的方向";
      return {
        shouldSpeak: true,
        event: "bridge_entered",
        text: compactText(`我这里用 ${args.track.artist} 的 ${args.track.name} 做一首短的过渡，保留夜里的空间感，下一首会往 ${direction} 拉回来。`, 180),
      };
    }
    if (status === "accept_as_adjacent" && args.recentNarrationCount <= 0) {
      return {
        shouldSpeak: true,
        event: "direction_changed",
        text: compactText(`这首会稍微贴近旁边的质感，但主线还是 ${args.stationContract?.mainDirection || "当前电台方向"}。`, 140),
      };
    }
    return { shouldSpeak: false, text: "" };
  }

  requestAck(contract: StationContract): string {
    return compactText(`收到，我会把接下来的歌守在 ${contract.mainDirection} 这条线上，轻一点，别乱跳。`, 120);
  }
}
```

- [ ] **Step 5: Run narration tests**

Run:

```powershell
npm run build:test
node --test dist/tests/ts/host-narration-layer.test.js
```

Expected: tests pass.

- [ ] **Step 6: Commit**

```powershell
git add src/radio/hostNarrationLayer.ts src/radio/radioBrainTypes.ts tests/ts/host-narration-layer.test.ts
git commit -m "Add host narration layer"
```

---

### Task 6: Attach Narration to RadioBrain Queue Items

**Files:**
- Modify: `src/radio/queueWarmer.ts`
- Modify: `src/radio/radioBrain.ts`
- Modify: `src/radio/playbackQueue.ts`
- Modify: `tests/ts/queue-warmer.test.ts`
- Modify: `tests/ts/radio-brain.test.ts`

- [ ] **Step 1: Add failing queue-warmer narration metadata test**

In `tests/ts/queue-warmer.test.ts`, add:

```ts
test("queue warmer attaches narration text to bridge items", async () => {
  const queue = new PlaybackQueue(2);
  const verifier = new FakeVerifier();
  const traceStore = new FakeTraceStore();
  const guard = { evaluate: () => ({ status: "accept_as_bridge" as const, reason: "bridge", contractId: "c1" }) };
  const narrator = { forQueueItem: async () => ({ shouldSpeak: true, event: "bridge_entered" as const, text: "短暂做一首器乐过渡，下一首拉回R&B。" }) };
  const warmer = new QueueWarmer(verifier as any, traceStore as any, guard, narrator as any);

  await warmer.warm({
    ...warmArgs(queue, singlePrimaryEpisode),
    stationContract: {
      id: "c1",
      mainDirection: "late-night R&B",
      rawUserText: "放点深夜听的rnb",
      allowedAdjacent: [],
      softBridge: [],
      disallowed: [],
      positiveSeeds: ["R&B"],
      negativeConstraints: [],
      driftBudget: 1,
      bridgeCount: 0,
      mustReturnToContract: false,
      hostStyle: "standard",
      createdAt: "2026-06-02T00:00:00.000Z",
      updatedAt: "2026-06-02T00:00:00.000Z",
    },
  });

  assert.equal(queue.readyItems()[0]?.segueText, "短暂做一首器乐过渡，下一首拉回R&B。");
});
```

- [ ] **Step 2: Run tests to verify failure**

Run:

```powershell
npm run build:test
node --test dist/tests/ts/queue-warmer.test.js
```

Expected: constructor signature and narration fields are not implemented yet.

- [ ] **Step 3: Extend QueueWarmer constructor**

Add optional narrator:

```ts
private readonly narrator?: Pick<HostNarrationLayer, "forQueueItem">;
```

After a candidate is accepted by BoundaryGuard:

```ts
const narration = await this.narrator?.forQueueItem({
  stationContract: args.stationContract,
  boundaryDecision,
  track: verification.selectedSong,
  reason: hostText,
  recentNarrationCount: 0,
}).catch(() => null);
```

Attach to trace and queue item:

```ts
trace.narration = narration?.shouldSpeak
  ? { event: narration.event || "bridge_entered", text: narration.text, spoken: false }
  : undefined;

args.queue.addReady(verification.selectedSong, verification.url, selectionReason, {
  segueText: narration?.shouldSpeak ? narration.text : "",
});
```

Do not synthesize TTS inside QueueWarmer; it should remain transport-agnostic.

- [ ] **Step 4: Ensure PlaybackQueue preserves segue text**

Confirm `PlaybackQueue.addReady` already stores `segueText`; add tests only if existing coverage is weak.

- [ ] **Step 5: Run focused tests**

Run:

```powershell
npm run build:test
node --test dist/tests/ts/queue-warmer.test.js dist/tests/ts/radio-brain.test.js
```

Expected: tests pass.

- [ ] **Step 6: Commit**

```powershell
git add src/radio/queueWarmer.ts src/radio/radioBrain.ts src/radio/playbackQueue.ts tests/ts/queue-warmer.test.ts tests/ts/radio-brain.test.ts
git commit -m "Attach host narration to radio brain queue items"
```

---

### Task 7: Wire Server TTS and Frontend DJ State

**Files:**
- Modify: `src/server.ts`
- Modify: `frontend/js/radio.js`
- Modify: `tests/js/radio-websocket.test.mjs`

- [ ] **Step 1: Add failing WebSocket test for agentic segue**

In `tests/js/radio-websocket.test.mjs`, add or extend a test so a `segue` payload with text is handled before `play_track`, and text-only narration does not block playback when `tts_hash` is empty.

Expected assertions:

```js
assert.equal(lastDjText.includes("过渡") || lastDjText.includes("拉回"), true);
assert.equal(playTrackCalled, true);
```

Use existing WebSocket test patterns in the file rather than adding a new test framework.

- [ ] **Step 2: Run the WebSocket test to verify failure or missing coverage**

Run:

```powershell
npm run build:test
node --test tests/js/radio-websocket.test.mjs
```

Expected: test fails until frontend/server narration handling is completed, or it exposes the missing assertion coverage.

- [ ] **Step 3: Construct new modules in `src/server.ts`**

Instantiate:

```ts
const stationContractManager = new StationContractManager();
const boundaryGuard = new BoundaryGuard();
const hostNarrationLayer = new HostNarrationLayer();
```

Pass them into `RadioBrain` / `QueueWarmer`:

```ts
const queueWarmer = new QueueWarmer(searchVerifyAgent, traceStore, boundaryGuard, hostNarrationLayer);
const radioBrain = new RadioBrain({
  intentRouter,
  contractManager: stationContractManager,
  planner: episodePlanner,
  warmer: queueWarmer,
  responder: hostResponder,
  traceStore,
  reflectionLoop,
  bridgePicker: pickBridgeTrack,
  ...
});
```

- [ ] **Step 4: Synthesize TTS for segue items at promotion time**

In `sendPreparedNext`, when `item.segueText` exists and `item.ttsHash` is empty, synthesize before sending:

```ts
let ttsHash = item.ttsHash || "";
if (item.segueText && !ttsHash) {
  ttsHash = await synthesize(item.segueText).catch(() => "");
}
```

Then send `segue` with `tts_ready: Boolean(ttsHash)`.

- [ ] **Step 5: Keep text-only narration non-blocking**

In `frontend/js/radio.js`, for `segue`:

- If `tts_ready`, play the next track and overlay TTS as today.
- If only text exists, update `dj-text`, call `playNextTrack()` immediately or after a short max delay.
- Do not leave the player waiting indefinitely for narration.

- [ ] **Step 6: Add lightweight DJ state display text**

Keep this minimal in `frontend/js/radio.js`:

- Show latest narration in `#dj-text`.
- For `bridge_entered` or transition text, call `updateBreathState('speaking', true)`.
- Do not add visible debug labels or raw agent terms.

- [ ] **Step 7: Run focused tests**

Run:

```powershell
npm run build:test
node --test tests/js/radio-websocket.test.mjs dist/tests/ts/queue-warmer.test.js dist/tests/ts/radio-brain.test.js
```

Expected: tests pass.

- [ ] **Step 8: Commit**

```powershell
git add src/server.ts frontend/js/radio.js tests/js/radio-websocket.test.mjs
git commit -m "Wire agentic DJ narration into playback"
```

---

### Task 8: Add Diagnostics and Smoke Checklist

**Files:**
- Modify: `src/server.ts`
- Modify: `src/runtimeStatus.ts` if needed
- Modify: `docs/superpowers/checklists/2026-06-01-continuous-ai-radio-host-smoke.md`
- Add tests in an existing runtime/status test if endpoint behavior is exposed.

- [ ] **Step 1: Decide diagnostics shape**

Use a low-risk endpoint or existing `/ready` extension that does not expose secrets or raw prompts:

```json
{
  "active_contract": "late-night R&B",
  "drift_state": "bridge",
  "last_boundary_status": "accept_as_bridge",
  "last_narration": "bridge_entered"
}
```

Prefer an internal `/api/radio/debug/session` endpoint only if it can safely identify the active socket/session. If that is too much for this slice, keep diagnostics in decision traces and smoke checklist.

- [ ] **Step 2: Add smoke checklist steps**

Update the smoke checklist with:

```md
- Request "放点深夜听的rnb".
- Confirm the DJ acknowledges the direction in speech or visible text.
- Let at least 4 tracks play.
- Confirm no more than one bridge track occurs before returning toward R&B.
- Confirm a bridge is narrated if the station leaves the main direction.
- Ask "为什么这首".
- Confirm the answer is natural and references the station direction.
```

- [ ] **Step 3: Run docs diff check**

Run:

```powershell
git diff --check -- docs/superpowers/checklists/2026-06-01-continuous-ai-radio-host-smoke.md
```

Expected: no whitespace errors.

- [ ] **Step 4: Commit**

```powershell
git add docs/superpowers/checklists/2026-06-01-continuous-ai-radio-host-smoke.md src/server.ts src/runtimeStatus.ts tests/ts/runtime-status.test.ts
git commit -m "Add agentic radio DJ diagnostics and smoke checks"
```

Only include files actually modified.

---

### Task 9: Full Verification

**Files:**
- No new files unless fixes are needed.

- [ ] **Step 1: Run typecheck**

Run:

```powershell
npm run typecheck
```

Expected: no TypeScript errors.

- [ ] **Step 2: Run full tests**

Run:

```powershell
npm test
```

Expected: all tests pass.

- [ ] **Step 3: Run local app smoke**

Run:

```powershell
npm run dev
```

Open the reported localhost URL and follow:

```text
docs/superpowers/checklists/2026-06-01-continuous-ai-radio-host-smoke.md
```

Expected:

- station starts
- DJ speaks or shows a short opening
- direction request gets a short acknowledgement
- bridge transition is narrated
- playback continues if TTS fails
- no `url_failed`, `playback_failed`, or `radio_brain_plan_failed` events appear for the smoke run

- [ ] **Step 4: Inspect git status**

Run:

```powershell
git status --short --branch
```

Expected: only intentional changes are committed or staged. Do not include unrelated `package-lock.json` unless intentionally resolved.

- [ ] **Step 5: Final commit for verification fixes if needed**

If verification required small fixes:

```powershell
git add <changed-files>
git commit -m "Stabilize agentic radio DJ flow"
```

---

## Implementation Notes

- Keep modules small. Do not fold contract, boundary, and narration logic into `server.ts`.
- Keep playback robust. No narration failure should block a playable track.
- Prefer deterministic checks first. Use LLM only where deterministic metadata is insufficient.
- Do not expose internal labels to listeners. Internal names such as `BoundaryGuard`, `StationContract`, and `DecisionTrace` belong in logs/tests, not UI copy.
- Do not make the station rigidly genre-locked. The product allows tasteful bridges, but the agent must know that a bridge is a bridge.
- Preserve the old scheduler fallback as a degraded continuity path.
- Watch for mojibake in existing files. Do not broaden encoding churn; keep edits scoped.
