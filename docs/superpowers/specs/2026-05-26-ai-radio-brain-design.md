# AI Radio Brain Design

## Goal

Upgrade the radio from a search-driven player into a private AI radio brain that silently uses the user's taste profile, listening history, current context, and live feedback to choose music and decide what to say.

The user should not feel like they are configuring rules. They open the app, listen, say natural things like "别放这种中文歌了", and the station immediately adjusts.

## Product Principle

Search is a tool, not the brain.

The radio must first understand:

- who this user is musically
- what the current session has been doing
- what the user just accepted or rejected
- what time, region, and situation suggest
- whether the next action is a specific song request, a direction change, a correction, or a simple skip

Only after that should it search, pick, or speak.

## Architecture

Add an `AI Radio Brain` layer above the existing scheduler and song search agent.

Core units:

- `TasteDistiller`: turns the existing profile into an executable taste model.
- `SessionTasteState`: remembers short-lived session constraints such as "avoid Chinese songs for the next few tracks".
- `ContextEngine`: summarizes time, region, and weather-like hints from user settings.
- `ListeningAgent`: interprets natural user input into structured actions.
- `CandidatePlanner`: chooses candidate sources in the right order.
- `PersonalizedRanker`: filters and scores candidates against taste, context, and session constraints.
- `DJVoicePolicy`: generates quiet acknowledgements that explain what changed without making the user manage settings.

The existing `SongRequestAgent` remains useful only for `specific_song` requests. It should no longer receive every user utterance.

## Executable Taste Model

The profile currently contains useful material such as `music_dna`, `radio_insights`, `anchor_tracks`, and `recent_tracks`. The new distillation layer turns that into fields the scheduler can act on:

- preferred languages
- avoided languages
- preferred styles
- avoided styles
- comfort tracks
- discovery tracks
- energy preference
- voice or instrument preference
- anti-mainstream hints
- confidence level

The first version is deterministic and uses the profile already saved in SQLite. Later versions can refresh this model with the LLM in the background.

## User Input Handling

Every text input first becomes a structured listening decision:

- `specific_song`: the user asked for a song, album, artist version, or known work.
- `taste_direction`: the user describes a feeling or style.
- `negative_feedback`: the user rejects the current direction.
- `skip_variant`: the user wants another song while preserving part of the direction.
- `profile_correction`: the user states a durable preference.
- `clarify_needed`: only when acting would be more annoying than asking.

Example:

```json
{
  "intent_type": "negative_feedback",
  "raw_text": "能不能不要放这些中文歌了",
  "avoid_languages": ["中文"],
  "avoid_styles": ["华语流行", "热门流行", "口水歌"],
  "candidate_strategy": "profile_first",
  "allow_search": false,
  "duration_tracks": 5,
  "ack_text": "懂了，这批中文流行先避开。我从你的歌单和最近听感里往非中文、没那么口水的方向接。"
}
```

## Candidate Strategy

Candidate sources are ordered by intent.

For feedback and taste directions:

1. user playlist anchors and recent tracks
2. liked or familiar tracks available in the profile
3. current-song similarity, filtered by the rejected direction
4. daily recommendations and Personal FM
5. NetEase search only when the agent explicitly needs expansion
6. fallback playlist only after applying constraints

For specific song requests:

1. `SongRequestAgent` interprets title, aliases, work names, versions, and artists.
2. If it fails, the system does not fall back to raw mood search.
3. The user gets a clear miss message instead of a wrong song.

## Silent Learning

The radio should update short-term state immediately:

- skipped song: reduce confidence in the current source or style
- negative feedback: add session constraints for the next few tracks
- repeated negative feedback: store as a profile correction candidate
- successful direct request: record it as a strong taste signal

Long-term profile changes should be silent and conservative. One complaint changes the session; repeated complaints change the profile.

## Context Awareness

The current code already passes timezone and region hints. The brain should turn those into a small context object:

- local time block: morning, afternoon, evening, late night
- region hint
- weather hint when available from settings
- activity mode such as work, commute, sleep, coding, companion

Context affects energy, speech density, and candidate scoring. Example: late-night rainy context lowers energy, favors restrained vocals or instrumental tracks, and makes the DJ speak less.

## Acceptance Criteria

- "能不能不要放这些中文歌了" is never sent to the specific-song search agent.
- The same phrase creates a short-term avoid-Chinese / avoid-mainstream-Chinese constraint.
- The next candidate is chosen from the user's profile before NetEase search.
- If profile candidates exist that satisfy the constraint, search is not called.
- Specific requests such as "我想听李云迪的普2" still go through the precise song agent.
- The DJ acknowledgement names the understood preference change, not a random matched song title.
- Existing playback queue behavior remains intact.

## First Implementation Slice

Build the minimal reliable brain:

- deterministic taste distillation from the existing profile
- deterministic natural-language guards for obvious feedback and specific requests
- scheduler constraints and profile-first candidate selection
- WebSocket routing through `ListeningAgent`
- tests for the failure case that triggered this work

Later slices can add background LLM refresh, weather API integration, and richer long-term learning.
