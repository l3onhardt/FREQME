# Hermes Radio Agent Beta Closure Design

**Date:** 2026-06-16
**Branch:** `codex/hermes-radio-agent-service`
**Status:** Design for bounded closure

## Purpose

This design turns the current Hermes-style radio work into a finite closure target.

The product goal is an agentic AI DJ radio host, not an R&B recommender, not a jazz seed rotator, and not a playlist player with generated text. Genre requests such as R&B, quiet jazz, focus music, and Chinese mood prompts are regression scenarios for the same agent behavior. They must not become separate product centers.

The closure target is:

> A Radio Agent that owns session events, listener directions, memory context, program contracts, tool execution, playback governance, host speech, fallback honesty, and decision observability well enough to run a normal session without stalling, drifting, looping, or exposing internal language.

This is still a Beta closure, not the final "perfect Hermes v1." It is complete only when the live gates in this document pass.

## Current Problem

The branch already has meaningful agent foundations:

- `RadioAgentRuntime` persists events, memories, artifacts, status, and decisions.
- `RadioAgentService` handles session start, user text, correction, and track-end paths.
- `ProgramDirector` and `ProgramExecutor` can produce and execute short program windows.
- `BoundaryGuard`, `SearchVerifyAgent`, queue recovery, and host text filters cover many regressions.
- `/api/radio/agent/status` exposes listener-safe agent state.

But playback is not yet closed under agent control.

Important station intelligence is still split across:

- `src/server.ts`
- `RadioAgentService`
- legacy `radioBrain`
- `stationDirector`
- `scheduler`
- `searchVerifyAgent`
- direct queue manipulation
- fallback paths that can run after an agent decision

This split causes the observed product failures:

- a listener direction can create a plan but fail to become a durable hard session contract;
- a fallback path can queue or promote a track that did not pass the same agent gates;
- recent-track context can exist in planning but still be ignored by final playback;
- local style seeds can A/B loop when the safe pool is exhausted;
- host text can improve in one path but not be uniformly controlled;
- tests can pass while live websocket or browser behavior remains unproven.

The closure design fixes ownership first. Genre quality improves only as a consequence of agent ownership, not by adding more one-off genre patches.

## Product Boundary

### In Scope

- Make one agent service boundary own session start, user text, correction, queue low, track end, and fallback routing.
- Convert explicit listener directions into session contracts immediately, even if the first search attempt fails.
- Ensure every playable item passes the same final playback governor before entering playback.
- Prevent immediate repeats and small seed A/B loops as hard playback failures.
- Keep program windows short and inspectable.
- Keep memory artifacts durable enough to survive restart for explicit preferences and avoids.
- Make host speech listener-facing, sparse, and safe.
- Add live acceptance harnesses for websocket and browser playback.
- Keep legacy playback as an honest fallback tool, not a hidden second DJ.

### Out of Scope

- Perfect genre recognition.
- Perfect mood prediction.
- Full multi-agent parallelism.
- A complex visual diagnostics console.
- Rewriting every old radio component in one pass.
- Adding more hard-coded tracks as the main way to fix behavior.
- Claiming v1 complete from unit tests alone.

## Target Architecture

```text
Browser / WebSocket / HTTP
  -> RadioGateway
      adapts transport events into typed radio agent events

  -> RadioAgentCore
      EventLoop
      MemoryContext
      ContractController
      ProgramPlanner
      ToolExecutor
      PlaybackGovernor
      HostController
      ReflectionUpdater
      TraceWriter

  -> RadioTools
      NetEaseSearch
      SearchVerifier
      AudioResolver
      PlaybackQueue
      TTS
      Weather
      BoundaryGuard
      LegacyFallback
```

`src/server.ts` should become a gateway. It may hold websocket state and execute returned actions, but it must not invent station intelligence, mutate program direction independently, or promote tracks outside the agent governor.

`RadioAgentService` can either become `RadioAgentCore` or wrap the core. The naming is less important than the ownership rule:

> No track may enter playback unless the agent service has returned or approved the playback action.

## Core Components

### RadioGateway

Responsibilities:

- accept websocket handshake, user text, skip, track end, and browser status events;
- normalize transport payloads into typed agent events;
- execute typed agent actions returned by the service;
- send listener-facing websocket responses;
- never directly choose station direction or override the active contract.

