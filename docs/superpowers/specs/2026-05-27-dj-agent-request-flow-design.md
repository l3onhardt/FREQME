# DJ Agent Request Flow Design

**Date:** 2026-05-27  
**Status:** Draft for user review  
**Branch:** `codex/radio-intent-ux`

## Goal

Rebuild the song request path around an AI DJ agent instead of local intent rules. The product is an AI radio host that understands the user, the current listening moment, and musical intent, then plays music the user is likely to want. Search, version checking, playback preparation, and queueing are tools behind the host; they must not decide what the user meant.

The new design replaces the current request path where `RadioBrain`, `SongRequestAgent`, `StreamScheduler`, and WebSocket branches each interpret pieces of the same user sentence. That split has made the system brittle: a request such as "不能放点radiohead的吗" can be treated like a literal search phrase instead of a clear request for Radiohead.

## Product Principles

1. The DJ agent is the only component that interprets user-facing music intent.
2. Most requests should result in immediate playback, not a form-like clarification flow.
3. The system asks only when ambiguity is high and context cannot safely resolve it.
4. A user request can set a multi-track listening mode, not only the next song.
5. Memory stores user taste, session state, and feedback. It does not store music encyclopedia aliases such as "收音机头 = Radiohead".
6. Failures should recover musically. The system must not say it failed to find the user's raw sentence.
7. Prompt context must stay bounded for long sessions.

## Architecture

```text
User message
  -> DJRequestAgent
  -> SearchVerifyAgent
  -> QueueDirector
  -> AudioResolver / NetEase adapter
  -> WebSocket playback and DJ response
```

### DJRequestAgent

The DJ request agent is the conversation boundary between the user and the radio. It receives the user message plus a compact context pack and returns a structured decision.

It owns:

- understanding whether the user is asking for a song, artist, work family, mood, scene, style, correction, rejection, or continuation
- resolving fuzzy musical language through LLM reasoning
- deciding whether to play now, set a direction, revise the current mode, softly confirm, or ask
- writing the DJ acknowledgement or segue
- proposing session and long-term memory updates

It does not own:

- NetEase search
- final version verification
- URL resolution
- low-level queue mechanics

### SearchVerifyAgent

The search verifier turns a structured music task into a verified playable candidate. It does not reinterpret the user as a whole. It can reason about music metadata, versions, performers, composers, albums, and candidate quality, but it works from the DJ agent's task.

It owns:

- generating search queries from `music_task`
- calling NetEase search
- normalizing candidate metadata
- ranking and verifying candidates with LLM assistance
- rejecting playlists, utility audio, wrong artists, wrong performers, covers, and low-confidence versions
- returning verified candidates, fallback candidates, and failure recovery options

### QueueDirector

The queue director turns DJ decisions into playback continuity. It handles current and future queue state, active listening modes, ready queue clearing, prewarm cancellation, and retry/fallback within the user's intended direction.

It owns:

- clearing stale ready items when the user changes direction
- making the first requested song as precise as possible
- continuing an active mode for a bounded number of tracks
- updating remaining mode duration after each play
- choosing recovery paths when search or URL resolution fails
- keeping scheduler behavior subordinate to active DJ modes

### MemoryManager

The memory manager keeps the DJ smart without letting context grow forever. It stores raw events, maintains short structured session memory, retrieves relevant memories, and conservatively updates long-term taste.

It owns:

- event logging
- session working memory
- relevant memory retrieval
- long-term user memory updates
- context-pack assembly
- memory compaction

## DJ Decision JSON

The DJ agent returns JSON like this:

```json
{
  "action": "play_now",
  "understood_intent": "User wants Krystian Zimerman performing or recording Chopin works.",
  "music_task": {
    "type": "artist_work_direction",
    "primary_entities": [
      {"role": "performer", "name": "Krystian Zimerman"},
      {"role": "composer", "name": "Frederic Chopin"}
    ],
    "work_hint": "",
    "style_hint": "classical piano",
    "must_not_search_literal_user_sentence": true,
    "search_goals": [
      "Krystian Zimerman Chopin Ballade",
      "Krystian Zimerman Chopin Piano Concerto",
      "Zimerman Chopin Preludes"
    ]
  },
  "queue_policy": {
    "duration_tracks": 4,
    "continue_direction": true,
    "avoid_repetition": true,
    "followup_strategy": "Continue with Zimerman, Chopin, or adjacent classical piano unless the user changes direction."
  },
  "uncertainty": {
    "level": "medium",
    "reason": "The performer and composer are clear, but no specific work was named.",
    "should_ask_user": false
  },
  "dj_response": {
    "speak_now": "懂了，你要的是齐默尔曼那种干净、克制但很深的肖邦。我先接一版明确的，后面几首也沿着这条钢琴线走。",
    "tone": "warm_confident"
  },
  "memory_update": {
    "session_preference": [
      "Current direction: classical piano, Zimerman / Chopin.",
      "User accepts performer-composer music requests."
    ],
    "possible_long_term_preference": [
      "Interested in high-quality classical performance versions."
    ],
    "negative_constraints": []
  }
}
```

