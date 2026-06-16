# Radio Agent Closure Audit Design

**Date:** 2026-06-17
**Branch:** `codex/hermes-radio-agent-service`
**Status:** Design approved for project-level cleanup and closure planning

## Purpose

This document resets the next phase of FREQME around one product goal:

> Build an AI radio agent that runs the station as a persistent DJ assistant, learns the listener over time, keeps a coherent program, speaks only when useful, and survives restarts with memory.

This is not a request to tune R&B, patch "next song" again, or add more host templates. Those symptoms exposed the real problem: the project currently has useful agent foundations, but it still has multiple decision centers. The next phase must cleanly close the architecture so there is one agent-owned radio loop.

The target is inspired by Hermes and Pi, but FREQME should not copy their code shape blindly. The useful principles are:

- platform entry points are adapters, not the agent brain;
- the agent core owns session state, memory, tool use, and decisions;
- tools are explicit, typed, observable, and replaceable;
- memory is durable, compact, curated, and used before decisions;
- long-running sessions need event history, context compression, and recovery boundaries;
- fallback is allowed only when it is explicit and observable.

Sources:

- Hermes architecture: https://hermes-agent.nousresearch.com/docs/developer-guide/architecture
- Hermes agent repository: https://github.com/nousresearch/hermes-agent
- Pi coding agent repository and SDK/runtime model: https://github.com/earendil-works/pi
- Pi docs: https://pi.dev/

## Current Audit Summary

The current branch has real assets worth preserving:

- `RadioAgentRuntime` records agent events, artifacts, memory signals, decisions, and status.
- `RadioAgentService` already returns typed actions such as `play_now`, `speak`, `fallback`, and `honest_not_found`.
- `RadioAgentProgramDirector` and `RadioAgentProgramExecutor` can produce and execute short program windows.
- `PlaybackGovernor` is starting to enforce contract, duplicate, audio, and host-safety gates.
- `RadioAgentStore` persists events, memories, library evidence, artifacts, and decisions.
- `user_profile.md`, `station_now.md`, `program_contract.md`, `listener_session.md`, `session_reflection.md`, and repair artifacts already exist as a memory/context surface.
- Tests cover many individual behaviors around host safety, contract handling, queue continuation, playback governance, and memory signals.

The main problem is not missing components. The main problem is ownership.

Important current code smells:

- `src/server.ts` is about 1686 lines and still acts as gateway, playback state machine, fallback owner, old brain dispatcher, queue executor, websocket presenter, request handler, TTS runner, and recovery coordinator.
- `src/radio-agent/radioAgentRuntime.ts` is about 1533 lines and mixes event persistence, library scan orchestration, profile distillation, station artifacts, program planning, host decisions, explicit style detection, and session restoration.
- `src/radio-agent/programDirector.ts` is about 1119 lines and mixes LLM planning, deterministic fallback planning, host fallback generation, style heuristics, negative constraints, and recovery anchors.
- `RadioAgentService` has started to own actions, but `server.ts` still directly invokes `radioBrain`, `stationDirector`, `fillQueue`, `kickBrainContinuation`, and station fallback paths.
- Old `src/radio/*` planners still participate in normal playback, not only in explicitly labeled fallback.
- Some style handling remains hard-coded, especially around R&B, instead of being data-driven through a generic style/contract mechanism.
- Mojibake and unsafe host phrases are filtered in several places, which is useful, but it indicates that host expression is still being repaired after generation rather than consistently produced through one host controller.

Therefore the cleanup target is:

> Turn the existing pieces into one owned Radio Agent loop, and demote every old planning path into explicit tools or fallback actions.

## Non-Negotiable Product Shape

The product is an agent, not a player.

The agent must:

- start music quickly instead of blocking on deep reasoning;
- ingest playlists, library tracks, listening evidence, requests, skips, and corrections in the background;
- distill durable listener memory from repeated evidence;
- separate durable facts, tentative hypotheses, and session-only evidence;
- infer current context from time, timezone, weather, session state, current track, recent tracks, queue state, and user text;
- maintain an active program contract for the current session;
- plan short radio windows instead of isolated next-song guesses;
- decide when to speak and when to stay silent;
- keep ordinary continuations on contract;
- allow adjacent moves only as deliberate bridges with a return requirement;
- update memory and contract after feedback;
- explain important decisions from traces;
- recover honestly when tools fail;
- survive restart without losing the listener profile or active direction.

