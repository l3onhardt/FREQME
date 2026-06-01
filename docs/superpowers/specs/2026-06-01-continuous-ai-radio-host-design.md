# Continuous AI Radio Host Design

## Goal

Turn FREQME from an AI-assisted player into a continuously reasoning AI radio host.

The host should feel like it has memory, context, taste, timing, and judgement. It should not wait for the listener to type before doing AI work. After the listener opens the station, music starts quickly, while the AI works in the background to plan, verify, cache, explain, and revise the next part of the show.

## Product Shape

The product should behave like a private radio host, not a recommendation list.

- On startup, it starts with one safe bridge track quickly.
- In the background, it infers the user's current situation and plans the next 3 to 5 tracks.
- It keeps a warm buffer of verified playable tracks.
- It can explain why a song is playing without treating the question as a new song request.
- It reacts immediately to feedback such as "不是这种", "别太 emo", or "不要人声".
- It learns session preferences immediately, but only promotes long-term preferences after repeated evidence.

The listener should feel that the host is actively running the station even when they say nothing.

## Current Baseline

The current TypeScript backend already has useful pieces:

- `ProfileEngine` fetches NetEase playlists, recent plays, liked IDs, and produces a profile.
- `AIStationDirector` can create multi-track station plans from profile, time, location, weather, memory, and feedback.
- `SearchVerifyAgent` expands abstract music tasks into concrete NetEase candidates and verifies playable songs.
- `DJMemoryManager` records session memory and user memory events.
- The old scheduler is still available as degraded fallback.

The observed gap is product intelligence, not basic runtime health. Live testing showed:

- "别太 emo" can still become a positive emo direction.
- "为什么给我放这首" is handled as a music request instead of explanation.
- Correction can take too long before the rejected song stops mattering.
- Autoplay still hits degraded fallback too often.
- Profile distillation may be shallow while the station behaves as if it fully understands the user.

## Architecture

Add a `RadioBrain` orchestration layer above the current station director, request agent, verifier, queue, profile, and memory modules.

Core units:

- `IntentRouter`: classifies user text as music direction, correction, negative feedback, explanation question, preference update, continuation, or small talk.
- `EpisodePlanner`: plans a 3 to 5 track station episode with an emotional arc, concrete candidate queries, reasons, negative constraints, and backups.
- `QueueWarmer`: verifies and resolves candidates in the background so the visible player always has ready tracks.
- `ReflectionLoop`: evaluates each track outcome and updates session memory, active constraints, and long-term preference candidates.
- `DecisionTraceStore`: records why each track was chosen, what profile/context was used, what candidates were rejected, latency, and whether fallback was used.
- `HostResponder`: produces short host speech for acknowledgements, explanations, corrections, and transitions.

`AIStationDirector` should become the deep planning engine used by `RadioBrain`, not the only owner of all runtime decisions. The old scheduler remains only as a last-resort continuity fallback.

## Runtime Lifecycle

### Startup

1. Browser opens the radio and sends handshake with local time, region, and optional geo.
2. Backend loads or starts refreshing the user profile.
3. The station immediately plays one bridge track:
   - Prefer a recently verified playable track that fits current constraints.
   - Otherwise use a strong profile anchor.
   - Avoid any track skipped or rejected in the current session.
4. In parallel, `RadioBrain` starts the first `EpisodePlanner` job.
5. `QueueWarmer` verifies and resolves the first episode candidates into a ready queue.

Startup should not wait for deep inference before music begins.

### Background Planning

The brain continuously maintains two queues:

- `readyQueue`: verified playable tracks with audio URLs.
- `candidateEpisode`: AI-planned tracks not yet fully verified.

Planning triggers:

- Immediately after startup.
- Whenever `readyQueue` drops below 2 tracks.
- When a track starts, to prepare beyond the current buffer.
- When the active episode reaches its final 1 to 2 tracks.
- When user feedback invalidates the current direction.
- When profile, time block, location, weather, or session intent changes meaningfully.

The health loop runs every 20 to 30 seconds, but it only schedules work when the queue or context requires it.

### Playback

Playback should be driven by the ready queue. A track can start only after:

- It is verified against the active episode.
- It has a resolved audio URL.
- It does not violate current session constraints.
- Its decision trace is stored.

If the next AI-planned item fails verification, the queue warmer should try the item's backup candidates before falling back to the old scheduler.

## Intent Handling

The first step for every user utterance is intent classification, not song search.

Intent types:

- `music_direction_request`: "来点晚上 emo 的歌", "我想听适合写代码的".
- `specific_track_request`: "放 Nils Frahm Says".
- `correction`: "不是这种", "太电了", "换一个更安静的".
- `negative_feedback`: "不要 edm", "别太 emo", "不要人声".
- `explanation_question`: "为什么给我放这首", "这首哪里适合我".
- `preference_update`: "我其实不太喜欢中文口水歌".
- `continuation`: "继续这个感觉".
- `small_talk`: host conversation that should not change playback by default.

Rules:

- Negated styles are constraints, never positive direction seeds.
- Explanation questions must read the current decision trace and answer. They must not replan unless the user also gives feedback.
- Corrections clear incompatible queued tracks immediately.
- Specific track requests can interrupt the episode, but after the track the brain should decide whether to return to the previous episode or create a new one.

## Episode Model

An episode is a short AI-owned radio window.

Fields:

- `id`
- `brief`
- `modeLabel`
- `arc`: short description of the 3 to 5 track progression.
- `durationTracks`
- `positiveConstraints`
- `negativeConstraints`
- `items`
- `fallbackPolicy`
- `hostNotes`
- `createdFrom`: startup, autoplay, user request, correction, reflection, context change.