The important fields are:

- `understood_intent`: the internal interpretation, never a raw search query
- `music_task`: the executable task for search and verification
- `queue_policy`: how long this request should shape the radio
- `uncertainty`: whether to play, softly confirm, or ask
- `dj_response`: the human-facing acknowledgement
- `memory_update`: proposed memory changes, reviewed by the memory manager

## Action Types

- `play_now`: play a verified requested song or direction immediately.
- `set_direction_and_play`: set a multi-track listening mode and play the first song.
- `revise_mode_and_play`: update the active mode after correction or negative feedback.
- `soft_confirm_and_play`: state the likely interpretation while continuing playback.
- `ask_clarifying_question`: ask only when ambiguity is high and context cannot resolve it.
- `negative_feedback`: avoid or correct the current song, version, style, or queue direction.
- `continue_current_mode`: continue the current active mode when the user says things like "就这种继续".

## Uncertainty Policy

The default behavior is fast and decisive.

1. If the intent is clear enough, play directly.
2. If ambiguity can be resolved from recent context or user taste, choose the most likely interpretation and softly confirm.
3. If the ambiguity is high and the likely outcomes are very different, ask one short question.

Example:

```text
User: 夜曲
Recent context: Chinese pop
DJ: 我先按周杰伦这首《夜曲》接。如果你说的是肖邦，我马上换。
```

```text
User: 夜曲
Recent context: classical piano
DJ: 我先按肖邦夜曲接一版。你要是说周杰伦那首，我马上换。
```

If there is no useful context:

```text
User: 夜曲
DJ: 你说的是周杰伦那首，还是肖邦夜曲？
```

## Search Verification

The verifier receives `music_task` and selection preferences:

```json
{
  "music_task": {
    "type": "specific_performer_work_family",
    "primary_entities": [
      {"role": "performer", "name": "Arthur Rubinstein"},
      {"role": "composer", "name": "Frederic Chopin"}
    ],
    "work_hint": "Nocturnes",
    "search_goals": [
      "Arthur Rubinstein Chopin Nocturne",
      "Rubinstein Chopin Nocturnes",
      "鲁宾斯坦 肖邦 夜曲"
    ]
  },
  "selection_preferences": {
    "prefer_exact_performer": true,
    "prefer_original_artist_match": true,
    "avoid_playlists": true,
    "avoid_covers_if_not_requested": true,
    "avoid_utility_audio": true,
    "allow_adjacent_if_exact_not_found": true
  }
}
```

The verifier:

1. generates or normalizes three to six NetEase search queries
2. searches each query
3. normalizes candidates into title, artist, album, aliases, source query, and raw metadata
4. asks the LLM to judge candidate quality against the task
5. rejects low-quality or mismatched results
6. confirms playability through `AudioResolver`
7. returns the best verified candidate or recovery options

Verified output:

```json
{
  "status": "verified",
  "selected_song": {
    "id": "netease-song-id",
    "name": "Nocturne No. 2 in E-Flat Major, Op. 9 No. 2",
    "artist": "Arthur Rubinstein",
    "album": "Chopin: Nocturnes"
  },
  "verification": {
    "confidence": 0.86,
    "matched_entities": ["Arthur Rubinstein", "Chopin", "Nocturne"],
    "version_note": "Matches the Rubinstein / Chopin nocturne direction.",
    "risk": "Recording year may not be visible in NetEase metadata."
  },
  "fallback_candidates": []
}
```

Failure output:

```json
{
  "status": "not_found",
  "failure_reason": "No sufficiently reliable playable Rubinstein Chopin nocturne candidate was found.",
  "recovery_options": [
    {
      "type": "adjacent_version",
      "task": "Rubinstein Chopin piano solo",
      "reason": "Keep performer and composer, relax the nocturne constraint."
    },
    {
      "type": "same_work_different_performer",
      "task": "Chopin Nocturne Pollini Rubinstein Argerich",
      "reason": "Keep work family, allow adjacent performers."
    }
  ],
  "ask_user": false
}
```

## Memory Design

Long-running radio sessions cannot rely on growing chat history. The memory system is layered and bounded.

```text
Memory Event Log
  -> Session Working Memory
  -> Relevant Memory Retrieval
  -> Long-Term Taste Profile
  -> Fixed-size Prompt Context Pack
```

### Memory Event Log

Store raw events for audit and future distillation, but do not feed them directly to the LLM.

Example:

