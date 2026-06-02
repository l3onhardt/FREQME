# Hermes Radio Agent Target Design

**Date:** 2026-06-03
**Status:** Target reset for user review
**Branch:** `codex/hermes-radio-agent-service`

## Purpose

This document resets the product target for FREQME so the work does not drift into another patch layer on top of the existing player.

The goal is a Hermes/pi-style long-term AI radio DJ agent. FREQME should not be a music player with smarter recommendation helpers. It should be a persistent agent that runs the station: it learns the listener, maintains the current program, decides what to play next, explains meaningful decisions, speaks only when it has a reason, and survives restarts without losing its understanding.

The old radio stack is useful, but it is not the final center. NetEase access, search verification, audio resolution, queue operations, TTS, weather, and deterministic guards become tools and adapters. The new `RadioAgentRuntime` becomes the eventual station brain.

## Non-Negotiable Product Shape

The agent must behave like a long-term private DJ, not like a playlist generator.

It must:

- start music quickly after login instead of making the listener wait for reasoning;
- ingest all usable library evidence in the background, including playlists, liked music, recent play history, and high-frequency listening when available;
- distill durable listener memory and keep it across restarts;
- infer current listening context from time, timezone, weather, location, current track, recent tracks, queue state, skips, and user text;
- maintain an active station contract that says what the current program is doing;
- know the difference between staying on-contract, making a deliberate bridge, drifting, and returning to contract;
- plan multi-track radio windows, not isolated next-song guesses;
- decide whether the host should speak or stay silent;
- generate host speech that sounds like a radio DJ, not an internal debug explanation;
- write explainable traces for important playback and speech decisions;
- learn from feedback without turning one skip into a permanent dislike;
- degrade to the old playback stack when the agent cannot produce a safe action.

## Architecture Anchors

Hermes contributes the service-level shape:

- gateway entry points turn external events into agent events;
- one platform-independent agent core owns reasoning and state;
- tools are registered explicitly rather than hidden inside workflows;
- session persistence, memory providers, context files, and context compression are first-class concerns;
- background jobs and context hygiene are part of the agent loop, not afterthoughts.

Pi contributes the embedded runtime shape:

- the host app embeds a small agent core;
- application events become agent messages;
- context is transformed before the LLM boundary;
- tool calls are typed and observable;
- runtime state and session storage allow steering, interruption, and continuation.

For FREQME, this means login, playback, queue, skip, user text, host speech, and memory update events all enter the same radio-agent transcript. Before any model call, the context engine compresses raw history into stable artifacts such as `user_profile.md`, `station_now.md`, and `program_contract.md`.

## Current State

The current branch already has a useful Phase 1 foundation:

- `RadioAgentRuntime` exists and receives mirrored radio events.
- `RadioAgentStore` persists events, memory, library evidence, artifacts, and shadow decisions.
- Full-library scan works on real data.
- Deterministic taste distillation writes long-term facts and hypotheses.
- `user_profile.md`, `station_now.md`, and `program_contract.md` are generated.
- `user_profile.md` is now compacted for agent context rather than dumping all evidence.
- Host decisions are explicit, including silence.
- `/api/radio/agent/status` exposes shadow diagnostics.

But the current system is not yet the target product:

- the old playback chain still owns most real queue decisions;
- the new runtime observes and records more than it acts;
- the program contract is still shallow;
- host speech is not fully governed by the new agent;
- track explanations are not yet always generated from the new agent's own trace;
- learning from feedback is not yet a complete long-term loop.

## Correct Center of Gravity

The target center is:

```text
RadioAgentGateway
  -> RadioAgentRuntime
  -> ContextEngine
  -> ProgramDirector
  -> ToolRegistry
  -> DecisionTrace
  -> MemoryCurator
  -> HostAgent
```

The old stack is repositioned as tools:

```text
NetEaseService        -> search_music, scan_library, read_play_history
SearchVerifyAgent    -> verify_track
AudioResolver        -> resolve_audio
PlaybackQueue        -> queue_track, inspect_queue
TTSService           -> synthesize_tts
WeatherService       -> get_weather
BoundaryGuard        -> evaluate_boundary
AIStationDirector    -> temporary fallback planner, not final owner
RadioBrain           -> legacy fallback only
```

This is the central migration rule: if a change makes the old pipeline more elaborate while leaving the agent as an observer, it is not aligned with the target.

## First-Run Flow

The first-use experience should be:

```text
login_completed
  -> restore existing durable profile if present
  -> choose opening track from reliable evidence
  -> begin playback immediately
  -> start all-library ingestion in the background
  -> distill listener evidence
  -> write compact user_profile.md
  -> infer station_now.md
  -> create program_contract.md
  -> plan the first agent-led radio window
  -> warm the queue through tools
  -> shift into agent-led programming once confidence is high enough
```

Opening playback must not wait for library scan, LLM synthesis, weather, or TTS.

The host should be honest during warm-up. It may say a short opening line, but it must not pretend deep personalization is ready before the profile is ready.

## Agent-Owned Program Model

