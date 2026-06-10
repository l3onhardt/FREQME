# Hermes-Style AI DJ Radio v1 Scope Design

**Date:** 2026-06-11
**Status:** Scope reset for implementation
**Branch:** `codex/hermes-radio-agent-service`

## Purpose

This document narrows the open-ended "make the radio as smart as Hermes" goal into a finite v1 that can be built, tested, and stopped.

The target is not a perfect music intelligence system. The target is a credible Hermes-style AI DJ radio agent: a persistent station operator that starts music quickly, learns from the listener, maintains a current program direction, plans short radio windows, speaks like a real host when useful, and corrects itself when the listener says it missed.

R&B drift is no longer the product goal. R&B is one regression scenario that revealed a broader failure: the station needs a durable program contract and agent-owned orchestration for every explicit listener direction.

## External Architecture Inputs

Hermes contributes the system shape:

- entry points adapt external events into the agent core;
- the agent loop owns prompt/context assembly, provider resolution, tool dispatch, compression, and persistence;
- tools are explicit and observable;
- session storage, memory, context compression, gateway delivery, and background jobs are first-class subsystems;
- the core agent remains platform-independent while entry points handle platform differences.

Pi contributes the embedded runtime shape:

- a host application can embed an agent runtime instead of becoming an agent framework itself;
- application events become agent messages;
- tool calls, state, and LLM boundaries remain typed and inspectable;
- runtime state enables interruption, continuation, and controlled degradation.

For FREQME v1, this means the radio backend remains the host application, while a bounded `RadioAgentService` becomes the station operator. NetEase, audio resolution, search verification, queueing, TTS, weather, and existing deterministic guards are tools/adapters used by the service.

Sources:

- Hermes architecture: https://hermes-agent.nousresearch.com/docs/zh-Hans/developer-guide/architecture
- Pi repository: https://github.com/earendil-works/pi

## v1 Product Definition

The v1 agent is successful when it can run a normal listening session without feeling like a playlist generator wrapped in fake DJ text.

It must:

- start playback fast after login or session restore;
- choose the opening track from reliable listener evidence when available;
- ingest library and listening evidence in the background;
- persist durable listener memory across restarts;
- separate durable facts, tentative hypotheses, and session-only feedback;
- build a compact "now" snapshot from time, timezone, weather, current track, recent tracks, queue state, and user text;
- maintain a current station contract for explicit listener directions;
- plan a short 3-5 track radio window instead of only guessing the next song;
- prepare playable tracks through existing search, verification, and audio-resolution tools;
- keep ordinary continuations on contract;
- allow adjacent or bridge tracks only when the contract permits them and a return path exists;
- decide whether the DJ should speak or stay silent;
- speak in listener-facing language, not internal planning language;
- record decision traces that explain important playback, correction, and speech decisions;
- learn from explicit corrections without turning one skip into permanent dislike;
- degrade safely to the older playback stack if the agent cannot produce a safe action.

## v1 Non-Goals

The v1 does not attempt:

- perfect genre recognition;
- perfect mood prediction;
- large-scale multi-agent parallelism;
- a complex visual diagnostics console;
- automatic rewrite of every legacy playback path;
- full replacement of every old planner in one pass;
- unlimited personalization before enough evidence exists;
- endless tuning around a single genre such as R&B.

## Current State To Preserve

The current branch already contains useful v1 foundations:

- `RadioAgentRuntime` receives radio events and writes memories/artifacts;
- `RadioAgentStore` persists events, memory, library evidence, artifacts, and shadow decisions;
- `LibraryCensus` can scan library evidence;
- `tasteDistiller.ts` separates facts, hypotheses, and session evidence;
- `contextArtifacts.ts` writes listener profile, station now, program contract, session, reflection, journal, and repair artifacts;
- `ProgramDirector` and `ProgramExecutor` can plan and prepare radio windows;
- `hostAgent.ts`, `hostPolicy.ts`, and `hostDelivery.ts` govern parts of host speech;
- `/api/radio/agent/status` exposes listener-safe agent readiness and explanation state;
- tests already cover many R&B drift regressions, host-speech safety issues, contract behavior, and queue continuation paths.

The newest uncommitted fixes should be retained as the final symptom patch before the v1 architecture pass:

- opening playback can use liked/library evidence instead of an empty liked list;
- durable artist avoids no longer become positive recommendation anchors;
- the server no longer uses the vague continuation prompt "continue this feeling" as an agent input.

## Correct Center For v1

The center of the system should move from scattered server orchestration to a focused service:

```text
RadioGateway
  -> RadioAgentService
      -> ContextBuilder
      -> OpeningSelector
      -> ContractManager
      -> ProgramPlanner
      -> ProgramExecutor
      -> HostController
      -> MemoryCurator
      -> DecisionTraceWriter
  -> RadioTools
      -> NetEaseSearch
      -> SearchVerifier
      -> AudioResolver
      -> PlaybackQueue
      -> TTS
      -> Weather
      -> BoundaryGuard
```

`src/server.ts` should adapt websocket and HTTP events into this service. It should not keep growing new station intelligence.

## v1 Event Flow

### Session Start

```text
handshake/session_restored
  -> restore durable profile and current session evidence
  -> choose a safe opening track from recent/anchor/liked/library evidence
  -> start playback
  -> emit honest opening host line if appropriate
  -> start or refresh library ingestion in background
  -> refresh user_profile.md and station_now.md
  -> create or restore program_contract.md
  -> plan first 3-5 track program window
  -> warm queue with playable verified tracks
```

Opening playback must not wait for full library scan, weather, long LLM reasoning, or TTS.

### User Direction

```text
user_text
  -> classify request/correction/question
  -> update current station contract
  -> clear incompatible queued tracks when needed
  -> plan a fresh short program window
  -> prepare one or more playable tracks
  -> speak a short acknowledgement only when useful
```

The station contract must work for any explicit direction, not only R&B.

### Track End

```text
track_completed
  -> promote next ready item if available
  -> if queue is low, continue from active station contract
  -> if no safe agent item exists, use legacy fallback
  -> record outcome and trace
```

The player must not stall silently after a song ends.

### Correction

```text
negative user text / skip / drift repair
  -> mark session evidence
  -> repair active contract
  -> remove incompatible ready items
  -> plan replacement window
  -> host acknowledges correction in plain language
  -> repeated explicit evidence may become durable memory
```

One skip is not a durable dislike. Repeated explicit corrections can become durable.

## Host Speech Contract

The DJ may speak for:

- opening the station;
- acknowledging a listener direction;
- correcting after a miss;
- explaining a requested decision;
- entering or returning from a deliberate bridge;
- recovery from search, playback, or queue trouble.

The DJ should stay silent for:

- ordinary on-contract continuation;
- low-interruption listening;
- uncertain background planning;
- repeated host density;
- transitions where the next song already carries the point.

Host text must not include internal terms such as:

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
- current station direction;
- main line;
- texture beside it.

## Acceptance Gates

v1 is not complete until all of these pass with current code:

1. **Fast start:** a logged-in/restored listener gets playable audio within 30 seconds when at least one playable known track exists.
2. **No end stall:** after a track ends, the station either starts the next track, begins a recovery path, or gives a visible/listenable reason. It must not silently stop.
3. **Direction retention:** after an explicit direction request, the next 3 tracks stay on contract unless a deliberate bridge is recorded with a return requirement.
4. **Cross-genre contract:** the direction-retention behavior is tested with at least R&B, jazz, quiet/focus, and one Chinese-language mood request.
5. **Correction loop:** after the listener rejects a direction or artist, incompatible queued items are removed and the next planned item reflects the correction.
6. **Memory persistence:** repeated explicit preferences and avoids survive a restart and influence later opening/continuation decisions.
7. **Host naturalness:** opening, acknowledgement, correction, recovery, and explanation speech avoid internal terms and vague fake-DJ phrasing.
8. **Agent ownership:** `server.ts` delegates session start, user text, track end, queue low, and correction decisions through `RadioAgentService` or equivalent service boundary.
9. **Safe degradation:** when the model, planner, TTS, search, or audio resolution fails, the old playback stack can keep music moving without pretending the agent made a smart decision.
10. **Observability:** for each important track decision, diagnostics show the active contract, evidence basis, chosen action, and fallback reason if any.

## Release Boundary

When these gates pass, the product may be called:

> Hermes-style AI DJ Radio v1

Before that point, status should remain:

> Radio Agent Alpha/Beta foundation

No final status should be claimed from unit tests alone. Browser playback and live websocket behavior are part of the acceptance evidence.

## Development Rule Going Forward

Do not add more one-off genre patches unless they generalize into one of the v1 mechanisms above.

Every new change must answer at least one of these questions:

- Does it move station intelligence out of ad hoc server code and into the agent service?
- Does it improve memory, context, contract, planning, execution, host speech, correction, or observability?
- Does it make one of the acceptance gates provably pass?

If not, it is likely another patch loop and should be rejected.