Non-responsibilities:

- no direct style seed selection;
- no direct station fallback except by executing an explicit fallback action from the agent service;
- no direct promotion of ready tracks that have not passed the playback governor.

### RadioAgentCore

Responsibilities:

- receive typed radio events;
- load relevant memory artifacts and session state;
- update the active session contract;
- plan or repair a short program window;
- ask tools to prepare verified playable tracks;
- pass every candidate through `PlaybackGovernor`;
- decide whether to speak, stay silent, recover, or honestly report not found;
- write decision traces and status artifacts.

The core should return typed actions, not mutate transport state directly.

Example action family:

```ts
type RadioAgentAction =
  | { type: "play_now"; track: Track; url: string; reason: SelectionReason; hostText?: string }
  | { type: "queue_window"; window: RadioAgentProgramWindow; prepared: RadioAgentPreparedTrack[] }
  | { type: "speak"; text: string; speechRole: "opening" | "ack" | "correction" | "recovery" | "explanation" }
  | { type: "stay_silent"; reason: string }
  | { type: "repair_contract"; contract: AgentSessionContract; reason: string }
  | { type: "fallback"; level: FallbackLevel; reason: string; action?: RadioAgentAction }
  | { type: "honest_not_found"; contract: AgentSessionContract; reason: string; searchedQueries: string[] };
```

The exact TypeScript shape can be adjusted during implementation, but the service must expose explicit action intent instead of implicit side effects.

### MemoryContext

Responsibilities:

- build compact context from durable profile, current session, now, recent playback, ready queue, corrections, and environment;
- write and read artifacts:
  - `user_profile.md`
  - `station_now.md`
  - `program_contract.md`
  - `session_reflection.md`
  - `repair_journal.md`
- separate durable facts from tentative hypotheses and session-only evidence.

Rules:

- one skip is session evidence, not permanent dislike;
- repeated explicit preferences or avoids may become durable memory;
- anonymous sessions can maintain session memory but do not claim durable user knowledge.

### ContractController

Responsibilities:

- create or update an `AgentSessionContract` for every explicit listener direction;
- preserve the contract even if the first playable candidate cannot be found;
- clear or quarantine incompatible queued tracks when the contract changes;
- expose contract state to planner, verifier, governor, host, and status endpoint.

The active contract should include:

- raw listener text;
- listener-facing station brief;
- positive style or artist anchors;
- disallowed moves;
- allowed adjacent moves;
- bridge budget;
- return requirement;
- source event id;
- expiry or replacement rule.

Important rule:

> `not_found` is not a reason to drop the contract. It is evidence that the next search or fallback must continue within the contract or honestly report exhaustion.

### ProgramPlanner

Responsibilities:

- plan a 3-5 track program window for explicit directions and queue-low continuation;
- use the current contract, user profile, now context, and recent playback;
- produce candidate tasks, negative constraints, host intent, and trace basis;
- avoid internal language in listener-facing fields.

Program windows are short because they are easier to verify and repair. Long autonomy should emerge from repeated short windows plus memory, not from one huge opaque plan.

### ToolExecutor

Responsibilities:

- execute candidate tasks through search, verification, audio resolution, and TTS tools;
- report attempted queries and failures;
- return prepared tracks, not directly promote them;
- keep tool outputs observable.

The executor should treat genre/style seed registries as data, not scattered branch logic.

### PlaybackGovernor

This is the critical closure piece.

Responsibilities:

- apply the final hard gate to every track before it is queued or promoted;
- reject stale request results;
- reject off-contract tracks;
- reject duplicate current/recent/ready tracks;
- reject exhausted local seed loops;
- verify playable audio;
- return structured rejection reasons for repair and observability.

Minimum checks:

```text
candidate
  -> request token is current
  -> active contract permits it
  -> not same as current track
  -> not in recent N tracks by id or normalized artist/title
  -> not already in ready queue
  -> not from an exhausted seed group
  -> has playable audio
  -> host text, if any, is safe
```

If all safe same-contract candidates are exhausted, the governor must not allow A/B looping. It should return `honest_not_found` or a bounded recovery action.

### HostController

Responsibilities:

- decide when to speak and when to stay silent;
- sanitize model and program host text;
- classify speech role;
- enforce host density and naturalness rules;
- reject internal language.