The agent must not:

- hide old scheduler decisions as agent decisions;
- keep playing off-contract music under an explicit user direction;
- let fallback bypass the playback governor;
- turn one skip into a permanent dislike;
- speak internal debug language to the listener;
- continue adding genre-specific patches as the main development strategy.

## Recommended Approach

Use a boundary-first cleanup. This is the middle path between patching and rewriting.

### Rejected Approach A: Continue Symptom Patching

This would keep fixing visible failures such as "R&B drift", "host does not speak", "host says awkward text", or "track end stalls" one by one.

It is fast in the moment, but it preserves the root problem: multiple systems can still choose music, speak, and fallback independently. This is how the project became hard to trust.

### Rejected Approach B: Rewrite From Zero

A rewrite would create a clean mental model, but it would throw away useful code:

- NetEase integration;
- audio resolution;
- queue infrastructure;
- persisted radio agent store;
- memory artifacts;
- current program executor;
- playback governor;
- existing tests.

It would also risk creating a new unproven stack with fewer safety rails.

### Chosen Approach C: Boundary-First Agent Closure

Keep the useful implementation assets, but change the ownership model:

- `server.ts` becomes `RadioGateway` plus `RadioActionRunner`.
- `RadioAgentService` becomes the only normal playback decision owner.
- `RadioAgentRuntime` remains the event, memory, artifact, and trace substrate.
- old `radioBrain`, `stationDirector`, `scheduler`, and related components become tools or explicitly labeled fallback.
- every playable track must pass `PlaybackGovernor` before entering playback.
- host speech must pass one host controller and delivery guard.
- style/mood handling becomes registry plus contract matching, not scattered code branches.

## Target Architecture

```text
Frontend / HTTP / WebSocket
  -> RadioGateway
      normalize transport events
      send user-facing responses
      execute returned actions only

  -> RadioAgentCore
      receive typed radio events
      read compact memory/context
      update active contract
      plan short program windows
      call tools
      decide host speech/silence
      return typed actions
      write traces

  -> RadioAgentRuntime
      persist event stream
      maintain artifacts
      distill memory
      expose status
      support background work

  -> RadioToolRegistry
      NetEase search/read library
      SearchVerify
      AudioResolver
      PlaybackQueue inspection/mutation
      TTS
      Weather
      LegacyFallback

  -> RadioActionRunner
      execute play_now / queue_window / speak / stay_silent / honest_not_found / fallback
      never choose tracks independently
```

The key ownership rule:

> No track enters ready queue or playback unless the agent core returned or explicitly approved that action.

## Component Boundaries

### RadioGateway

`server.ts` should be reduced toward a gateway and presenter.

Responsibilities:

- own HTTP and WebSocket connection handling;
- normalize websocket messages into typed radio events;
- pass events to `RadioAgentCore` or `RadioAgentService`;
- execute returned actions through `RadioActionRunner`;
- send `session_start`, `play_track`, `segue`, `request_status`, `error`, and status updates;
- mirror agent events for diagnostics.

Non-responsibilities:

- no direct program planning;
- no direct station direction choice;
- no direct style seed selection;
- no direct `radioBrain.handleUserText` for normal user requests;
- no direct queue fill except through an agent-returned fallback action;
- no host copy generation beyond rendering already approved host text.

### RadioAgentCore / RadioAgentService

The service should become the normal station owner.

Responsibilities:

- handle `session_start`, `user_text`, `track_ended`, `skip`, `correction`, `queue_low`, `explain`, and `idle_tick`;
- load durable profile and session context before planning;
- create or repair an active contract for explicit user directions;
- clear or quarantine incompatible ready items when the contract changes;
- ask the program planner for a short window;
- execute candidate preparation through tools;
- call `PlaybackGovernor` on every candidate;
- decide whether to play, queue, speak, stay silent, repair, fallback, or honestly stop;
- return typed actions only.