```json
{
  "event_type": "user_request",
  "raw_text": "我要听齐默尔曼的肖邦",
  "agent_understanding": "User wants Krystian Zimerman performing or recording Chopin works.",
  "entities": ["Krystian Zimerman", "Frederic Chopin"],
  "tags": ["classical", "piano", "performer_composer_request"],
  "importance": 0.82,
  "expires_at": null
}
```

### Session Working Memory

This is the short, structured state the DJ always sees. It prevents forgetfulness without requiring long context.

```json
{
  "active_mode": {
    "label": "Zimerman / Chopin / classical piano",
    "understood_intent": "User wants Zimerman performing or recording Chopin works.",
    "expires_after_tracks": 4,
    "confidence": 0.84
  },
  "current_constraints": [
    "Avoid overplayed Chinese pop.",
    "Avoid white noise, study audio, and playlist-like results.",
    "For classical requests, preserve performer and composer when possible."
  ],
  "recent_corrections": [
    {
      "user": "不是这些",
      "meaning": "The last result group was wrong; avoid that candidate family for this session."
    }
  ],
  "pending_soft_confirmation": "",
  "last_successful_request": "齐默尔曼的肖邦"
}
```

### Relevant Retrieval

On each user message, retrieve only a small set of relevant memories by entity, tag, event type, importance, recency, and expiry. The first version can use structured tag retrieval; embeddings can be added later if needed.

Example retrieval for "换点没那么俗的":

- explicit dislike of overplayed Chinese pop
- current active mode, such as afternoon R&B
- recent skips of mainstream Chinese tracks
- long-term preference for more textured music

### Long-Term Taste Profile

Long-term memory updates are evidence-based. Single requests mostly affect session memory. Repeated or explicit preferences can update durable memory.

```json
{
  "memory": "User dislikes overplayed, cheap-feeling Chinese pop.",
  "confidence": 0.78,
  "evidence_count": 5,
  "last_seen": "2026-05-27",
  "sources": ["negative_feedback", "skip_pattern", "explicit_request"]
}
```

Rules:

- explicit preference beats passive behavior
- repeated evidence beats one skip
- negative feedback applies immediately to the session
- long-term memory updates are conservative
- conflicting evidence is tracked before overwriting old memory
- encyclopedia aliases are not stored as user memory

### Context Pack

Each DJ call receives a fixed-size context pack:

```json
{
  "user_profile_digest": "Up to about 800 Chinese characters.",
  "session_working_memory": "Short structured state.",
  "recent_turns": "The last six key interactions.",
  "retrieved_memories": "Up to five relevant memories.",
  "playback_context": "Current track, recent tracks, ready queue, and active mode.",
  "hard_constraints": "Do not expose system internals; do not search the raw user sentence."
}
```

If context must be trimmed, priority order is:

1. current user message
2. active mode
3. explicit negative feedback
4. current playback context
5. relevant long-term preferences
6. ordinary recent history

### Structured Compaction

Compaction must not reduce history to a vague sentence. It produces structured state:

```json
{
  "session_summary": "The user moved from afternoon R&B to classical piano and explicitly avoided overplayed Chinese pop.",
  "stable_preferences_observed": [
    "Prefers textured music over cheap emotional cues.",
    "Shows interest in performer-specific classical versions."
  ],
  "temporary_constraints": [
    "Avoid mainstream Chinese pop for this session."
  ],
  "open_threads": [
    "Continue Zimerman / Chopin for two more tracks."
  ],
  "do_not_repeat": [
    "Do not search the literal user sentence."
  ]
}
```

## Queue Continuity

A user request can create an active listening mode.

Example:

```json
{
  "active_mode": {
    "label": "Zimerman / Chopin / classical piano",
    "expires_after_tracks": 4,
    "seed_task": {
      "performer": "Krystian Zimerman",
      "composer": "Frederic Chopin"
    },
    "continuation_policy": {
      "first_priority": "same performer + same composer",
      "second_priority": "same performer + adjacent classical piano",
      "third_priority": "same composer + compatible performer",
      "avoid": ["random piano playlist", "study music", "utility audio"]
    }
  }
}
```

When a new request changes direction:

1. keep the currently playing song unless the user explicitly skips
2. cancel old prewarm tasks
3. clear unplayed ready items
4. build new ready items from the DJ decision
5. send a DJ acknowledgement

The first song after a request must be the most precise. Later tracks continue from `active_mode`, avoiding repetition and staying within constraints.

Request durations:

- specific track: usually one track
- artist, band, performer, or composer direction: three to five tracks
- scene or style direction: five to eight tracks
- negative constraint: immediate and longer session effect

Corrections revise the active mode rather than starting from scratch:

```text
User: 别钢协，来点独奏
Mode update: keep Zimerman / Chopin; add solo piano; exclude concerto.
```

## Failure Recovery

The system can fail, but it must not fail in a way that sounds like it did not understand.