Each item contains:

- `primaryQuery`
- `backupQueries`
- `reason`
- `style`
- `energy`
- `vocality`
- `fitToProfile`
- `fitToContext`
- `avoidBecause`

The planner must produce concrete candidate queries whenever possible. Bare style buckets are allowed only as intermediate planning data and must be expanded before verification.

## Memory And Profile

Memory has three levels:

- `ProfileMemory`: durable taste distilled from playlists, recent plays, liked tracks, onboarding notes, and repeated feedback.
- `SessionMemory`: current mood, constraints, corrections, skips, active episode, and temporary dislikes.
- `DecisionTrace`: per-track evidence used for explanation and debugging.

Profile quality must be explicit. If genres, language preference, vocal preference, or taste summary are shallow, the brain should mark the profile as `low_confidence` and rely more on live feedback, recent tracks, and safe exploration. It should not behave as if a shallow profile is a finished user model.

Long-term preference updates require repeated evidence. One skip affects the current session. Multiple similar skips or explicit durable statements can become profile update candidates.

## Latency Strategy

The design accepts deeper AI reasoning only because the user-facing path is decoupled from it.

Targets:

- Startup bridge track: 1 to 3 seconds after handshake when cached playable options exist.
- Fast user acknowledgement: under 2 seconds.
- Correction action: clear incompatible queue immediately and stop, duck, or replace the rejected direction.
- New corrected ready track: usually within 15 seconds.
- Background episode planning: 8 to 12 seconds budget.
- Queue health check: every 20 to 30 seconds.
- Minimum ready buffer: 2 tracks.
- Planned episode size: 3 to 5 tracks.

Optimization tactics:

- Plan multiple tracks in one LLM call.
- Verify candidates in parallel.
- Give each planned item backup queries.
- Resolve audio URLs before the track is needed.
- Reuse the last credible episode if a new deep plan times out.
- Cache successful decision traces and playable URLs.

## Interruption Policy

User intent always has priority over background planning.

For correction or negative feedback:

1. Stop using the current episode if it conflicts.
2. Clear incompatible queued tracks.
3. Send a fast host acknowledgement.
4. Insert a safe bridge or corrected first track.
5. Start a new episode planning job with the new constraints.

For explanation questions:

1. Do not clear the queue.
2. Read the current track's decision trace.
3. Explain profile/context/episode fit in natural host language.
4. Ask a light follow-up only if the user sounds dissatisfied.

For specific track requests:

1. Verify and play the requested track if possible.
2. Store it as a strong session signal.
3. Decide whether the next episode should continue from that track or return to the previous direction.

## Fallback Policy

Fallback should preserve intelligence instead of feeling random.

Fallback order:

1. Current episode backup queries.
2. Last credible episode item not yet played.
3. Profile anchor that satisfies active constraints.
4. Recently verified playable track that satisfies active constraints.
5. Old scheduler continuity fallback.

Every fallback must write a decision trace. If old scheduler fallback is used, the trace should say why AI planning failed and what guardrails were still applied.

## Frontend Feedback

The UI should expose state without showing internal machinery.

Suggested statuses:

- "正在理解你的意思"
- "正在重排接下来的几首"
- "下一首准备好了"
- "我先避开这个方向"
- "这首是因为..."

The frontend should not show prompts, model names, JSON, or raw system terms. It should make the host feel alive, not technical.

## Observability

Add structured traces for every important decision:

- intent type and confidence
- active profile quality
- context snapshot
- episode id
- selected track and reason
- rejected candidates
- verification attempts
- audio resolution result
- latency per phase
- fallback level
- user-visible host response

These traces support both user-facing explanations and developer debugging.

## Testing

Unit tests:

- "别太 emo" becomes a negative constraint, not an emo direction.
- "不要人声" filters vocal candidates.
- "为什么给我放这首" returns an explanation intent and does not create a new plan.
- A shallow profile is marked low confidence.
- Episode planner outputs 3 to 5 usable items with backups.

Integration tests:

- Startup sends a bridge track before deep planning finishes.
- Queue warmer keeps at least 2 ready tracks after the first episode.
- Correction clears incompatible queue items.
- Skip/reflection updates session memory without creating permanent dislike immediately.
- Old scheduler fallback is rare and traceable.

Live smoke tests:

- Open logged-in NetEase account and start radio.
- Ask for quiet focus music with "别太 emo, 不要 edm/dubstep".
- Ask "为什么给我放这首".
- Correct with "不是这种, 我要没有人声".
- Let two next tracks play and confirm the direction persists.

## Acceptance Criteria

- The station starts quickly and begins deep planning in the background.
- AI owns the next 3 to 5 track episode, not just the current request.
- The ready queue is usually AI-planned and verified before playback.
- User explanation questions do not trigger accidental replans.
- Negated styles are never treated as requested styles.
- Session memory affects the next tracks immediately.
- Long-term memory changes only after repeated or explicit evidence.
- Degraded scheduler fallback is measured and visibly reduced.
- Every played track has a decision trace that can answer "why this song".

## Implementation Slices

1. `IntentRouter` and explanation path.
2. `DecisionTraceStore` and trace-backed host explanations.
3. `EpisodePlanner` model and AI episode planning.
4. `QueueWarmer` background planning and ready-buffer health loop.
5. Interruption policy for correction, negative feedback, and specific requests.
6. `ReflectionLoop` for session memory and conservative long-term learning.
7. Frontend status messages for planning, correction, explanation, and ready state.
8. Live smoke script or checklist for the real NetEase login path.

The first implementation slice should avoid a large visual redesign. The priority is the radio brain and playback intelligence.