The radio agent must plan windows, not isolated tracks.

An agent-owned radio window should include:

- `station_brief`: what this section of the station is doing;
- `main_direction`: the primary musical lane;
- `allowed_adjacent`: acceptable nearby moves;
- `bridge_budget`: how many deliberate bridge tracks are allowed;
- `disallowed`: directions that would be drift;
- `return_requirement`: how the program returns after a bridge;
- `candidate_tasks`: concrete search or known-track tasks;
- `host_intent`: whether the host should speak and why;
- `trace_basis`: profile, context, and contract evidence used.

The agent may use an ambient, instrumental, classical, electronic, or other adjacent track only when the contract explicitly permits it as a bridge and the return plan is clear. Otherwise, those moves are drift.

## Host Model

The host is part of the agent, not a decorative TTS layer.

The host speaks for:

- station opening;
- user direction acknowledgement;
- deliberate bridge;
- return to contract;
- correction after drift;
- explanation request;
- recovery from playback or search trouble.

The host stays silent for:

- ordinary continuation;
- low-interruption listening;
- uncertain background planning;
- repeated speech density;
- transitions where the music already carries the point.

Host text must be listener-facing. It must not expose internal words such as model, JSON, candidate, trace, prompt, verification, profile pipeline, shadow mode, or tool call.

## Memory and Learning

Memory has separate layers:

- raw library evidence;
- durable taste facts;
- tentative taste hypotheses;
- session-only feedback;
- compact profile summaries;
- station context summaries;
- program contracts;
- decision traces;
- host decisions.

Learning rules:

- one skip becomes session evidence only;
- repeated skips with shared features become a tentative hypothesis;
- explicit correction is stronger than passive behavior;
- repeated explicit corrections can become durable memory;
- stale hypotheses decay or get overwritten;
- user feedback can revoke or weaken old assumptions;
- memory items keep evidence references and confidence.

The product should get smarter through use because the agent updates memory and contracts from real behavior, not because more template code was added.

## Migration Phases

### Phase 1: Shadow Foundation

The new runtime observes the station and writes durable state.

Already mostly present:

- event gateway;
- full-library scan;
- taste distillation;
- compact profile artifact;
- station context artifact;
- program contract artifact;
- host shadow decision;
- status endpoint.

Missing or weak:

- richer context inference;
- stronger contract generation;
- complete feedback-to-memory loop.

### Phase 2: Assisted Agent

The agent starts producing actions, but the old stack still executes and falls back.

Deliverables:

- agent-owned radio window suggestions;
- candidate search tasks created from profile plus context plus contract;
- host intent attached to planned transitions;
- decision traces for agent-suggested tracks;
- explain-current-track from those traces;
- safety fallback to legacy queue if tool execution fails.

The old stack can still search, verify, resolve audio, and queue tracks. It should not decide the program objective when the agent has a valid plan.

### Phase 3: Active Agent

The agent controls normal station programming.

Deliverables:

- active queue preparation through tools;
- boundary and bridge decisions governed by the station contract;
- feedback directly updates session state and memory;
- host speech comes from the host agent;
- old `RadioBrain` is used only for recovery.

### Phase 4: Legacy Reduction

Remove old planning ownership only after:

- live traces show the new agent is more coherent;
- tests cover startup, feedback, drift, memory, restart, and recovery;
- fallback playback still works;
- the user-facing host feels intentional rather than templated.

## What Not To Build Now

Do not spend the next phase on:

- perfect universal style recognition;
- perfect mood prediction;
- large multi-agent fleets;
- a complex visual diagnostics dashboard;
- deleting all legacy logic in one pass;
- more template host lines without trace-backed decisions;
- another isolated recommender beside the old player.

These are future extensions. The immediate target is center-of-gravity migration: the agent must start owning program intent.

## Next Implementation Plan Boundary

The next implementation plan should start with Phase 2, not with more shadow-only polish.

The first implementation slice should build:

```text
queue_low or track_completed
  -> RadioAgentRuntime reads user_profile.md, station_now.md, program_contract.md
  -> ContextEngine builds compact agent context
  -> ProgramDirector emits an agent-owned radio window
  -> Tool adapters try to execute the first candidate
  -> DecisionTrace records why it was chosen
  -> HostAgent emits speak/silent intent
  -> legacy stack remains fallback
```

This slice is aligned because it makes the requested final state more true: the agent begins to own what the station is doing.

## Success Criteria

FREQME is on target when:

- the listener hears music quickly;
- profile building happens in the background;
- the agent uses all available library evidence over time;
- current context changes the station plan;
- the program stays coherent across several tracks;
- bridges are deliberate and have return plans;
- the host speaks naturally or stays silent intentionally;
- feedback affects future behavior without overfitting;
- restart preserves profile and station understanding;
- every agent-picked track has a trace that can answer why it played;
- old playback remains a fallback, not the product center.

The product is successful only when it feels like a private DJ with memory, context, tools, and accountable decisions. It is not successful merely because it uses a stronger model or produces nicer recommendation text.