Allowed speech moments:

- station opening;
- listener direction acknowledgement;
- correction acknowledgement;
- recovery from search/playback/queue trouble;
- explanation requested by the listener;
- deliberate bridge entry or return.

Ordinary on-contract continuation should usually be silent.

Forbidden listener-facing text:

- prompt;
- model;
- JSON;
- candidate;
- trace;
- contract;
- tool call;
- verification;
- pipeline;
- shadow mode;
- main line;
- texture beside it;
- current station direction;
- any mojibake or replacement characters.

### ReflectionUpdater

Responsibilities:

- record important outcomes after playback, skip, correction, search failure, and recovery;
- distill repeated evidence into memory;
- avoid turning one-off misses into permanent facts.

Reflection should be used to make later behavior smarter, not to generate long visible explanations.

### TraceWriter And Status

Responsibilities:

- write compact traces for important decisions;
- expose listener-safe status through `/api/radio/agent/status`;
- include active contract, recent playback, planned action, chosen fallback level, and repair reason.

The status endpoint should help answer: "What did the agent think it was doing?"

## Event Flows

### Session Start

```text
handshake/session_restored
  -> load durable and session context
  -> select fast opening candidate from reliable evidence
  -> governor approves opening playback
  -> play quickly without waiting for long reasoning
  -> refresh profile/now artifacts in background
  -> restore or create program contract if appropriate
  -> warm short program window
```

Fast start must not wait for full library scan, weather, TTS, or long model planning.

### User Direction

```text
user_text
  -> classify intent
  -> create/update session contract immediately
  -> clear incompatible ready items
  -> plan short program window
  -> execute tools
  -> governor approves first playable item
  -> play or queue approved item
  -> speak short acknowledgement only when useful
  -> write trace and status
```

If no playable item is found, the contract remains active and the response is honest.

### Track End

```text
track_completed
  -> agent checks approved ready item
  -> governor revalidates before promotion
  -> promote approved item
  -> if queue low, plan continuation from active contract
  -> if no safe item, use bounded recovery
  -> if recovery fails, visible honest not-found/error status
```

No silent stall is acceptable.

### Correction

```text
negative feedback / correction / skip
  -> record session evidence
  -> repair or replace active contract
  -> remove incompatible ready items
  -> plan replacement window
  -> governor approves replacement
  -> speak plain correction acknowledgement
  -> write repair journal
```

Correction must affect the next playable item, not only the DJ text.

### Queue Low

```text
queue_low
  -> continue active contract
  -> avoid current/recent/ready tracks
  -> plan short window
  -> prepare approved candidates
  -> stay silent unless recovery or bridge needs explanation
```

## Style Seed Registry

The project may keep deterministic style seeds, but they must be centralized and governed.

The registry should describe:

- style id;
- markers;
- default concrete queries;
- blocked terms;
- allowed adjacent moves;
- seed groups;
- cooldown rules;
- exhaustion behavior.

Example:

```ts
interface StyleSeedDefinition {
  id: string;
  markers: string[];
  concreteQueries: string[];
  blockedTerms: string[];
  allowedAdjacent: string[];
  seedGroups: Array<{ id: string; queryKeys: string[]; cooldownTracks: number }>;
  exhaustion: "honest_not_found" | "widen_with_contract" | "legacy_with_label";
}
```

This avoids scattering style-specific logic through the verifier. R&B and quiet jazz become two entries in a generic mechanism, not special development centers.

## Fallback Policy

Fallback is allowed, but it must be explicit and honest.

Fallback levels:

1. `agent_program`: approved prepared track from the current program window.
2. `same_contract_verified`: verified track inside the active contract.
3. `same_contract_recent_safe`: previously playable track that still satisfies contract and is not recent duplicate.
4. `legacy_with_label`: old stack keeps audio moving, but status records that the agent degraded.
5. `honest_not_found`: no safe playback action exists.

Forbidden fallback:

- off-contract playback under an active explicit direction;
- current/recent duplicate playback;
- stale request result promotion;
- hiding legacy fallback as if it were an agent decision;
- speaking vague fake-DJ text to cover a planning failure.

## Implementation Slices

### Slice 1: Typed Agent Actions And Gateway Boundary

Goal:

- Make `RadioAgentService` return explicit actions.
- Make `server.ts` execute actions instead of continuing to hold station intelligence.

