# Playback Backend Upgrade Design

## Goal

Upgrade the current AI radio backend by absorbing the useful backend ideas from Claudio while keeping this project lightweight. The priority is playback stability, playback continuity, and a stronger AI radio feel. Frontend visual redesign is out of scope.

## Product Direction

The product should feel like a private radio station that keeps music flowing, recovers from bad song URLs by itself, and speaks only when it adds atmosphere or context. The DJ should not dominate the listening experience.

Onboarding is reduced to one choice: voice style.

- `silver_female`: a knowing, magnetic female voice with a mature late-night radio tone.
- `warm_male`: a gentle, magnetic male radio host voice with a calm and close delivery.

## Architecture

Keep the current FastAPI backend, NetEase bridge, SQLite memory store, scheduler, DJ engine, and WebSocket flow. Add three backend capabilities:

1. Audio resolution and proxying.
2. A lightweight server-side playback queue.
3. Prewarming for the next few playable items.

The frontend can continue using the current WebSocket protocol with small message additions only when needed.

## Playback Stability

Add a backend audio resolver that returns playable local proxy URLs instead of exposing raw NetEase URLs to the frontend.

Resolution order:

1. Try NetEase `song_url`.
2. Try NetEase outer media URL.
3. Try same-title search candidates when metadata is available.
4. Mark the item failed and ask the queue for another song.

The resolver should record failures with a reason such as `empty_url`, `http_error`, `timeout`, or `unplayable_candidate`. These failures become recommendation signals so the scheduler avoids repeating broken items.

Add an audio proxy endpoint, for example:

`GET /api/radio/audio/{song_id}`

The endpoint should:

- Resolve the best upstream URL.
- Stream audio with correct content type when possible.
- Set cache-friendly headers for successful responses.
- Return clear non-200 errors when audio cannot be resolved.

## Playback Continuity

Add a server-side playback queue with a small horizon. Default prewarm depth: 3 songs.

Queue item states:

- `pending`
- `prewarming`
- `ready`
- `playing`
- `played`
- `skipped`
- `failed`

Each item stores:

- song id
- title
- artist
- source
- selection reason
- resolved proxy URL or resolver status
- optional segue text and TTS hash

When a session starts, the backend should prepare the intro, current song, and at least the next two songs. When the current song starts playing, the backend continues filling the queue back to the prewarm depth.

When the frontend sends `track_ended` or `skip`, the backend should promote an already-ready item where possible. If no item is ready, it may fall back to immediate resolution, but that path should be treated as degraded mode.

## AI Radio Feel

The DJ should speak with restraint.

Default cadence:

- Always generate one short intro at session start.
- Generate a short segue every 1-2 songs, not necessarily before every track.
- Skip DJ speech if TTS is slow or fails.

Segues should explain musical continuity, not generic praise. Examples:

- "The last track left a soft low-end glow, so I am pulling the room a little warmer."
- "This one keeps the pulse steady, but opens the vocals up a bit."

The scheduler should pass the next song's selection reason into the DJ engine so the spoken line reflects why that song is coming next.

## Taste Distillation

Do not start with full model distillation. Start with product-level taste distillation.

Create or extend a compact user taste summary from:

- onboarding voice choice
- user playlists
- recent listens
- liked tracks
- skips
- failed tracks
- session history

The first version can remain rule-based and stored in SQLite as JSON. It should help decide:

- familiar anchor ratio
- discovery ratio
- repeated artist cooldown
- broken song avoidance
- scene-specific energy

The large model remains useful for profile generation, intro, and high-value segues.

## Data Model

Add or extend SQLite tables for:

- playback queue
- playback events
- audio resolution cache
- failed track records

Keep migrations simple and backward-compatible.

## Testing

Add tests for:

- resolver fallback order
- broken URL avoiding replay
- queue prewarm depth
- ready item promotion on track end
- skip marking previous item skipped
- onboarding voice choices limited to two presets
- DJ cadence not generating speech for every song

## Acceptance Criteria

- A session can start with a current song plus two prepared next songs.
- A failed song URL automatically falls through to another candidate without killing the radio session.
- `track_ended` usually returns the next track without waiting for new LLM or profile work.
- TTS failure does not block song playback.
- Onboarding shows only the two voice choices and saves one preset.
- Existing Python and Node tests pass.