Never say:

- "没找到特别准的『用户原话』"
- "我先往这个情绪靠近一点"
- "根据你的画像"
- "系统认为"
- "算法推荐"
- "你可以换个说法"
- "请提供更准确的歌名"

Search failure recovery:

```text
exact performer + exact work
  -> same performer + same composer
  -> same work family + adjacent performer
  -> same mood/style with honest DJ note
```

For "鲁宾斯坦弹的肖邦夜曲":

```text
Rubinstein + Chopin + Nocturne
  -> Rubinstein + Chopin
  -> Chopin + Nocturne + other classic performers
  -> restrained classical piano night mood
```

Good DJ recovery:

```text
鲁宾斯坦那版夜曲我这边没有拿到稳定播放源，我先不乱接。
我先沿着肖邦夜曲这条线给你换一版稳的，气质还是留在那个晚上。
```

User frustration recovery:

```text
是我刚才接偏了。我重新按你要的方向来，不拿刚才那批结果继续放。
```

## Migration Plan Boundaries

This design intentionally chooses a full request-path replacement.

Deprecate from the song request path:

- `RadioBrain.interpret_user_text`
- WebSocket intent-type branching for positive music requests
- scheduler natural-language interpretation
- `SongRequestAgent` as a combined understand/search/select component

Keep and reuse:

- NetEase adapter
- AudioResolver
- playback queue infrastructure
- TTS generation
- existing profile analysis as initial taste input
- scheduler fallback behavior when no active DJ mode exists

New or repurposed modules:

- `backend/engines/dj_request_agent.py`
- `backend/engines/search_verify_agent.py`
- `backend/engines/queue_director.py`
- `backend/memory/dj_memory.py` or equivalent MemoryManager

## Testing Strategy

Testing must attack the system with varied, fuzzy, and adversarial music requests, not only known examples.

### Unit Tests

DJRequestAgent:

- "不能放点radiohead的吗" -> Radiohead music task, not raw search
- "我要听收音机头" -> Radiohead task through LLM reasoning
- "林肯公园呢" -> Linkin Park direction
- "我要听齐默尔曼的肖邦" -> performer + composer direction
- "想听鲁宾斯坦弹的肖邦夜曲" -> performer + composer + work family
- "下午想听点rnb" -> scene and style direction
- "夜曲" with Chinese pop context -> soft confirm Jay Chou
- "夜曲" with classical context -> soft confirm Chopin
- "不是这些" -> revise/negative feedback, clear old candidate family
- "别钢协，来点独奏" -> revise active mode, keep core entities

SearchVerifyAgent:

- does not search raw user command prefixes
- prefers exact artist or performer when specified
- rejects playlists, utility audio, covers, and low-confidence versions
- returns recovery options when exact version fails
- verifies playable URL before queueing

MemoryManager:

- session memory remains bounded
- active mode persists across multiple tracks
- one-off requests do not pollute long-term memory
- repeated explicit feedback updates long-term memory
- context pack respects size and priority limits

QueueDirector:

- clears stale ready queue after new direction
- continues active mode for the requested duration
- updates mode after corrections
- does not fall back to generic recommendation while active mode recovery remains possible

### Integration Tests

Use backend-level WebSocket or direct engine tests with fake LLM and fake NetEase:

- point song, verify next queued track and DJ response
- fuzzy artist request, verify structured task and search query
- classical performer request, verify correct version preference
- negative feedback, verify old queue is cleared
- long session, verify context pack remains bounded and active mode is remembered

### Manual Probe Set

Run probes that are intentionally varied:

- "来点霍洛维茨的拉赫玛尼诺夫"
- "我想听海菲兹的柴可夫斯基小协"
- "放点古典，米开朗杰利的德彪西"
- "给我来点切利比达克的布鲁克纳"
- "想听点Bill Evans的爵士"
- "今天下午别太甜，来点rnb"
- "还是刚才那个方向，但别这么吵"
- "不是这个版本"

Success means the system produces a plausible structured task, avoids raw-sentence search, verifies or recovers musically, and updates memory/queue state correctly.

## Acceptance Criteria

1. The WebSocket song request path calls DJRequestAgent as the single positive-request interpreter.
2. Requests for artists, bands, composers, performers, styles, scenes, moods, corrections, and continuations produce structured DJ decisions.
3. SearchVerifyAgent never relies on raw user sentence search unless the DJ task says the raw text is itself a canonical title.
4. QueueDirector clears stale ready items and preserves active mode for multi-track directions.
5. The system can continue a user-defined direction for several tracks.
6. Memory context remains bounded during long sessions.
7. Negative feedback changes the current mode and queue immediately.
8. Failure responses never quote the raw user sentence as the failed search object.
9. Tests include broad fuzzy request probes, not only one-off examples.