Verification:

- server-wiring tests prove session start, user text, correction, track end, and queue low route through the service.

### Slice 2: PlaybackGovernor

Goal:

- Add one final gate for all queue and promotion paths.
- Block off-contract, duplicate, stale, unplayable, and exhausted-seed candidates.

Verification:

- unit tests for every rejection reason;
- live smoke proves no A/B loop for direction + 3 track ends.

### Slice 3: ContractController

Goal:

- Create session contract on explicit user direction even when first search fails.
- Preserve contract through track end and fallback.
- Clear incompatible ready items.

Verification:

- user direction tests show contract persists after not-found;
- correction tests show stale ready items are removed.

### Slice 4: StyleSeedRegistry

Goal:

- Move deterministic style seeds out of scattered verifier branches.
- Add cooldown and exhaustion behavior per seed group.

Verification:

- cross-style tests cover R&B, quiet jazz, focus, and Chinese mood request using the same mechanism.

### Slice 5: HostController Corpus

Goal:

- Verify host speech roles and silence behavior.
- Reject internal terms and mojibake.

Verification:

- corpus tests for opening, acknowledgement, correction, recovery, explanation, and ordinary continuation silence.

### Slice 6: Live Acceptance Harness

Goal:

- Automate websocket and browser closure checks.

Verification:

- local command runs:
  - fast start;
  - no end stall;
  - request + 3 track ends;
  - correction replacement;
  - audio probes;
  - status endpoint inspection;
  - host text scan.

## Acceptance Gates

The Beta closure is not complete until all gates below pass on current code.

1. **Agent ownership:** session start, user text, correction, queue low, track end, and fallback routing are handled through the agent service boundary.
2. **Fast start:** the app emits playable audio quickly when a safe known candidate exists.
3. **No end stall:** after track end, the station starts the next approved track, enters recovery, or gives a visible honest reason.
4. **Direction contract:** explicit listener direction creates a contract immediately, even if search fails.
5. **Three-track retention:** after a direction request, the next 3 promoted tracks stay on contract or record a deliberate bridge with return requirement.
6. **Cross-style proof:** the same direction-retention harness passes for R&B, quiet jazz, focus/quiet, and one Chinese mood request.
7. **No repeat loop:** current, recent, ready, and exhausted seed groups cannot A/B loop.
8. **Correction loop:** negative feedback removes incompatible ready items and affects the next playable item.
9. **Memory persistence:** repeated explicit preference or avoid evidence survives restart and changes later opening or continuation behavior.
10. **Host naturalness:** host text avoids internal terms, mojibake, and fake filler; ordinary continuation is usually silent.
11. **Safe degradation:** model/search/TTS/audio failures keep the system bounded and honest.
12. **Observability:** status and traces explain active contract, chosen action, rejected reason, and fallback level.

## Live Smoke Matrix

Required websocket scenarios:

- `play rnb`
- `play quiet jazz for reading`
- `play quiet focus music`
- one Chinese mood request
- correction: quiet jazz request followed by "do not play jazz, switch to late-night R&B"

For each direction scenario:

- open websocket;
- handshake;
- wait for first playable track;
- send request;
- require first approved request track;
- send three `track_ended` events;
- require next playable track after each;
- probe each audio URL with a range request;
- reject websocket errors;
- reject duplicate artist/title keys;
- reject off-contract tracks;
- reject unsafe host text.

Required browser scenarios:

- guest start reaches player and starts audio;
- synthetic `ended` advances to next approved track;
- request status and host text update without stale copy;
- status endpoint reflects current agent state.

## Development Rules

- Do not add genre-specific patches unless they become registry data and pass cross-style tests.
- Do not treat one green unit test as closure.
- Do not claim normal playback without live websocket or browser evidence.
- Do not allow fallback to bypass the governor.
- Do not commit runtime logs.
- Commit implementation only after fresh verification evidence.
- Keep R&B as a regression sample, not as the project center.

## Release Label

Before these gates pass, the correct label is:

> Hermes Radio Agent Beta Foundation

After these gates pass, the correct label is:

> Hermes Radio Agent Beta Closure

This design does not claim full Hermes AI DJ v1. Full v1 requires broader logged-in memory proof, richer long-term learning, and sustained listening validation beyond the closure gates.
