# Long-Term Radio Agent Design

**Date:** 2026-06-03
**Status:** Draft for user review
**Branch:** `codex/hermes-radio-agent-service`

## Goal

Build FREQME as a long-term AI radio agent, not a smarter playlist player.

The product should feel like a private music assistant DJ that learns the listener over time, understands the current listening situation, keeps a coherent radio program, explains meaningful decisions, corrects itself after feedback, and survives restarts without losing memory.

The first version must prove the agent shape:

- start playback immediately after login
- ingest the user's full music library in the background
- distill the library into durable taste memory
- infer the current listening context from time, weather, location, session behavior, and recent music
- plan radio programs from taste memory plus current context
- decide when the host should speak or stay silent
- write every important decision into an explainable trace
- update memory from skips, requests, corrections, and accepted tracks
- recover the user profile and recent station state after restart

This design deliberately separates the new agent core from the existing playback stack. The existing NetEase integration, search verification, audio resolution, playback queue, TTS, WebSocket delivery, and deterministic safety checks remain valuable. They become tools and adapters used by the new agent service.

## Product Principle

FREQME is not competing with NetEase on recommendations alone.

NetEase already has daily recommendations, playlists, and personalization. FREQME must justify itself by being an agent:

- it remembers the listener beyond one session
- it understands why it is playing a track
- it knows the difference between a deliberate bridge and accidental drift
- it reacts to feedback without overfitting one event
- it can say nothing on purpose
- it can explain itself from real traces
- it can prepare while the user is listening
- it can become more useful as evidence accumulates

The host should not perform intelligence. The system should actually maintain state, call tools, inspect evidence, update memory, and make reversible decisions.

## Architectural References

### Hermes Lessons

Hermes is useful as a service architecture reference:

- one platform-independent agent core
- gateway entry points that route external events into the agent
- tool registry rather than hard-coded workflows
- session persistence as a first-class system
- memory provider and context engine extension points
- background jobs as first-class agent work
- context compression and prompt caching for long-running sessions
- observable, interruptible execution

For FREQME this means the radio agent should sit above the player. Login events, playback events, user messages, idle events, and queue events enter a gateway. The agent core owns reasoning, memory, and decision traces. Playback services become tools.

### Pi Lessons

Pi is useful as an agent runtime reference:

- small core, extensible application shell
- stateful `AgentMessage` history
- `transformContext()` before model calls
- `convertToLlm()` at the LLM boundary
- custom message types for application events
- explicit tool schemas and tool execution events
- steering and follow-up queues
- SDK-style embedding in a Node application

For FREQME this means the agent should model radio events as messages, not as hidden side effects. A track start, skip, host speech, queue low-water event, or memory update can become an agent-visible message. The context transform can compress these into stable radio state before the LLM sees them.

## Current Diagnosis

The existing radio system has useful components but the wrong center of gravity.

It currently behaves like a pipeline:

```text
IntentRouter
  -> StationContractManager
  -> EpisodePlanner
  -> BoundaryGuard
  -> SearchVerifyAgent
  -> QueueWarmer
  -> HostNarrationLayer
  -> Playback and TTS
```

That pipeline can be improved, but it is still code-driven. The agent is not a persistent subject. The system can classify, plan, warm a queue, and speak, but it does not consistently maintain a long-term self model of:

- what the listener is like
- what the current show is doing
- what evidence changed its mind
- why the host spoke or stayed silent
- which memories are durable and which are session-only
- how to resume after restart

The new design moves the center from `RadioBrain` to a service-level `RadioAgentRuntime`.

## Scope

This spec covers the first real agent architecture for FREQME.

In scope:

- new long-term radio agent service boundary
- first-login instant playback and background ingestion
- full-library data ingestion workflow
- taste distillation workflow
- current-context inference workflow
- memory model
- agent event protocol
- tool registry
- host decision policy
- background idle work
- migration from the legacy radio brain
- future extension path
- test strategy

Out of scope for the first implementation:

- perfect music style ontology
- perfect user mood prediction
- large-scale autonomous multi-agent orchestration
- full visual diagnostics dashboard
- removing all legacy playback planning logic
- replacing NetEase integration
- changing the core frontend layout

Those non-goals are not rejected. They are designed as future extensions.

## Target User Experience

### First Login

The listener should not wait for the AI to think.

After login:

```text
1. Start a safe opening track immediately.
2. Show a lightweight status line: "整理你的音乐习惯中" in the UI.
3. Ingest playlists, liked songs, recent plays, and high-frequency plays in the background.
4. Continue playback while the agent builds the first profile.
5. Once the profile reaches minimum confidence, let the agent take over the program.
```

The opening track should come from the most reliable available source:

```text
recent high-frequency playable track
  -> liked or collected track
  -> user's own playlist anchor
  -> recent non-skipped track
  -> existing safe radio fallback
```