The service may wrap the existing `RadioAgentRuntime`, `RadioAgentProgramDirector`, `RadioAgentProgramExecutor`, and `PlaybackGovernor`, but it must not leak decision ownership back to the gateway.

### RadioAgentRuntime

The runtime should become the event and memory substrate, not the playback controller.

Responsibilities:

- append normalized events;
- start library scan and background distillation;
- refresh compact artifacts;
- store memories and decisions;
- expose status and governance summaries;
- provide compact context snapshots to the core.

Things to remove or extract from runtime over time:

- direct style-specific request logic;
- large contract parsing helpers;
- host text fallback generation;
- planning fallback details that belong in `ProgramDirector` or a style registry.

### RadioToolRegistry

Tools should be explicit application capabilities. The first implementation can use local classes rather than LLM-callable schemas, but the boundary should be typed.

Initial tools:

- `read_user_profile`
- `read_station_now`
- `read_active_contract`
- `scan_user_library`
- `distill_user_taste`
- `plan_program_window`
- `search_music`
- `verify_track`
- `resolve_audio`
- `inspect_queue`
- `queue_track`
- `clear_incompatible_queue`
- `synthesize_tts`
- `get_weather`
- `legacy_fallback`
- `write_trace`
- `write_memory_signal`

The old stack can remain behind tools:

- `RadioBrain` becomes `legacy_program_fallback`.
- `AIStationDirector` becomes `legacy_request_fallback`.
- `StreamScheduler` becomes `legacy_safe_track_fallback`.
- `QueueWarmer` remains a tool implementation detail, not a decision owner.

### RadioActionRunner

The action runner executes decisions but does not invent them.

Supported actions:

```ts
type RadioAgentAction =
  | { type: "play_now"; track: Track; url: string; reason: SelectionReason; hostText?: string; governanceTrace?: PlaybackGovernanceTrace }
  | { type: "queue_window"; window: RadioAgentProgramWindow; prepared: RadioAgentPreparedTrack[] }
  | { type: "speak"; text: string; speechRole: SpeechRole }
  | { type: "stay_silent"; reason: string }
  | { type: "repair_contract"; contract: AgentSessionContract; reason: string }
  | { type: "fallback"; level: FallbackLevel; reason: string; action?: RadioAgentAction }
  | { type: "honest_not_found"; contract: AgentActionContract | null; reason: string; searchedQueries: string[]; governanceTrace?: PlaybackGovernanceTrace };
```

The current action shape is close. The cleanup should add stronger execution semantics and tests so gateway code cannot bypass it.

## Memory Model

The agent should not store everything as memory. It should distill evidence.

Layers:

1. **Raw events:** playback started, completed, skipped, request, correction, search failure, host speech.
2. **Session evidence:** one skip, one correction, one temporary request, current program direction.
3. **Taste hypotheses:** repeated but not yet stable signals.
4. **Durable facts:** repeated explicit or behavioral evidence.
5. **Compact artifacts:** `user_profile.md`, `station_now.md`, `program_contract.md`, `listener_session.md`, `session_reflection.md`, `agent_repair.md`.
6. **Decision traces:** why a track played, why a candidate was rejected, why the host spoke or stayed silent.

Rules:

- one skip is session evidence only;
- explicit correction updates active contract immediately;
- repeated explicit correction may become durable memory;
- repeated completed listening can strengthen a preference;
- durable avoids must not become positive recommendation anchors;
- memories need evidence references and confidence;
- restart restores durable profile and active session context when possible.

This is the "gets smarter with use" loop:

```text
behavior/request/correction
  -> event
  -> session evidence
  -> reflection/distillation
  -> compact memory artifact
  -> future contract/planning changes
  -> trace-backed explanation
```

## Program Contract

Every explicit listener direction creates or repairs a contract.

The contract should include:

- raw user text;
- listener-facing station brief;
- positive anchors;
- allowed adjacent moves;
- disallowed moves;
- bridge budget;
- return requirement;
- active request token or source event id;
- status;
- created and updated timestamps.

The contract must outlive a failed search. If the user says "play R&B" and no candidate is playable, the correct state is not "drop the contract"; it is:

- continue searching within contract;
- widen only through allowed adjacent moves;
- or return `honest_not_found`.

## Music Understanding

Do not hard-code the product around R&B.

Replace scattered style logic with:

- `StyleIntentRegistry`: data definitions for style and mood directions;
- `ContractMatcher`: deterministic match between contract and candidate metadata;
- `MusicUnderstandingJudge`: optional LLM/metadata judge for uncertain candidates;
- `StyleSeedRegistry`: curated seed data with cooldown and exhaustion rules.

R&B, quiet jazz, focus music, and Chinese mood requests become regression cases using the same mechanism.

The matching pipeline should be:

1. hard block check;
2. direct positive metadata evidence;
3. registry style evidence;
4. model semantic check when deterministic evidence is insufficient;
5. bridge check only when bridge budget remains and return is recorded.

Search query text, host text, and old selection prose are not positive evidence by themselves.

## Playback Governance

The playback governor is the final hard gate.

Every candidate must pass:

- active request token is current;
- active contract allows it;
- candidate is not current track;
- candidate is not in recent playback window;
- candidate is not already ready;
- candidate is not from an exhausted seed group;
- audio is playable;
- host text is safe.

If all candidates fail under an explicit contract, the agent should return `honest_not_found` or a bounded recovery. It should not play unrelated music just to avoid silence.

Fallback levels:

1. `agent_program`
2. `same_contract_verified`
3. `same_contract_recent_safe`
4. `legacy_with_label`
5. `honest_not_found`

`legacy_with_label` is allowed only when it is explicit, traceable, and still passes the governor under an active explicit contract.

## Host Agent

The host is an agent output, not a decorative template layer.

The host may speak for:

- opening;
- user direction acknowledgement;
- correction;
- recovery;
- explanation;
- deliberate bridge;
- return to contract.

The host should stay silent for:

- ordinary on-contract continuation;
- low-interruption listening;
- uncertain planning;
- repeated speech density;
- transitions where music is enough.

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
- current station direction;
- main line;
- texture beside it;
- "continue this feeling";
- mojibake or replacement characters.

Awkward text such as "this track is close to the texture beside it, but the main line continues" should be rejected before delivery, not treated as acceptable DJ speech.

## Event Flows

### Session Start

```text
handshake/session_restored
  -> load profile/session artifacts
  -> choose fast opening candidate from reliable evidence
  -> governor approves opening candidate
  -> play quickly
  -> start library/profile/now refresh in background
  -> create or restore contract
  -> warm short program window
```

### User Direction

```text
user_text
  -> classify intent
  -> create or repair contract
  -> clear incompatible queue
  -> plan short window
  -> prepare candidates through tools
  -> governor approves candidate
  -> play/queue or honest_not_found
  -> speak only if useful
  -> write trace
```

### Track End

```text
track_ended
  -> agent revalidates ready item
  -> promote if approved
  -> if queue empty, plan continuation from active contract
  -> if continuation fails, bounded recovery
  -> if recovery fails, honest status instead of silent stall
```

### Correction

```text
correction/negative feedback
  -> record session evidence
  -> repair active contract
  -> remove incompatible ready items
  -> plan replacement window
  -> approve replacement through governor
  -> short host acknowledgement if useful
  -> update repair journal
```

### Idle / Background

```text
idle_tick/listening gap
  -> scan missing library evidence
  -> distill profile
  -> refresh station_now
  -> reflect session
  -> prepare backup candidates
  -> compact artifacts
```

## Cleanup Scope

The next implementation should be finite and gate-driven.

### Slice 1: Gateway And Action Runner Boundary

Goal:

- move action execution out of ad hoc websocket code;
- prevent `server.ts` from choosing normal playback directly;
- route session start, user text, correction, track end, and queue low through the agent service.

Expected files:

- create or extract `src/radio-agent/actionRunner.ts`;
- create or extract `src/radio-agent/radioGateway.ts` only if useful;
- modify `src/server.ts`;
- update websocket/server wiring tests.

### Slice 2: Toolized Legacy Fallback

Goal:

- demote `radioBrain`, `stationDirector`, and scheduler paths to explicitly labeled fallback tools;
- require fallback to pass the same playback governor under active contracts;
- make fallback level visible in status and traces.

Expected files:

- create `src/radio-agent/tools.ts` or focused tool adapters;
- modify `radioAgentService.ts`;
- modify fallback call sites in `server.ts`;
- add tests proving fallback cannot bypass the agent.

### Slice 3: Contract And Music Understanding Cleanup

Goal:

- extract style-specific request logic from runtime;
- make style and mood handling registry-driven;
- make candidate-contract matching shared by planner, verifier, governor, and smoke tests.

Expected files:

- create `src/radio-agent/styleIntentRegistry.ts`;
- create `src/radio-agent/contractMatcher.ts`;
- modify `contractController.ts`, `programDirector.ts`, `playbackGovernor.ts`, `radioAgentRuntime.ts`;
- add cross-style tests.

### Slice 4: Memory Curator Boundary

Goal:

- extract memory/artifact distillation from `RadioAgentRuntime`;
- preserve compact durable memory across restart;
- make session evidence vs durable memory testable.

Expected files:

- create `src/radio-agent/memoryCurator.ts`;
- create `src/radio-agent/contextEngine.ts` if needed;
- modify `radioAgentRuntime.ts`;
- extend memory and restart tests.

### Slice 5: Host Controller Cleanup

Goal:

- make speech/silence decisions explicit and centralized;
- reject unsafe host text before delivery;
- keep ordinary continuation silent by default.

Expected files:

- create or refine `src/radio-agent/hostController.ts`;
- modify `hostPolicy.ts`, `hostDelivery.ts`, `programDirector.ts`, and websocket presenter;
- add corpus tests.

### Slice 6: Closure Harness

Goal:

- create one trustworthy acceptance harness for the whole radio loop;
- prove the agent is not stalling, drifting, looping, or leaking internal language.

Scenarios:

- fast start;
- track end continuation;
- explicit direction plus 3 track ends;
- correction changes next item;
- restart preserves memory;
- host text scan;
- fallback visibility.

## Acceptance Gates

The project is not closed until these pass on current code:

1. **Agent ownership:** session start, user text, correction, queue low, track end, and fallback routing go through the agent service boundary.
2. **Fast start:** playback starts within 30 seconds when a safe known candidate exists.
3. **No end stall:** after track end, the station starts another approved item, enters recovery, or honestly reports why it cannot continue within 15 seconds.
4. **Direction contract:** explicit user direction creates and preserves a contract even if the first search fails.
5. **Three-track retention:** after explicit direction, the next 3 promoted tracks stay on contract or record a deliberate bridge with return.
6. **Cross-style proof:** retention works for R&B, quiet jazz, focus/quiet, and one Chinese mood request through the same mechanism.
7. **Correction loop:** user correction removes incompatible ready items and changes the next playable item.
8. **Memory persistence:** repeated explicit preferences/avoids survive restart and influence future opening or continuation.
9. **Host naturalness:** host text avoids internal terms, mojibake, and fake filler; ordinary continuation is usually silent.
10. **Safe degradation:** model/search/TTS/audio failures return bounded actions and visible fallback levels.
11. **Observability:** status/traces show active contract, chosen action, rejected reasons, fallback level, and memory readiness.
12. **No hidden legacy DJ:** old radio components may execute only as explicit tools or labeled fallback.

## Development Rules

- Do not run goal-mode live-smoke loops that keep adding patches without a written task.
- Do not add genre-specific branches unless they are registry data and cross-style tests use the same path.
- Do not claim closure from unit tests alone.
- Do not let fallback bypass the governor.
- Do not commit runtime logs or temp smoke files.
- Every behavior change must start with a failing test or a captured failing acceptance case.
- Keep implementation slices small and commit after fresh verification.
- Prefer deleting or demoting duplicated decision paths over adding another coordination layer.

## Release Labels

Before the acceptance gates pass:

> Hermes Radio Agent Foundation

After the gates pass:

> Hermes Radio Agent Closure Candidate

The project should not be described as a full, mature Hermes-style private DJ until sustained live sessions prove the memory loop, correction loop, and playback loop under real listening conditions.
