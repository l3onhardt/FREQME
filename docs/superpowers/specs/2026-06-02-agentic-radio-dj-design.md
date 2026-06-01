# Agentic Radio DJ Design

**Date:** 2026-06-02
**Status:** Draft for user review
**Branch:** `codex/typescript-backend-rewrite`

## Goal

Turn FREQME from a continuous AI-assisted music player into an agentic private radio DJ.

The product should not merely recommend or queue songs. It should behave like an agent with an active objective, working memory, musical boundaries, self-checks, and a host voice that explains meaningful decisions. The user should feel that the station is being run by a DJ who understands the current program, maintains continuity, notices drift, corrects course, and speaks at the right moments.

## Current Diagnosis

The latest continuous radio brain is operational: it can classify user text, plan episodes, verify candidates, warm the queue, record decision traces, and keep playback moving. Live testing of a request such as "play late-night R&B" showed the agentic backend chain working.

The product gap is not basic runtime health. The gap is agent discipline and host presence.

Observed behavior:

- A direction request such as "play late-night R&B" can be classified as `specific_track_request` because it starts with a direct play verb.
- Follow-up continuation planning inherits the current track too strongly and does not preserve the original user direction as a hard station objective.
- The station can drift from late-night R&B into piano ambient, electronic ambient, and even classical chamber music.
- Some drift is musically acceptable as a radio bridge, but the system does not know when it is bridging, when it is off-contract, or when it must return.
- Decision traces contain host text, but RadioBrain-prepared queue items do not reliably create `segueText` and TTS. The DJ brain works in the background while the foreground host often stays silent.
- The visible DJ copy can be too long and too internal, including product/debug language such as profile reasoning rather than human radio speech.

## Product Principle

FREQME should be an agentic radio host, not a chatty assistant.

The DJ should speak less often than a voice companion, but every time it speaks it should have a reason:

- open the station
- acknowledge a user direction
- explain a meaningful transition
- mark a deliberate bridge
- correct drift
- answer "why this song?"
- recover from search or playback uncertainty

The station may make tasteful transitions across adjacent styles, but it must know the difference between a deliberate bridge and uncontrolled drift.

## Target UX

When the user asks for "late-night R&B", FREQME should establish a station contract:

```text
main_direction: late-night R&B
allowed_adjacent: alt-R&B, neo-soul, soft vocal, downtempo, R&B-adjacent electronic
soft_bridge: ambient electronic, piano ambient
disallowed: classical chamber music, pure classical piano, high-energy EDM, unrelated playlists, utility audio
drift_budget: at most one bridge track before returning toward the main direction
host_style: standard DJ presence; speak briefly at important moments
```

After that, the agent can still use a Nils Frahm or Jon Hopkins track as a bridge if it improves the show. It should not silently let the station become a classical or ambient station unless the user confirms that direction.

Example host behavior:

- User request: "Got it. I will keep this in the late-night R&B lane, soft and low-lit."
- Bridge: "I am taking one instrumental bridge here, then I will pull the vocal R&B texture back in."
- Correction: "That one leaned too classical. I am bringing the station back toward the R&B brief."
- Explanation: "This one is here because it keeps the low tempo and night tone, but gives the last track a little more space."

## Architecture

Add four explicit layers around the existing RadioBrain.

```text
User message
  -> IntentRouter
  -> StationContractManager
  -> EpisodePlanner
  -> BoundaryGuard
  -> SearchVerifyAgent
  -> QueueWarmer
  -> HostNarrationLayer
  -> WebSocket playback and TTS
  -> ReflectionLoop and memory
```

### StationContractManager

Owns the active station objective for a session.

Responsibilities:

- Convert user-facing directions into a structured station contract.
- Preserve the user's original direction across continuation planning.
- Track the current drift state: `on_contract`, `adjacent`, `bridge`, or `off_contract`.
- Maintain a drift budget and return requirement.
- Merge corrections, negative feedback, and preference updates into the active contract.
- Store contract state in session memory so reconnects and background planning keep the same objective.