The first host line should be short and honest:

```text
先从你常听的方向接住，我在后台整理你的音乐习惯。
```

The host must not pretend that deep personalization is ready before ingestion and distillation have enough evidence.

### After Profile Readiness

When the first taste profile is ready, the station can shift from instant playback into agent-led programming:

```text
1. Build user taste summary.
2. Build current context summary.
3. Create a station contract for the current session.
4. Plan the next 3 to 5 tracks.
5. Prepare host speech only when there is a meaningful reason.
6. Keep warming the queue while listening continues.
```

The listener should feel continuity, not a sudden handoff from one system to another.

### Long-Term Use

Over time, the agent should learn:

- what the user frequently returns to
- which artists, eras, languages, and textures are durable preferences
- which contexts change taste
- which requests are one-off moments
- which negative feedback should stay session-scoped
- when the host should speak less
- which recommendation moves have failed before

Repeated evidence becomes long-term memory. One-off evidence remains local unless the user states it explicitly.

## Top-Level Architecture

```text
Frontend / WebSocket / Playback Events
        |
        v
Radio Gateway
        |
        v
RadioAgentRuntime
  - session messages
  - current station state
  - user profile context
  - current context
  - tool registry
  - steering and follow-up queues
  - event stream
        |
        v
Tools and Workers
  - library census
  - taste distillation
  - context refresh
  - search and verification
  - audio resolution
  - queue control
  - host speech and TTS
  - memory writes
  - decision trace writes
        |
        v
Playback / TTS / SQLite / NetEase / UI
```

## Core Components

### Radio Gateway

The gateway converts external events into agent messages.

Inputs:

- `login_completed`
- `library_scan_requested`
- `playback_started`
- `playback_progress`
- `track_completed`
- `track_skipped`
- `queue_low`
- `user_text`
- `tts_completed`
- `idle_tick`
- `weather_updated`
- `location_updated`
- `session_restored`

Responsibilities:

- route events to the correct user/session
- preserve ordering for playback-critical events
- avoid blocking playback on model calls
- decide whether an event is hot, warm, or cold path
- expose agent events to the frontend

### RadioAgentRuntime

The runtime is the agent core.

Responsibilities:

- own the agent transcript
- transform radio events into compact context
- expose tools to the model
- run the orchestration loop
- accept steering messages from user input
- queue follow-up background tasks
- emit observable events
- stop gracefully when budget or state requires it
- persist session state and traces

The runtime should support three execution paths:

```text
hot path: immediate response, user-facing or playback-critical
warm path: queue preparation while playback continues
cold path: background memory, distillation, reflection, and cleanup
```

### Music Data Ingestion

The ingestion layer collects raw evidence without interpreting it too deeply.

Data sources:

- all user playlists
- playlist titles and descriptions
- all playlist tracks
- liked or collected tracks
- recent play records
- high-frequency play records when available
- current account identity
- local playback logs from FREQME
- explicit user requests in FREQME
- skip and replay behavior in FREQME

The ingestion layer should keep raw data separate from AI summaries.

### Taste Distillation Engine

The distillation engine turns raw music evidence into durable and usable taste memory.

It must not send thousands of raw tracks into one model call. It should run in layers:

```text
local statistics
  -> playlist-level summaries
  -> cluster-level summaries
  -> user-level taste synthesis
  -> markdown profile for agent context
```

Outputs:

- `taste_facts`
- `taste_hypotheses`
- `taste_confidence`
- `taste_profile_markdown`
- `profile_version`
- `evidence_refs`

The model should distinguish facts from hypotheses.

Example fact:

```text
The listener has repeated evidence for late-night R&B and soft vocal music.
```

Example hypothesis:

```text
The listener may prefer lower-energy music at night, but confidence is medium because time-specific evidence is still sparse.
```

### Context Engine

The context engine creates the current listening context.

Inputs:

- local time
- timezone
- location hint
- weather snapshot
- current track
- recent tracks
- recent skips
- active request
- user inactivity duration
- queue state
- host speech density
- profile confidence

Outputs:

- `station_now`
- `listener_state_hypothesis`
- `context_confidence`
- `speech_density_hint`
- `energy_hint`
- `risk_flags`

The system should never claim certainty about mood. It should reason from evidence and keep a confidence level.

### Program Director Agent

The program director decides the radio program.

Responsibilities:

- establish or update the active station contract
- decide whether to preserve, bridge, or change direction
- choose the next episode arc
- request candidate search
- inspect boundary decisions
- decide whether the queue is good enough
- explain the current track when asked
- recover from drift

The program director is the main orchestrator. Specialist workers can help, but this component owns final radio decisions.

### Host Agent

The host agent decides whether to speak and what to say.

Host decisions are explicit:

```text
should_speak: true | false
event: station_open | request_ack | bridge_entered | return_to_contract | explanation | correction | recovery | silent
reason: listener-facing or internal trace reason
text: host text when spoken
tts_required: true | false
```

Silence is a first-class decision. If the host does not speak, the trace should say why:

- no meaningful transition
- too soon after last host line
- user is likely in low-interruption listening
- current track already speaks for the program
- TTS budget exhausted
- background planning still uncertain

### Memory System

The memory system has separate stores for raw data, structured facts, hypotheses, markdown summaries, and event history.

Recommended stores:

```text
raw_music_library
taste_facts
taste_hypotheses
profile_summaries
station_context_summaries
episodic_memory
feedback_ledger
decision_traces
agent_sessions
```

Each long-term memory item should carry:

```text
id
kind
value
evidence_count
evidence_refs
confidence
created_at
updated_at
last_seen_at
decay_policy
source
```

### Tool Registry

Tools should be explicit, typed, and observable.

Initial tool set:

- `get_opening_track`
- `scan_user_library`
- `read_user_profile`
- `write_user_profile`
- `read_station_context`
- `write_station_context`
- `distill_playlist`
- `distill_user_taste`
- `infer_now_context`
- `plan_program`
- `search_music`
- `verify_track`
- `resolve_audio`
- `queue_track`
- `evaluate_boundary`
- `write_decision_trace`
- `explain_current_track`
- `write_feedback_memory`
- `generate_host_line`
- `synthesize_tts`

The first implementation can keep many of these as local services rather than LLM-callable tools. The architecture should still model them as tools so they can later be exposed to the agent or replaced by smarter implementations.

## Memory Artifacts

Markdown context files are useful, but they must not be the only source of truth.

### `user_profile.md`

Agent-readable profile summary.

Contents:

- stable taste anchors
- repeated artists or styles
- language and vocality preferences
- energy tendencies
- discovery tolerance
- disliked or risky areas
- explicit user instructions
- confidence notes
- recently changed assumptions

Generated from structured memory.

### `station_now.md`

Current session state.

Contents:

- local time and time block
- weather and location hint
- current program direction
- current track
- recent tracks
- recent skips or corrections
- queue confidence
- host speech density
- likely listener state with confidence

Generated from the context engine and playback state.

### `program_contract.md`

The active radio contract.

Contents:

- main direction
- allowed adjacent directions
- bridge budget
- disallowed directions
- return requirement
- host style
- reason this contract exists
- what would cause it to change

Generated by the program director.

## First-Run Flow

```text
login_completed
  -> restore existing user profile if present
  -> get_opening_track
  -> queue and play opening track
  -> show lightweight "organizing your music habits" status
  -> start library census in background
  -> run local statistics
  -> run playlist-level distillation
  -> run user-level distillation
  -> write user_profile.md
  -> infer station_now.md
  -> create initial program_contract.md
  -> plan first agent-led episode
  -> warm queue
  -> agent takes over active programming
```

Opening playback must not wait for:

- full playlist scan
- LLM distillation
- weather fetch
- profile synthesis
- host TTS

The station should become more personalized as these become available.

## Background Work Strategy

The system should use listening gaps intelligently.

### Hot Path

Must be fast and user-visible.

Examples:

- user asks for a song or direction
- user asks why this song is playing
- user skips
- queue is about to run out
- current track cannot play

### Warm Path

Can run while music continues.

Examples:

- prepare next 2 to 3 candidates
- generate host line for an upcoming bridge
- verify backup candidates
- update station context

### Cold Path

Runs during idle time or low pressure.

Examples:

- full library ingestion
- playlist summary refresh
- long-term memory distillation
- session reflection
- failure review
- pruning stale hypotheses
- refreshing markdown summaries

This is the main difference between an agent and a playlist player. The system should work while the listener is listening.

## Decision Trace

Every track queued by the agent must have an explainable trace.

Trace fields:

```text
trace_id
session_id
track
source
candidate_queries
rejected_candidates
profile_evidence
now_context
station_contract
boundary_decision
host_decision
tool_calls
latency
fallback_level
created_at
```

The answer to "why this song?" must be generated from this trace, not improvised from the final track metadata alone.

## Learning Policy

The agent must not overfit.

Rules:

- one skip creates session evidence, not permanent dislike
- repeated skips with shared features create a hypothesis
- explicit user correction is stronger than passive skip behavior
- repeated explicit corrections can become long-term memory
- long-term memory must keep evidence references
- stale hypotheses decay
- user correction can revoke or weaken memory

Example:

```text
Event: user skips one classical piano track
Memory effect: session-level caution only

Event: user says "do not play this classical direction"
Memory effect: session contract disallows classical direction

Event: user repeatedly rejects classical bridges across sessions
Memory effect: long-term hypothesis that classical bridges are risky
```

## Host Policy

The host should behave like a private radio DJ, not a chat companion.

Speak for:

- first station handoff
- direct user request acknowledgement
- deliberate bridge
- return to contract
- correction after obvious drift
- recovery from playback/search failure
- explanation request

Stay silent for:

- ordinary on-contract continuation
- too many recent host lines
- low-interruption context
- uncertain internal planning
- TTS failure when text would be distracting

The host line should never expose internal terms such as:

- JSON
- profile score
- model
- candidate
- trace
- boundary guard
- fallback level
- vector
- prompt

## Migration Plan

The new service should not immediately replace the entire old system.

### Phase 1: Shadow Mode

The new agent runs beside the existing radio pipeline.

It observes:

- current track
- queued track
- user input
- skips
- host text
- traces

It produces:

- what it would have played
- what it would have said
- what it thinks the active contract is
- how it would update memory

No playback control yet.

### Phase 2: Assisted Mode

The new agent controls:

- first-run profile building
- current context summary
- explanations
- host speech decisions
- some queue suggestions

The old system remains playback fallback.

### Phase 3: Active Mode

The new agent controls:

- program planning
- queue preparation
- boundary and bridge policy
- host policy
- memory writes

The old `RadioBrain` becomes fallback only.

### Phase 4: Legacy Removal

Remove old planning code only after:

- live traces show the new agent is more coherent
- tests cover startup, feedback, drift, memory, and recovery
- playback fallback remains reliable

## Future Extension Path

The first version intentionally leaves room for harder future capabilities.

### Music Style Understanding

Add a replaceable `MusicUnderstandingLayer`:

- local metadata rules
- library-derived style clusters
- external metadata providers
- LLM music judge
- evaluation set for style distance

The agent should call this layer instead of embedding style logic directly.

### Listener State Prediction

Use `listener_state_hypothesis`, not absolute mood claims.

Future inputs:

- time patterns
- weather
- recent acceptance and skips
- repeated requests
- user input tone
- session duration
- pause and replay behavior

Each hypothesis must include evidence, confidence, and expiration.

### Multi-Agent Expansion

Start with one orchestrator and specialist tools/workers.

Future agents can be added behind the same event and tool protocols:

- Program Director Agent
- Taste Analyst Agent
- Musicologist Agent
- Host Persona Agent
- Boundary Agent
- Memory Curator Agent

No specialist agent should directly control playback without the orchestrator.

### Diagnostics Dashboard

Do not build a large dashboard first. Persist the data first.

Future dashboard views:

- Agent timeline
- Memory explorer
- Candidate ranking
- Drift map
- host speech log
- taste profile evolution
- tool latency and failures

### Legacy Playback Rewrite

The old playback logic can be retired only after the new agent proves itself in shadow and active modes.

## Error Handling

The agent must degrade gracefully.

- If profile loading fails, start from recent playable tracks and rebuild profile in the background.
- If full library scan fails, keep partial evidence and retry during cold path.
- If distillation fails, keep local statistics and mark profile confidence low.
- If weather is unavailable, use time and session behavior only.
- If search fails, use known playable anchors.
- If TTS fails, show text only when helpful, otherwise stay silent.
- If the agent runtime fails, fall back to legacy radio playback.
- If memory writes fail, continue playback and retry later.

## Testing Strategy

Add tests for the agent service before replacing playback behavior.

Core tests:

- first login starts playback without waiting for distillation
- all playlists are scheduled for ingestion
- local statistics run before LLM distillation
- playlist distillation writes evidence references
- user-level profile distinguishes facts from hypotheses
- `user_profile.md` is regenerated from structured memory
- `station_now.md` includes time, weather, playback, and session state
- one skip does not create a permanent dislike
- repeated explicit correction can create long-term memory
- restart restores user profile and recent station state
- host silence is recorded as a decision
- "why this song?" uses a decision trace
- shadow mode does not control playback
- active mode can queue a track through tools
- TTS failure does not block playback
- low profile confidence uses conservative playback

Smoke checklist:

- log in with an account that has playlists
- first track starts quickly
- UI shows lightweight profile-building status
- library scan starts in background
- profile summary is created
- agent plans the next episode from profile plus current context
- user skips a track
- skip affects session state but not permanent memory
- user asks why the current track is playing
- response references real trace information
- restart app
- profile and recent station context are restored

## Success Criteria

The first version succeeds when:

- the listener can hear music quickly after login
- profile building happens in the background
- all user playlists are considered, not just a small subset
- the agent produces a durable profile summary
- the agent can explain a track from real trace data
- user feedback changes future behavior without overfitting
- restart does not erase user understanding
- host speech feels intentional
- the old player remains available as fallback

The product is not successful merely because it calls a stronger model. It is successful when the system behaves like an agent with memory, context, tools, and accountable decisions.