It should not search music, resolve audio, generate TTS, or rank NetEase candidates.

### BoundaryGuard

Checks candidate songs against the active station contract before they enter the ready queue.

Responsibilities:

- Reject obvious off-contract songs.
- Treat backup query matches as higher risk than primary query matches.
- Detect entity drift such as `Max Richter` intent becoming `Sviatoslav Richter`.
- Detect style drift such as late-night R&B becoming classical chamber music.
- Allow a bridge only when the contract permits it and the drift budget allows it.
- Emit a structured boundary decision with a reason:
  - `accept`
  - `accept_as_adjacent`
  - `accept_as_bridge`
  - `reject_off_contract`
  - `reject_entity_mismatch`
  - `reject_low_confidence`

The guard should be deterministic first and LLM-assisted only when metadata is ambiguous.

### HostNarrationLayer

Turns agent decisions into radio-host speech.

Responsibilities:

- Decide whether the DJ should speak for this event.
- Convert internal reasons into short natural Chinese.
- Generate or reuse TTS.
- Attach `segueText` and `ttsHash` to queue items when a transition needs narration.
- Avoid technical language: no "profile", "algorithm", "model", "candidate", "JSON", "trace", or "search verification".
- Keep speech short:
  - request acknowledgements: 4 to 8 seconds
  - transitions: 6 to 12 seconds
  - explanations: 8 to 15 seconds

It should support these narration events:

- `station_open`
- `request_ack`
- `direction_changed`
- `bridge_entered`
- `return_to_contract`
- `track_explanation`
- `drift_corrected`
- `still_planning`
- `recovery`

### Contract-Aware EpisodePlanner

The planner should receive the active station contract, not only the current intent and current track.

Planning prompt requirements:

- Include the contract as the highest-priority station objective.
- Ask for 3 to 5 items with `contract_fit`, `drift_class`, and `return_plan`.
- Require every bridge item to explain why it helps and how the episode returns.
- Require negative constraints to include contract disallowed styles.
- Avoid treating the current track as a stronger objective than the station contract.

The output should extend `RadioEpisodeItem` with:

```ts
contractFit: "on_contract" | "adjacent" | "bridge" | "off_contract";
returnPlan?: string;
narrationCue?: string;
```

## Data Model

Add a session-scoped `StationContract` type:

```ts
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

Extend decision traces with boundary and narration fields:

```ts
boundaryDecision?: {
  status: "accept" | "accept_as_adjacent" | "accept_as_bridge" | "reject_off_contract" | "reject_entity_mismatch" | "reject_low_confidence";
  reason: string;
  contractId: string;
};
narration?: {
  event: string;
  text: string;
  ttsHash?: string;
  spoken: boolean;
};
```

## Runtime Behavior

### User Direction

1. `IntentRouter` classifies "play some late-night R&B" as `music_direction_request`.
2. `StationContractManager` creates or updates the active contract.
3. `RadioBrain` increments generation, clears conflicting ready items, records the contract, and starts planning.
4. `HostNarrationLayer` sends a short acknowledgement immediately.
5. `EpisodePlanner` plans tracks under the contract.
6. `BoundaryGuard` checks each verified candidate before queue insertion.
7. `QueueWarmer` adds only accepted tracks.
8. The first ready item is promoted quickly when available.

### Continuation

1. When the queue drops below target depth, RadioBrain starts a continuation plan.
2. The continuation intent must include the active station contract.
3. Planner may propose bridges, but must include a return plan.
4. BoundaryGuard updates bridge count and must-return state.
5. HostNarrationLayer narrates bridge entry or return when appropriate.

### Drift Recovery

If the system plays or prepares a track later judged off-contract:

1. Mark the trace as drift.
2. Clear ready items that share the off-contract reason.
3. Generate a short host correction only if the user is likely to notice the shift.
4. Force the next plan to return to the main direction.

### Explanation Question

When the user asks "why this song?", RadioBrain should:

1. Fetch the current track trace.
2. Translate the trace into listener-facing speech.
3. Include contract context when relevant.
4. Never trigger a new search unless the user also asks to change direction.

## Frontend Behavior

Keep the current player layout. Add only a lightweight DJ state surface.

Visible behavior:

- DJ text should show the latest human-facing host line, not long internal planning text.
- During TTS, the music ducks and the spectrum shifts into speaking mode.
- When the agent is bridging, the UI can show a small phrase such as "instrumental bridge" or "returning to late-night R&B".
- If TTS fails, show the text and continue playback.

Developer-only behavior:

- Add a hidden diagnostics toggle or console-friendly endpoint for:
  - active contract
  - latest boundary decision
  - drift state
  - next ready item reason
  - TTS status

## Error Handling

- If contract generation fails, fall back to a conservative contract from local intent seeds.
- If BoundaryGuard rejects every candidate, ask EpisodePlanner for a narrower recovery plan once, then use profile anchors if needed.
- If HostNarrationLayer fails, queue and playback still continue.
- If TTS generation fails, send text-only host narration.
- If LLM budget is exceeded, prefer deterministic contract and guard rules, then fallback provider only for planning or narration that materially affects playback.

## Testing Strategy

Add focused TypeScript tests:

- `IntentRouter` classifies "play some late-night R&B" as a direction request, not a specific track request.
- `StationContractManager` builds a contract with main direction, adjacent styles, disallowed styles, and drift budget.
- `EpisodePlanner` receives and preserves the active contract in continuation plans.
- `BoundaryGuard` rejects classical chamber music for a late-night R&B contract.
- `BoundaryGuard` rejects `Sviatoslav Richter` when the query intends `Max Richter`.
- Bridge budget allows one Nils Frahm or Jon Hopkins style bridge and then requires return.
- `HostNarrationLayer` creates a bridge narration but suppresses unneeded narration for ordinary on-contract continuations.
- Queue items from RadioBrain can carry `segueText` and `ttsHash`.
- TTS failure does not block `play_track`.
- "Why this song?" returns an explanation and does not create a new plan.

Add one smoke checklist update:

- Start station.
- Request late-night R&B.
- Confirm DJ acknowledgement is heard or shown.
- Let 3 to 5 tracks play.
- Confirm at most one bridge occurs before returning.
- Ask why the current song is playing.
- Confirm explanation references the station direction in natural language.

## Rollout Plan

Phase 1: Contract and narration foundations.

- Fix direction intent classification.
- Add `StationContract` and session persistence.
- Pass contract into EpisodePlanner.
- Add HostNarrationLayer for request acknowledgement and continuation bridge narration.

Phase 2: Boundary guard.

- Add deterministic guard rules.
- Integrate guard between verification and queue insertion.
- Add trace fields for boundary decisions.
- Block obvious off-contract and entity-mismatch results.

Phase 3: Product polish and diagnostics.

- Shorten visible DJ copy.
- Add lightweight DJ state display.
- Add diagnostics endpoint or hidden panel.
- Tune TTS cadence and drift thresholds from live listening.

## Success Criteria

- The user can hear or see the DJ at meaningful moments without feeling interrupted.
- A station direction persists across continuation plans.
- The agent can use a tasteful bridge but knows it is a bridge.
- Off-contract songs do not silently enter the queue.
- Decision traces explain both the musical reason and the contract fit.
- The system remains playable when LLM, TTS, or search verification partially fails.

## Non-Goals

- Do not build a full chat companion.
- Do not redesign the entire frontend.
- Do not expose raw prompts, JSON, model names, or internal agent labels to listeners.
- Do not make the station rigidly genre-locked; tasteful bridges remain allowed.
- Do not remove the degraded scheduler fallback until the agent path has stronger live evidence.
