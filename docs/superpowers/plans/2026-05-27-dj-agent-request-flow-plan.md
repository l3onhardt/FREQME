# DJ Agent Request Flow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the brittle rule-driven song request path with a DJ agent flow that understands user intent, verifies NetEase results, preserves multi-track listening direction, and keeps memory bounded.

**Architecture:** Add four focused backend boundaries: `DJRequestAgent` interprets user intent, `SearchVerifyAgent` searches and verifies versions, `QueueDirector` owns request-time queue continuity, and `DJMemoryManager` builds bounded context/memory. The WebSocket `song_request` path is then cut over to this new flow; `RadioBrain` and `SongRequestAgent` stop being positive-request interpreters.

**Tech Stack:** Python 3.12, FastAPI WebSocket flow, SQLite via `aiosqlite`, existing NetEase adapter, existing `AudioResolver`, existing `PlaybackQueue`, `unittest` async tests, fake LLM/NetEase/resolver test doubles.

---

## Spec Reference

Read first:

- `docs/superpowers/specs/2026-05-27-dj-agent-request-flow-design.md`

The plan implements the full replacement option from that spec.

## Current-State Notes

The working tree may contain unfinished edits from the previous `RadioBrain` repair attempt:

- `backend/api/ws.py`
- `backend/engines/radio_brain.py`
- `backend/engines/scheduler.py`
- `tests/python/test_radio_brain.py`
- `tests/python/test_scheduler_personalized_pick.py`
- `tests/python/test_ws_user_settings.py`
- `data-radio-intent-ux/` runtime directory

Do not revert those changes blindly. The new implementation should supersede the old song request path. If tests conflict with the new design, rewrite the tests around the new agent boundaries instead of expanding the old rule stack.

## File Structure

Create:

- `backend/engines/dj_request_agent.py`
  - Dataclasses for DJ decisions.
  - LLM prompt and JSON parsing for user intent.
  - Bounded fallback behavior for invalid LLM output.

- `backend/engines/search_verify_agent.py`
  - Dataclasses for search verification results.
  - Query generation from `music_task`.
  - Candidate pooling, LLM version judgement, local result filtering, playability verification.

- `backend/engines/queue_director.py`
  - Request-time orchestration for DJ decision -> verification -> queue.
  - Active mode continuation and correction handling.
  - Ready queue clearing and stale prewarm coordination hooks.

- `backend/memory/dj_memory.py`
  - Session working memory.
  - Event logging helpers.
  - Relevant memory retrieval.
  - Fixed-size context pack assembly.

- `tests/python/test_dj_request_agent.py`
- `tests/python/test_search_verify_agent.py`
- `tests/python/test_dj_memory.py`
- `tests/python/test_queue_director.py`
- `tests/python/test_ws_dj_agent_flow.py`
- `tests/python/test_dj_agent_probe_matrix.py`

Modify:

- `backend/memory/models.py`
  - Add DJ memory tables and indexes.

- `backend/memory/store.py`
  - Add methods for DJ memory event/session/user memory.

- `backend/engines/playback_queue.py`
  - Add `clear_ready()` and optionally `replace_ready()` helpers.

- `backend/main.py`
  - Instantiate and wire `DJMemoryManager`, `DJRequestAgent`, `SearchVerifyAgent`, and `QueueDirector`.
  - Stop wiring `SongRequestAgent` and `RadioBrain` as the main positive-request path.

- `backend/api/ws.py`
  - Add globals for new services.
  - Replace `song_request` branch with `QueueDirector` flow.
  - Keep handshake, playback, skip, intro, TTS, and fallback mechanics.

- `backend/engines/scheduler.py`
  - Keep automatic radio fallback.
  - Remove or bypass user natural-language interpretation for active DJ request mode.

Leave for later cleanup after the cutover is stable:

- `backend/engines/radio_brain.py`
- `backend/engines/song_request_agent.py`

They can remain temporarily for compatibility with older tests or non-request paths, but they must not interpret positive user song requests after this plan is complete.

---

### Task 1: Playback Queue Ready Clearing

**Files:**

- Modify: `backend/engines/playback_queue.py`
- Modify: `tests/python/test_playback_queue.py`

- [ ] **Step 1: Write the failing queue clear test**

Add to `tests/python/test_playback_queue.py`:

```python
def test_clear_ready_keeps_playing_and_old_history(self):
    queue = PlaybackQueue(prewarm_depth=3)
    queue.add_ready({"id": "1"}, "/audio/1")
    queue.add_ready({"id": "2"}, "/audio/2")
    queue.promote_next()
    queue.add_ready({"id": "3"}, "/audio/3")

    removed = queue.clear_ready()

    self.assertEqual(removed, 2)
    self.assertEqual([item.song["id"] for item in queue.items], ["1"])
    self.assertEqual(queue.items[0].status, "playing")
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```powershell
python -X utf8 -m unittest tests.python.test_playback_queue.PlaybackQueueTests.test_clear_ready_keeps_playing_and_old_history
```

Expected: FAIL with `AttributeError: 'PlaybackQueue' object has no attribute 'clear_ready'`.

- [ ] **Step 3: Implement `clear_ready`**

In `backend/engines/playback_queue.py`:

```python
def clear_ready(self) -> int:
    ready_count = sum(1 for item in self.items if item.status == "ready")
    self.items = [item for item in self.items if item.status != "ready"]
    return ready_count
```

- [ ] **Step 4: Run queue tests**

Run:

```powershell
python -X utf8 -m unittest tests.python.test_playback_queue
```

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add backend/engines/playback_queue.py tests/python/test_playback_queue.py
git commit -m "feat: add ready queue clearing"
```

---

### Task 2: DJ Memory Store Schema

**Files:**

- Modify: `backend/memory/models.py`
- Modify: `backend/memory/store.py`
- Modify: `tests/python/test_memory_store_settings.py`

- [ ] **Step 1: Write failing schema/store tests**

Add tests to `tests/python/test_memory_store_settings.py`:

```python
def test_dj_memory_event_session_and_user_memory_round_trip(self):
    with tempfile.TemporaryDirectory() as tmp:
        os.environ["RADIO_DB_PATH"] = str(Path(tmp) / "radio-test.db")

        from backend.memory.models import init_db
        from backend.memory.store import MemoryStore

        async def run():
            await init_db()
            store = MemoryStore()

            event_id = await store.log_dj_memory_event(
                uid="42",
                session_id=7,
                event_type="user_request",
                raw_text="我要听齐默尔曼的肖邦",
                payload={
                    "agent_understanding": "Zimerman / Chopin",
                    "entities": ["Krystian Zimerman", "Chopin"],
                    "tags": ["classical", "piano"],
                    "importance": 0.82,
                },
            )
            self.assertIsInstance(event_id, int)

            await store.save_dj_session_memory(
                uid="42",
                session_id=7,
                memory={
                    "active_mode": {
                        "label": "Zimerman / Chopin",
                        "expires_after_tracks": 4,
                    }
                },
            )
            await store.upsert_dj_user_memory(
                uid="42",
                memory_key="avoid_overplayed_chinese_pop",
                memory_text="User dislikes overplayed Chinese pop.",
                confidence=0.78,
                evidence_count=5,
                tags=["negative_feedback", "taste"],
            )

            session_memory = await store.get_dj_session_memory("42", 7)
            user_memories = await store.get_dj_user_memories("42", tags=["taste"])
            events = await store.get_recent_dj_memory_events("42", limit=5)

            self.assertEqual(session_memory["active_mode"]["label"], "Zimerman / Chopin")
            self.assertEqual(user_memories[0]["memory_key"], "avoid_overplayed_chinese_pop")
            self.assertEqual(events[0]["raw_text"], "我要听齐默尔曼的肖邦")

        asyncio.run(run())
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```powershell
python -X utf8 -m unittest tests.python.test_memory_store_settings.MemoryStoreSettingsTest.test_dj_memory_event_session_and_user_memory_round_trip
```

Expected: FAIL with missing store methods.

- [ ] **Step 3: Add schema**

In `backend/memory/models.py`, inside `init_db()`:

```sql
CREATE TABLE IF NOT EXISTS dj_memory_event (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    uid TEXT NOT NULL,
    session_id INTEGER,
    event_type TEXT NOT NULL,
    raw_text TEXT,
    payload_json TEXT NOT NULL,
    importance REAL DEFAULT 0.5,
    expires_at TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_dj_memory_event_uid_created
    ON dj_memory_event(uid, created_at);
CREATE INDEX IF NOT EXISTS idx_dj_memory_event_uid_type
    ON dj_memory_event(uid, event_type, created_at);

CREATE TABLE IF NOT EXISTS dj_session_memory (
    uid TEXT NOT NULL,
    session_id INTEGER NOT NULL,
    memory_json TEXT NOT NULL,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY(uid, session_id)
);

CREATE TABLE IF NOT EXISTS dj_user_memory (
    uid TEXT NOT NULL,
    memory_key TEXT NOT NULL,
    memory_text TEXT NOT NULL,
    confidence REAL DEFAULT 0.5,
    evidence_count INTEGER DEFAULT 1,
    tags_json TEXT NOT NULL,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY(uid, memory_key)
);
CREATE INDEX IF NOT EXISTS idx_dj_user_memory_uid_updated
    ON dj_user_memory(uid, updated_at);
```

- [ ] **Step 4: Add store methods**

In `backend/memory/store.py`:

```python
async def log_dj_memory_event(
    self,
    uid: str,
    session_id: int | None,
    event_type: str,
    raw_text: str = "",
    payload: dict | None = None,
    importance: float | None = None,
    expires_at: str | None = None,
) -> int:
    payload = payload or {}
    event_importance = importance
    if event_importance is None:
        event_importance = float(payload.get("importance", 0.5) or 0.5)
    async with connect_db() as db:
        cursor = await db.execute(
            "INSERT INTO dj_memory_event "
            "(uid, session_id, event_type, raw_text, payload_json, importance, expires_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            (
                str(uid),
                session_id,
                event_type,
                raw_text,
                json.dumps(payload, ensure_ascii=False),
                event_importance,
                expires_at,
            ),
        )
        await db.commit()
        return int(cursor.lastrowid)

async def get_recent_dj_memory_events(self, uid: str, limit: int = 20) -> list[dict]:
    async with connect_db() as db:
        async with db.execute(
            "SELECT id, session_id, event_type, raw_text, payload_json, importance, expires_at, created_at "
            "FROM dj_memory_event WHERE uid=? ORDER BY created_at DESC, id DESC LIMIT ?",
            (str(uid), limit),
        ) as cursor:
            rows = await cursor.fetchall()
    return [
        {
            "id": row[0],
            "session_id": row[1],
            "event_type": row[2],
            "raw_text": row[3] or "",
            "payload": json.loads(row[4] or "{}"),
            "importance": row[5],
            "expires_at": row[6],
            "created_at": row[7],
        }
        for row in rows
    ]

async def save_dj_session_memory(self, uid: str, session_id: int, memory: dict) -> None:
    async with connect_db() as db:
        await db.execute(
            "INSERT INTO dj_session_memory (uid, session_id, memory_json, updated_at) "
            "VALUES (?, ?, ?, CURRENT_TIMESTAMP) "
            "ON CONFLICT(uid, session_id) DO UPDATE SET "
            "memory_json=excluded.memory_json, updated_at=CURRENT_TIMESTAMP",
            (str(uid), int(session_id), json.dumps(memory, ensure_ascii=False)),
        )
        await db.commit()

async def get_dj_session_memory(self, uid: str, session_id: int) -> dict:
    async with connect_db() as db:
        async with db.execute(
            "SELECT memory_json FROM dj_session_memory WHERE uid=? AND session_id=?",
            (str(uid), int(session_id)),
        ) as cursor:
            row = await cursor.fetchone()
    return json.loads(row[0]) if row else {}

async def upsert_dj_user_memory(
    self,
    uid: str,
    memory_key: str,
    memory_text: str,
    confidence: float,
    evidence_count: int,
    tags: list[str] | None = None,
) -> None:
    async with connect_db() as db:
        await db.execute(
            "INSERT INTO dj_user_memory "
            "(uid, memory_key, memory_text, confidence, evidence_count, tags_json, updated_at) "
            "VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP) "
            "ON CONFLICT(uid, memory_key) DO UPDATE SET "
            "memory_text=excluded.memory_text, confidence=excluded.confidence, "
            "evidence_count=excluded.evidence_count, tags_json=excluded.tags_json, "
            "updated_at=CURRENT_TIMESTAMP",
            (
                str(uid),
                memory_key,
                memory_text,
                float(confidence),
                int(evidence_count),
                json.dumps(tags or [], ensure_ascii=False),
            ),
        )
        await db.commit()

async def get_dj_user_memories(self, uid: str, tags: list[str] | None = None, limit: int = 10) -> list[dict]:
    async with connect_db() as db:
        async with db.execute(
            "SELECT memory_key, memory_text, confidence, evidence_count, tags_json, updated_at "
            "FROM dj_user_memory WHERE uid=? ORDER BY confidence DESC, updated_at DESC LIMIT ?",
            (str(uid), int(limit)),
        ) as cursor:
            rows = await cursor.fetchall()
    wanted = set(tags or [])
    memories = []
    for row in rows:
        row_tags = json.loads(row[4] or "[]")
        if wanted and not wanted.intersection(row_tags):
            continue
        memories.append({
            "memory_key": row[0],
            "memory_text": row[1],
            "confidence": row[2],
            "evidence_count": row[3],
            "tags": row_tags,
            "updated_at": row[5],
        })
    return memories
```

- [ ] **Step 5: Run memory tests**

Run:

```powershell
python -X utf8 -m unittest tests.python.test_memory_store_settings
```

Expected: PASS.

- [ ] **Step 6: Commit**

```powershell
git add backend/memory/models.py backend/memory/store.py tests/python/test_memory_store_settings.py
git commit -m "feat: add DJ memory persistence"
```

---

### Task 3: DJ Memory Manager Context Pack

**Files:**

- Create: `backend/memory/dj_memory.py`
- Create: `tests/python/test_dj_memory.py`

- [ ] **Step 1: Write failing context-pack tests**

Create `tests/python/test_dj_memory.py`:

```python
import unittest

from backend.memory.dj_memory import DJMemoryManager


class FakeStore:
    def __init__(self):
        self.session_memory = {
            "active_mode": {"label": "Zimerman / Chopin", "expires_after_tracks": 3},
            "current_constraints": ["Avoid overplayed Chinese pop."],
        }
        self.user_memories = [
            {
                "memory_key": "avoid_pop",
                "memory_text": "User dislikes overplayed Chinese pop.",
                "confidence": 0.8,
                "tags": ["taste", "negative_feedback"],
            }
        ]
        self.events = [
            {
                "event_type": "user_request",
                "raw_text": "我要听齐默尔曼的肖邦",
                "payload": {"tags": ["classical", "piano"]},
                "importance": 0.82,
            }
        ]

    async def get_dj_session_memory(self, uid, session_id):
        return self.session_memory

    async def get_dj_user_memories(self, uid, tags=None, limit=10):
        return self.user_memories[:limit]

    async def get_recent_dj_memory_events(self, uid, limit=20):
        return self.events[:limit]


class DJMemoryManagerTests(unittest.IsolatedAsyncioTestCase):
    async def test_context_pack_is_bounded_and_prioritized(self):
        manager = DJMemoryManager(FakeStore(), max_profile_chars=80, max_recent_turns=2, max_retrieved_memories=1)
        pack = await manager.build_context_pack(
            uid="42",
            session_id=7,
            user_message="还是这个方向继续",
            profile={
                "radio_insights": {
                    "taste_summary": "x" * 200,
                    "comfort_zone": ["quiet piano"],
                },
                "anchor_tracks": [{"name": "Exit Music", "artist": "Radiohead"}],
            },
            user_settings={"timezone_name": "Asia/Hong_Kong"},
            playback_context={
                "current_track": {"name": "Nocturne", "artist": "Arthur Rubinstein"},
                "recent_tracks": [],
                "ready_queue": [],
            },
            recent_turns=[
                {"speaker": "user", "text": "old"},
                {"speaker": "dj", "text": "old response"},
                {"speaker": "user", "text": "new"},
            ],
        )

        self.assertEqual(pack["user_message"], "还是这个方向继续")
        self.assertEqual(pack["session_working_memory"]["active_mode"]["label"], "Zimerman / Chopin")
        self.assertLessEqual(len(pack["user_profile_digest"]), 80)
        self.assertEqual(len(pack["recent_turns"]), 2)
        self.assertEqual(len(pack["retrieved_memories"]), 1)
        self.assertEqual(pack["playback_context"]["current_track"]["name"], "Nocturne")
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```powershell
python -X utf8 -m unittest tests.python.test_dj_memory
```

Expected: FAIL because `backend.memory.dj_memory` is missing.

- [ ] **Step 3: Implement `DJMemoryManager`**

Create `backend/memory/dj_memory.py`:

```python
from __future__ import annotations

from dataclasses import dataclass


@dataclass
class DJMemoryManager:
    store: object
    max_profile_chars: int = 800
    max_recent_turns: int = 6
    max_retrieved_memories: int = 5

    async def build_context_pack(
        self,
        uid: str | None,
        session_id: int | None,
        user_message: str,
        profile: dict | None = None,
        user_settings: dict | None = None,
        playback_context: dict | None = None,
        recent_turns: list[dict] | None = None,
    ) -> dict:
        session_memory = {}
        retrieved_memories = []
        recent_events = []

        if uid and session_id:
            try:
                session_memory = await self.store.get_dj_session_memory(str(uid), int(session_id))
            except Exception:
                session_memory = {}
        if uid:
            tags = self._query_tags(user_message, session_memory)
            try:
                retrieved_memories = await self.store.get_dj_user_memories(
                    str(uid),
                    tags=tags or None,
                    limit=self.max_retrieved_memories,
                )
            except Exception:
                retrieved_memories = []
            try:
                recent_events = await self.store.get_recent_dj_memory_events(str(uid), limit=8)
            except Exception:
                recent_events = []

        return {
            "user_message": self._clip(user_message, 500),
            "user_profile_digest": self._profile_digest(profile),
            "session_working_memory": session_memory if isinstance(session_memory, dict) else {},
            "recent_turns": list(recent_turns or [])[-self.max_recent_turns :],
            "retrieved_memories": list(retrieved_memories or [])[: self.max_retrieved_memories],
            "recent_memory_events": self._compact_events(recent_events),
            "playback_context": playback_context or {},
            "user_settings": self._compact_settings(user_settings),
            "hard_constraints": [
                "Do not expose system internals, profile labels, or algorithms.",
                "Do not search the literal user sentence unless it is itself a canonical title.",
                "Prefer direct playback; ask only when ambiguity is high.",
            ],
        }

    async def apply_decision_update(
        self,
        uid: str | None,
        session_id: int | None,
        request_text: str,
        decision,
    ) -> dict:
        if not uid or not session_id:
            return {}
        memory = self._session_memory_from_decision(decision)
        try:
            await self.store.save_dj_session_memory(str(uid), int(session_id), memory)
            await self.store.log_dj_memory_event(
                uid=str(uid),
                session_id=int(session_id),
                event_type="dj_decision",
                raw_text=request_text,
                payload={
                    "understood_intent": getattr(decision, "understood_intent", ""),
                    "action": getattr(decision, "action", ""),
                    "memory_update": getattr(decision, "memory_update", {}),
                    "music_task": getattr(decision, "music_task", {}),
                    "importance": 0.7,
                },
            )
        except Exception:
            pass
        return memory

    def _session_memory_from_decision(self, decision) -> dict:
        queue_policy = getattr(decision, "queue_policy", {}) or {}
        music_task = getattr(decision, "music_task", {}) or {}
        memory_update = getattr(decision, "memory_update", {}) or {}
        duration = int(queue_policy.get("duration_tracks") or 1)
        return {
            "active_mode": {
                "label": str(getattr(decision, "understood_intent", "") or music_task.get("type") or ""),
                "understood_intent": str(getattr(decision, "understood_intent", "") or ""),
                "expires_after_tracks": max(0, duration),
                "seed_task": music_task,
                "confidence": 1.0,
            },
            "current_constraints": list(memory_update.get("negative_constraints") or []),
            "last_successful_request": str(getattr(decision, "raw_text", "") or ""),
        }

    def _profile_digest(self, profile: dict | None) -> str:
        if not isinstance(profile, dict):
            return ""
        parts = []
        insights = profile.get("radio_insights") if isinstance(profile.get("radio_insights"), dict) else {}
        for key in ("taste_summary", "comfort_zone", "discovery_direction", "emotional_hooks"):
            value = insights.get(key)
            if isinstance(value, str) and value.strip():
                parts.append(value.strip())
            elif isinstance(value, list):
                parts.extend(str(item).strip() for item in value if str(item).strip())
        for track in (profile.get("anchor_tracks") or [])[:5]:
            if isinstance(track, dict):
                name = str(track.get("name") or "").strip()
                artist = str(track.get("artist") or track.get("ar") or "").strip()
                if name:
                    parts.append(f"{artist} - {name}".strip(" -"))
        return self._clip(" | ".join(parts), self.max_profile_chars)

    def _compact_settings(self, user_settings: dict | None) -> dict:
        if not isinstance(user_settings, dict):
            return {}
        return {
            key: user_settings.get(key)
            for key in ("timezone_name", "locale", "region_hint", "current_mode")
            if user_settings.get(key)
        }

    def _compact_events(self, events: list[dict]) -> list[dict]:
        compact = []
        for event in events[:8]:
            compact.append({
                "event_type": event.get("event_type"),
                "raw_text": self._clip(event.get("raw_text", ""), 120),
                "payload": event.get("payload", {}),
                "importance": event.get("importance", 0.5),
            })
        return compact

    def _query_tags(self, text: str, session_memory: dict | None) -> list[str]:
        raw = str(text or "").lower()
        tags = []
        for token, tag in (
            ("rnb", "rnb"),
            ("radiohead", "alternative_rock"),
            ("chopin", "classical"),
            ("肖邦", "classical"),
            ("不要", "negative_feedback"),
            ("不是", "negative_feedback"),
        ):
            if token in raw and tag not in tags:
                tags.append(tag)
        active = (session_memory or {}).get("active_mode") if isinstance(session_memory, dict) else {}
        seed = active.get("seed_task") if isinstance(active, dict) else {}
        if isinstance(seed, dict):
            for value in seed.get("tags", []):
                if value not in tags:
                    tags.append(value)
        return tags

    def _clip(self, value, limit: int) -> str:
        text = " ".join(str(value or "").split())
        return text[:limit]
```

- [ ] **Step 4: Run memory manager tests**

Run:

```powershell
python -X utf8 -m unittest tests.python.test_dj_memory
```

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add backend/memory/dj_memory.py tests/python/test_dj_memory.py
git commit -m "feat: build bounded DJ memory context"
```

---

### Task 4: DJ Request Agent

**Files:**

- Create: `backend/engines/dj_request_agent.py`
- Create: `tests/python/test_dj_request_agent.py`

- [ ] **Step 1: Write failing DJRequestAgent tests**

Create `tests/python/test_dj_request_agent.py`:

```python
import unittest

from backend.engines.dj_request_agent import DJRequestAgent


class FakeLLM:
    def __init__(self, response):
        self.response = response
        self.calls = []

    async def chat(self, prompt, max_tokens=300, system=None):
        self.calls.append({"prompt": prompt, "max_tokens": max_tokens, "system": system})
        return self.response


class DJRequestAgentTests(unittest.IsolatedAsyncioTestCase):
    async def test_radiohead_request_becomes_music_task_not_literal_search(self):
        llm = FakeLLM("""
        {
          "action": "set_direction_and_play",
          "understood_intent": "User wants Radiohead songs.",
          "music_task": {
            "type": "artist_direction",
            "primary_entities": [{"role": "artist", "name": "Radiohead"}],
            "search_goals": ["Radiohead Weird Fishes", "Radiohead No Surprises"],
            "must_not_search_literal_user_sentence": true
          },
          "queue_policy": {"duration_tracks": 4, "continue_direction": true},
          "uncertainty": {"level": "low", "should_ask_user": false},
          "dj_response": {"speak_now": "懂了，我先把它接到 Radiohead 这条线上。"},
          "memory_update": {"session_preference": ["Radiohead direction"], "negative_constraints": []}
        }
        """)
        agent = DJRequestAgent(llm)

        decision = await agent.decide(
            user_message="不能放点radiohead的吗",
            context_pack={
                "user_profile_digest": "likes textured alternative rock",
                "session_working_memory": {},
                "playback_context": {},
            },
        )

        self.assertEqual(decision.action, "set_direction_and_play")
        self.assertEqual(decision.music_task["primary_entities"][0]["name"], "Radiohead")
        self.assertTrue(decision.music_task["must_not_search_literal_user_sentence"])
        self.assertNotIn("不能放点radiohead的吗", decision.music_task["search_goals"])
        self.assertIn("Do not search", llm.calls[0]["prompt"])

    async def test_invalid_json_returns_safe_clarifying_decision(self):
        agent = DJRequestAgent(FakeLLM("not json"))

        decision = await agent.decide("???", context_pack={})

        self.assertEqual(decision.action, "ask_clarifying_question")
        self.assertEqual(decision.uncertainty["level"], "high")
        self.assertTrue(decision.dj_response["speak_now"])
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```powershell
python -X utf8 -m unittest tests.python.test_dj_request_agent
```

Expected: FAIL because module is missing.

- [ ] **Step 3: Implement DJ decision dataclass and parser**

Create `backend/engines/dj_request_agent.py`:

```python
from __future__ import annotations

from dataclasses import dataclass, field
import asyncio
import json
import re


@dataclass
class DJDecision:
    action: str
    understood_intent: str = ""
    music_task: dict = field(default_factory=dict)
    queue_policy: dict = field(default_factory=dict)
    uncertainty: dict = field(default_factory=dict)
    dj_response: dict = field(default_factory=dict)
    memory_update: dict = field(default_factory=dict)
    raw_text: str = ""

    def to_dict(self) -> dict:
        return {
            "action": self.action,
            "understood_intent": self.understood_intent,
            "music_task": self.music_task,
            "queue_policy": self.queue_policy,
            "uncertainty": self.uncertainty,
            "dj_response": self.dj_response,
            "memory_update": self.memory_update,
            "raw_text": self.raw_text,
        }


class DJRequestAgent:
    def __init__(self, llm, llm_timeout_s: float = 8.0):
        self.llm = llm
        self.llm_timeout_s = llm_timeout_s

    async def decide(self, user_message: str, context_pack: dict | None = None) -> DJDecision:
        clean = " ".join(str(user_message or "").split())[:500]
        if not clean:
            return self._safe_question(clean)
        prompt = self._prompt(clean, context_pack or {})
        try:
            response = await asyncio.wait_for(
                self.llm.chat(
                    prompt,
                    max_tokens=900,
                    system=(
                        "You are FREQME's private AI DJ request agent. "
                        "Understand the user's music intent from context and output only valid JSON."
                    ),
                ),
                timeout=self.llm_timeout_s,
            )
            data = self._parse_json(response)
        except Exception:
            data = {}
        return self._decision_from_data(clean, data)

    def _prompt(self, user_message: str, context_pack: dict) -> str:
        return f"""User just spoke to the AI radio DJ:
{user_message}

Context pack JSON:
{json.dumps(context_pack, ensure_ascii=False, indent=2)}

Decide what the user wants musically. Be an AI DJ, not a keyword classifier.

Rules:
- Do not search the literal user sentence unless the sentence itself is a canonical title.
- Infer fuzzy artist, band, composer, performer, work-family, scene, style, mood, correction, rejection, or continuation intent.
- Most requests should play now or set a direction and play.
- Ask only when ambiguity is high and context cannot resolve it.
- A request can set a multi-track queue policy.
- Memory update should describe user/session preference, not encyclopedia aliases.
- Never expose profile, algorithm, or system wording in the DJ response.

Return only JSON:
{{
  "action": "play_now | set_direction_and_play | revise_mode_and_play | soft_confirm_and_play | ask_clarifying_question | negative_feedback | continue_current_mode",
  "understood_intent": "internal interpretation",
  "music_task": {{
    "type": "specific_track | artist_direction | artist_work_direction | scene_genre_direction | negative_feedback | continuation",
    "primary_entities": [{{"role": "artist|performer|composer|work|genre", "name": "canonical or inferred name"}}],
    "work_hint": "",
    "style_hint": "",
    "search_goals": ["concrete NetEase-friendly search query"],
    "must_not_search_literal_user_sentence": true
  }},
  "queue_policy": {{"duration_tracks": 1, "continue_direction": false, "avoid_repetition": true}},
  "uncertainty": {{"level": "low|medium|high", "reason": "", "should_ask_user": false}},
  "dj_response": {{"speak_now": "short natural Chinese DJ response", "tone": "warm_confident"}},
  "memory_update": {{"session_preference": [], "possible_long_term_preference": [], "negative_constraints": []}}
}}"""

    def _decision_from_data(self, raw_text: str, data: dict) -> DJDecision:
        if not isinstance(data, dict) or not isinstance(data.get("action"), str):
            return self._safe_question(raw_text)
        music_task = data.get("music_task") if isinstance(data.get("music_task"), dict) else {}
        queue_policy = data.get("queue_policy") if isinstance(data.get("queue_policy"), dict) else {}
        uncertainty = data.get("uncertainty") if isinstance(data.get("uncertainty"), dict) else {}
        dj_response = data.get("dj_response") if isinstance(data.get("dj_response"), dict) else {}
        memory_update = data.get("memory_update") if isinstance(data.get("memory_update"), dict) else {}
        music_task.setdefault("must_not_search_literal_user_sentence", True)
        queue_policy.setdefault("duration_tracks", 1)
        queue_policy.setdefault("continue_direction", data.get("action") in {"set_direction_and_play", "continue_current_mode"})
        uncertainty.setdefault("should_ask_user", data.get("action") == "ask_clarifying_question")
        dj_response.setdefault("speak_now", "我先按我理解到的方向接上。")
        return DJDecision(
            action=data["action"],
            understood_intent=str(data.get("understood_intent") or ""),
            music_task=music_task,
            queue_policy=queue_policy,
            uncertainty=uncertainty,
            dj_response=dj_response,
            memory_update=memory_update,
            raw_text=raw_text,
        )

    def _safe_question(self, raw_text: str) -> DJDecision:
        return DJDecision(
            action="ask_clarifying_question",
            understood_intent="The request is not clear enough to select music safely.",
            music_task={"type": "unclear", "search_goals": [], "must_not_search_literal_user_sentence": True},
            queue_policy={"duration_tracks": 0, "continue_direction": False},
            uncertainty={"level": "high", "should_ask_user": True},
            dj_response={"speak_now": "这个我没接稳，是想听某个歌手，还是这种氛围？"},
            memory_update={"session_preference": [], "possible_long_term_preference": [], "negative_constraints": []},
            raw_text=raw_text,
        )

    def _parse_json(self, text: str) -> dict:
        raw = str(text or "").strip()
        try:
            return json.loads(raw)
        except Exception:
            match = re.search(r"\{.*\}", raw, re.S)
            if not match:
                return {}
            try:
                return json.loads(match.group(0))
            except Exception:
                return {}
```

- [ ] **Step 4: Run tests**

Run:

```powershell
python -X utf8 -m unittest tests.python.test_dj_request_agent
```

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add backend/engines/dj_request_agent.py tests/python/test_dj_request_agent.py
git commit -m "feat: add DJ request agent"
```

---

### Task 5: Search Verify Agent

**Files:**

- Create: `backend/engines/search_verify_agent.py`
- Create: `tests/python/test_search_verify_agent.py`

- [ ] **Step 1: Write failing SearchVerifyAgent tests**

Create `tests/python/test_search_verify_agent.py`:

```python
import unittest

from backend.engines.search_verify_agent import SearchVerifyAgent


class FakeLLM:
    def __init__(self, responses):
        self.responses = list(responses)
        self.calls = []

    async def chat(self, prompt, max_tokens=300, system=None):
        self.calls.append({"prompt": prompt, "max_tokens": max_tokens, "system": system})
        return self.responses.pop(0)


class FakeNetease:
    def __init__(self):
        self.search_calls = []
        self.results_by_query = {}

    async def search(self, keywords, limit=8):
        self.search_calls.append({"keywords": keywords, "limit": limit})
        return list(self.results_by_query.get(keywords, []))


class FakeResolver:
    async def resolve_with_candidates(self, song, uid=None):
        return type("Result", (), {
            "ok": song.get("id") == "rubinstein",
            "song_id": song.get("id"),
            "proxy_url": f"/api/radio/audio/{song.get('id')}" if song.get("id") == "rubinstein" else "",
        })()


class SearchVerifyAgentTests(unittest.IsolatedAsyncioTestCase):
    async def test_verifies_performer_work_without_raw_sentence_search(self):
        netease = FakeNetease()
        netease.results_by_query["Arthur Rubinstein Chopin Nocturne"] = [
            {"id": "playlist", "name": "Chopin sleep playlist", "ar": [{"name": "Study Piano"}]},
            {"id": "rubinstein", "name": "Nocturne No.2 in E-flat Major", "ar": [{"name": "Arthur Rubinstein"}], "al": {"name": "Chopin: Nocturnes"}},
        ]
        llm = FakeLLM([
            '{"search_queries":["Arthur Rubinstein Chopin Nocturne"]}',
            '{"chosen_id":"rubinstein","confidence":0.91,"matched_entities":["Arthur Rubinstein","Chopin","Nocturne"],"version_note":"Matches performer and work family.","risk":""}',
        ])
        agent = SearchVerifyAgent(llm, netease, FakeResolver())

        result = await agent.verify(
            {
                "type": "specific_performer_work_family",
                "primary_entities": [
                    {"role": "performer", "name": "Arthur Rubinstein"},
                    {"role": "composer", "name": "Frederic Chopin"},
                ],
                "work_hint": "Nocturnes",
                "search_goals": ["Arthur Rubinstein Chopin Nocturne"],
                "must_not_search_literal_user_sentence": True,
            },
            uid="42",
            raw_user_text="想听鲁宾斯坦弹的肖邦夜曲",
        )

        self.assertEqual(result.status, "verified")
        self.assertEqual(result.selected_song["id"], "rubinstein")
        self.assertEqual(result.url, "/api/radio/audio/rubinstein")
        self.assertEqual([call["keywords"] for call in netease.search_calls], ["Arthur Rubinstein Chopin Nocturne"])
        self.assertNotIn("想听鲁宾斯坦弹的肖邦夜曲", [call["keywords"] for call in netease.search_calls])

    async def test_returns_recovery_options_when_no_playable_candidate(self):
        netease = FakeNetease()
        llm = FakeLLM([
            '{"search_queries":["Krystian Zimerman Chopin"]}',
            '{"chosen_id":"","confidence":0.0,"recovery_options":[{"type":"adjacent_version","task":"Zimerman classical piano","reason":"keep performer"}]}',
        ])
        agent = SearchVerifyAgent(llm, netease, FakeResolver())

        result = await agent.verify({"search_goals": ["Krystian Zimerman Chopin"]}, uid="42")

        self.assertEqual(result.status, "not_found")
        self.assertEqual(result.recovery_options[0]["task"], "Zimerman classical piano")
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```powershell
python -X utf8 -m unittest tests.python.test_search_verify_agent
```

Expected: FAIL because module is missing.

- [ ] **Step 3: Implement SearchVerifyAgent**

Create `backend/engines/search_verify_agent.py` with this shape:

```python
from __future__ import annotations

from dataclasses import dataclass, field
import asyncio
import json
import re


@dataclass
class SearchVerification:
    status: str
    selected_song: dict | None = None
    url: str = ""
    verification: dict = field(default_factory=dict)
    fallback_candidates: list[dict] = field(default_factory=list)
    recovery_options: list[dict] = field(default_factory=list)
    failure_reason: str = ""
    used_query: str = ""


class SearchVerifyAgent:
    def __init__(self, llm, netease, audio_resolver, llm_timeout_s: float = 8.0):
        self.llm = llm
        self.netease = netease
        self.audio_resolver = audio_resolver
        self.llm_timeout_s = llm_timeout_s

    async def verify(self, music_task: dict, uid: str | None = None, raw_user_text: str = "") -> SearchVerification:
        queries = await self._queries(music_task, raw_user_text)
        candidates = []
        for query in queries:
            try:
                found = await self.netease.search(query, limit=8)
            except Exception:
                found = []
            for candidate in self._pool_list(found)[:8]:
                if not self._is_bad_candidate(candidate):
                    enriched = dict(candidate)
                    enriched["_source_query"] = query
                    candidates.append(enriched)
        if not candidates:
            return await self._not_found(music_task, queries, "No candidates returned.")

        judgement = await self._judge(music_task, candidates)
        song = self._chosen_song(candidates, judgement)
        if not song:
            return SearchVerification(
                status="not_found",
                failure_reason="No candidate passed verification.",
                recovery_options=self._recovery_options(music_task, judgement),
            )

        resolved = await self.audio_resolver.resolve_with_candidates(song, uid=uid)
        if not getattr(resolved, "ok", False):
            return SearchVerification(
                status="not_found",
                failure_reason="Verified candidate was not playable.",
                recovery_options=self._recovery_options(music_task, judgement),
                used_query=song.get("_source_query", ""),
            )

        selected = dict(song)
        if getattr(resolved, "song_id", ""):
            selected["id"] = getattr(resolved, "song_id")
        return SearchVerification(
            status="verified",
            selected_song=selected,
            url=getattr(resolved, "proxy_url", ""),
            verification={
                "confidence": float(judgement.get("confidence") or 0.0),
                "matched_entities": judgement.get("matched_entities") or [],
                "version_note": str(judgement.get("version_note") or ""),
                "risk": str(judgement.get("risk") or ""),
            },
            fallback_candidates=judgement.get("fallback_candidates") or [],
            used_query=song.get("_source_query", ""),
        )

    async def _queries(self, music_task: dict, raw_user_text: str) -> list[str]:
        goals = [
            self._clean_query(query, raw_user_text)
            for query in music_task.get("search_goals", [])
            if self._clean_query(query, raw_user_text)
        ]
        if goals:
            return self._dedupe(goals)[:6]
        prompt = f"""Create NetEase search queries from this music task.
Do not include the raw user sentence unless it is a canonical music title.

Music task:
{json.dumps(music_task, ensure_ascii=False, indent=2)}

Raw user text:
{raw_user_text}

Return JSON only:
{{"search_queries":["artist title or performer composer work"]}}"""
        try:
            response = await asyncio.wait_for(
                self.llm.chat(prompt, max_tokens=220, system="You create music search queries. Return JSON only."),
                timeout=self.llm_timeout_s,
            )
            data = self._parse_json(response)
        except Exception:
            data = {}
        return self._dedupe([
            self._clean_query(query, raw_user_text)
            for query in data.get("search_queries", [])
            if self._clean_query(query, raw_user_text)
        ])[:6]

    async def _judge(self, music_task: dict, candidates: list[dict]) -> dict:
        prompt = f"""Choose the best verified playable music candidate for this DJ task.

Task:
{json.dumps(music_task, ensure_ascii=False, indent=2)}

Candidates:
{self._candidate_text(candidates)}

Reject playlists, utility audio, study audio, covers unless requested, wrong artists, and wrong classical performers.
Return JSON only:
{{
  "chosen_id": "candidate id or empty",
  "confidence": 0.0,
  "matched_entities": [],
  "version_note": "",
  "risk": "",
  "fallback_candidates": [],
  "recovery_options": []
}}"""
        try:
            response = await asyncio.wait_for(
                self.llm.chat(prompt, max_tokens=360, system="You verify music search results. Return JSON only."),
                timeout=self.llm_timeout_s,
            )
            return self._parse_json(response)
        except Exception:
            return {}

    async def _not_found(self, music_task: dict, queries: list[str], reason: str) -> SearchVerification:
        return SearchVerification(
            status="not_found",
            failure_reason=reason,
            recovery_options=self._recovery_options(music_task, {}),
            used_query=queries[0] if queries else "",
        )

    def _recovery_options(self, music_task: dict, judgement: dict) -> list[dict]:
        options = judgement.get("recovery_options") if isinstance(judgement, dict) else None
        if isinstance(options, list) and options:
            return options[:3]
        entities = music_task.get("primary_entities") if isinstance(music_task, dict) else []
        names = [str(item.get("name")) for item in entities or [] if isinstance(item, dict) and item.get("name")]
        task = " ".join(names + [str(music_task.get("work_hint") or music_task.get("style_hint") or "")]).strip()
        return [{"type": "adjacent_version", "task": task, "reason": "Relax exact version while keeping the musical direction."}] if task else []

    def _chosen_song(self, candidates: list[dict], judgement: dict) -> dict | None:
        chosen_id = str((judgement or {}).get("chosen_id") or "").strip()
        if chosen_id:
            for candidate in candidates:
                if str(candidate.get("id")) == chosen_id:
                    return candidate
        confidence = float((judgement or {}).get("confidence") or 0.0)
        if confidence <= 0 and candidates:
            return None
        return candidates[0] if candidates else None

    def _candidate_text(self, candidates: list[dict]) -> str:
        lines = []
        for index, song in enumerate(candidates[:24]):
            artist = self._artist_name(song)
            album = ""
            if isinstance(song.get("al"), dict):
                album = str(song["al"].get("name") or "")
            lines.append(
                f"{index}. id={song.get('id')} | {song.get('name')} - {artist} | album={album} | source={song.get('_source_query')}"
            )
        return "\n".join(lines)

    def _clean_query(self, value, raw_user_text: str = "") -> str:
        query = " ".join(str(value or "").split())[:120]
        raw = " ".join(str(raw_user_text or "").split())
        if not query:
            return ""
        command_fragments = ("我想听", "想听", "放点", "来点", "不能放点", "给我", "播放")
        if query == raw and any(fragment in raw for fragment in command_fragments):
            return ""
        if query in command_fragments:
            return ""
        return query

    def _is_bad_candidate(self, song: dict) -> bool:
        text = f"{song.get('name', '')} {self._artist_name(song)}".lower()
        bad_tokens = ("歌单", "playlist", "study", "white noise", "sleep music", "伴奏", "karaoke")
        return any(token in text for token in bad_tokens)

    def _artist_name(self, song: dict | None) -> str:
        if not isinstance(song, dict):
            return ""
        artist = song.get("artist")
        if isinstance(artist, str) and artist.strip():
            return artist.strip()
        artists = song.get("ar") or song.get("artists") or []
        if isinstance(artists, list) and artists and isinstance(artists[0], dict):
            return str(artists[0].get("name") or "").strip()
        return ""

    def _pool_list(self, value) -> list[dict]:
        return value if isinstance(value, list) else []

    def _dedupe(self, values: list[str]) -> list[str]:
        result = []
        for value in values:
            if value and value not in result:
                result.append(value)
        return result

    def _parse_json(self, text: str) -> dict:
        raw = str(text or "").strip()
        try:
            return json.loads(raw)
        except Exception:
            match = re.search(r"\{.*\}", raw, re.S)
            if not match:
                return {}
            try:
                return json.loads(match.group(0))
            except Exception:
                return {}
```

- [ ] **Step 4: Run tests**

Run:

```powershell
python -X utf8 -m unittest tests.python.test_search_verify_agent
```

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add backend/engines/search_verify_agent.py tests/python/test_search_verify_agent.py
git commit -m "feat: verify DJ music search results"
```

---

### Task 6: Queue Director

**Files:**

- Create: `backend/engines/queue_director.py`
- Create: `tests/python/test_queue_director.py`

- [ ] **Step 1: Write failing QueueDirector tests**

Create `tests/python/test_queue_director.py`:

```python
import unittest

from backend.engines.playback_queue import PlaybackQueue
from backend.engines.queue_director import QueueDirector
from backend.engines.dj_request_agent import DJDecision
from backend.engines.search_verify_agent import SearchVerification


class FakeMemory:
    def __init__(self):
        self.context_calls = []
        self.update_calls = []

    async def build_context_pack(self, **kwargs):
        self.context_calls.append(kwargs)
        return {"session_working_memory": {}, "user_message": kwargs["user_message"]}

    async def apply_decision_update(self, uid, session_id, request_text, decision):
        self.update_calls.append((uid, session_id, request_text, decision))
        return {"active_mode": {"label": decision.understood_intent, "expires_after_tracks": 4}}


class FakeDJAgent:
    async def decide(self, user_message, context_pack):
        return DJDecision(
            action="set_direction_and_play",
            understood_intent="User wants Radiohead songs.",
            music_task={"search_goals": ["Radiohead Weird Fishes"], "must_not_search_literal_user_sentence": True},
            queue_policy={"duration_tracks": 4, "continue_direction": True},
            uncertainty={"level": "low", "should_ask_user": False},
            dj_response={"speak_now": "懂了，我先接 Radiohead。"},
            memory_update={"session_preference": ["Radiohead"], "negative_constraints": []},
            raw_text=user_message,
        )


class FakeVerifier:
    def __init__(self, result):
        self.result = result
        self.calls = []

    async def verify(self, music_task, uid=None, raw_user_text=""):
        self.calls.append({"music_task": music_task, "uid": uid, "raw_user_text": raw_user_text})
        return self.result


class QueueDirectorTests(unittest.IsolatedAsyncioTestCase):
    async def test_request_clears_stale_ready_items_and_queues_verified_song(self):
        queue = PlaybackQueue(prewarm_depth=3)
        queue.add_ready({"id": "current", "name": "Current"}, "/audio/current")
        queue.promote_next()
        queue.add_ready({"id": "stale", "name": "Stale"}, "/audio/stale")

        verifier = FakeVerifier(SearchVerification(
            status="verified",
            selected_song={"id": "radiohead", "name": "Weird Fishes", "ar": [{"name": "Radiohead"}]},
            url="/api/radio/audio/radiohead",
            verification={"confidence": 0.93},
        ))
        director = QueueDirector(FakeDJAgent(), verifier, FakeMemory())

        result = await director.handle_song_request(
            request_text="不能放点radiohead的吗",
            playback_queue=queue,
            uid="42",
            session_id=7,
            profile={},
            user_settings={},
            playback_context={"current_track": {"id": "current"}},
            recent_turns=[],
        )

        self.assertEqual(result.status, "queued")
        self.assertEqual(result.dj_text, "懂了，我先接 Radiohead。")
        self.assertEqual([item.song["id"] for item in queue.ready_items()], ["radiohead"])
        self.assertEqual(verifier.calls[0]["raw_user_text"], "不能放点radiohead的吗")

    async def test_search_failure_returns_recovery_without_quoting_raw_sentence(self):
        queue = PlaybackQueue(prewarm_depth=3)
        verifier = FakeVerifier(SearchVerification(
            status="not_found",
            failure_reason="No exact version.",
            recovery_options=[{"type": "adjacent_version", "task": "Radiohead songs", "reason": "same artist"}],
        ))
        director = QueueDirector(FakeDJAgent(), verifier, FakeMemory())

        result = await director.handle_song_request(
            request_text="不能放点radiohead的吗",
            playback_queue=queue,
            uid="42",
            session_id=7,
            profile={},
            user_settings={},
            playback_context={},
            recent_turns=[],
        )

        self.assertEqual(result.status, "needs_recovery")
        self.assertNotIn("不能放点radiohead的吗", result.dj_text)
        self.assertEqual(queue.ready_items(), [])
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```powershell
python -X utf8 -m unittest tests.python.test_queue_director
```

Expected: FAIL because `backend.engines.queue_director` is missing.

- [ ] **Step 3: Implement QueueDirector**

Create `backend/engines/queue_director.py`:

```python
from __future__ import annotations

from dataclasses import dataclass, field


@dataclass
class QueueDirectorResult:
    status: str
    dj_text: str = ""
    next_song: dict | None = None
    url: str = ""
    decision: dict = field(default_factory=dict)
    verification: dict = field(default_factory=dict)
    recovery_options: list[dict] = field(default_factory=list)


class QueueDirector:
    def __init__(self, dj_request_agent, search_verify_agent, memory_manager):
        self.dj_request_agent = dj_request_agent
        self.search_verify_agent = search_verify_agent
        self.memory_manager = memory_manager

    async def handle_song_request(
        self,
        request_text: str,
        playback_queue,
        uid: str | None,
        session_id: int | None,
        profile: dict | None,
        user_settings: dict | None,
        playback_context: dict | None,
        recent_turns: list[dict] | None = None,
    ) -> QueueDirectorResult:
        context_pack = await self.memory_manager.build_context_pack(
            uid=uid,
            session_id=session_id,
            user_message=request_text,
            profile=profile,
            user_settings=user_settings,
            playback_context=playback_context or {},
            recent_turns=recent_turns or [],
        )
        decision = await self.dj_request_agent.decide(request_text, context_pack)
        await self.memory_manager.apply_decision_update(uid, session_id, request_text, decision)

        if decision.action == "ask_clarifying_question":
            return QueueDirectorResult(
                status="ask",
                dj_text=self._dj_text(decision),
                decision=decision.to_dict(),
            )

        if decision.action in {"negative_feedback", "revise_mode_and_play", "set_direction_and_play", "play_now", "soft_confirm_and_play", "continue_current_mode"}:
            if hasattr(playback_queue, "clear_ready"):
                playback_queue.clear_ready()

        verification = await self.search_verify_agent.verify(
            decision.music_task,
            uid=uid,
            raw_user_text=request_text,
        )
        if verification.status != "verified" or not verification.selected_song or not verification.url:
            return QueueDirectorResult(
                status="needs_recovery",
                dj_text=self._recovery_text(decision, verification),
                decision=decision.to_dict(),
                recovery_options=verification.recovery_options,
            )

        selected = dict(verification.selected_song)
        selected["selection_reason"] = {
            "type": "dj_agent_verified",
            "text": self._reason_text(decision, verification),
            "understood_intent": decision.understood_intent,
        }
        playback_queue.add_ready(
            selected,
            verification.url,
            selected["selection_reason"],
        )
        return QueueDirectorResult(
            status="queued",
            dj_text=self._dj_text(decision),
            next_song=selected,
            url=verification.url,
            decision=decision.to_dict(),
            verification=verification.verification,
            recovery_options=verification.fallback_candidates,
        )

    def _dj_text(self, decision) -> str:
        response = decision.dj_response if isinstance(decision.dj_response, dict) else {}
        return str(response.get("speak_now") or "我先按我理解到的方向接上。").strip()

    def _reason_text(self, decision, verification) -> str:
        note = ""
        if isinstance(verification.verification, dict):
            note = str(verification.verification.get("version_note") or "").strip()
        return note or str(decision.understood_intent or "DJ agent verified request.")

    def _recovery_text(self, decision, verification) -> str:
        options = verification.recovery_options or []
        if options:
            return "这版我没有拿到稳定播放源，我先沿着同一个音乐方向重新找，不拿刚才那批结果硬接。"
        return "这个我没接稳，先不乱放。"
```

- [ ] **Step 4: Run tests**

Run:

```powershell
python -X utf8 -m unittest tests.python.test_queue_director
```

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add backend/engines/queue_director.py tests/python/test_queue_director.py
git commit -m "feat: orchestrate DJ request queueing"
```

---

### Task 7: Wire New Services in App Startup

**Files:**

- Modify: `backend/main.py`
- Modify: `backend/api/ws.py`
- Create or modify: `tests/python/test_ws_dj_agent_flow.py`

- [ ] **Step 1: Write a wiring smoke test**

Create `tests/python/test_ws_dj_agent_flow.py` with a simple module-level wiring assertion:

```python
import unittest


class DJAgentWiringTests(unittest.TestCase):
    def test_ws_module_exposes_new_dj_agent_globals(self):
        from backend.api import ws

        self.assertTrue(hasattr(ws, "dj_request_agent"))
        self.assertTrue(hasattr(ws, "search_verify_agent"))
        self.assertTrue(hasattr(ws, "queue_director"))
        self.assertTrue(hasattr(ws, "dj_memory_manager"))
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```powershell
python -X utf8 -m unittest tests.python.test_ws_dj_agent_flow.DJAgentWiringTests.test_ws_module_exposes_new_dj_agent_globals
```

Expected: FAIL because globals are missing.

- [ ] **Step 3: Add globals to `backend/api/ws.py`**

At the top of `backend/api/ws.py`, replace or extend globals:

```python
dj_request_agent = None
search_verify_agent = None
queue_director = None
dj_memory_manager = None
```

Keep `request_agent` and `radio_brain` only until old tests are migrated.

- [ ] **Step 4: Instantiate services in `backend/main.py`**

Imports:

```python
from backend.memory.dj_memory import DJMemoryManager
from backend.engines.dj_request_agent import DJRequestAgent
from backend.engines.search_verify_agent import SearchVerifyAgent
from backend.engines.queue_director import QueueDirector
```

Inside `lifespan()` after `audio_resolver`:

```python
dj_memory_manager = DJMemoryManager(store)
dj_request_agent = DJRequestAgent(llm_router, llm_timeout_s=8.0)
search_verify_agent = SearchVerifyAgent(
    llm_router,
    netease_adapter,
    audio_resolver,
    llm_timeout_s=8.0,
)
queue_director = QueueDirector(
    dj_request_agent,
    search_verify_agent,
    dj_memory_manager,
)
```

Wire:

```python
ws.dj_memory_manager = dj_memory_manager
ws.dj_request_agent = dj_request_agent
ws.search_verify_agent = search_verify_agent
ws.queue_director = queue_director
```

- [ ] **Step 5: Run wiring smoke test**

Run:

```powershell
python -X utf8 -m unittest tests.python.test_ws_dj_agent_flow.DJAgentWiringTests.test_ws_module_exposes_new_dj_agent_globals
```

Expected: PASS.

- [ ] **Step 6: Commit**

```powershell
git add backend/main.py backend/api/ws.py tests/python/test_ws_dj_agent_flow.py
git commit -m "feat: wire DJ request services"
```

---

### Task 8: WebSocket Song Request Cutover

**Files:**

- Modify: `backend/api/ws.py`
- Modify: `tests/python/test_ws_dj_agent_flow.py`
- Modify as needed: `tests/python/test_ws_user_settings.py`

- [ ] **Step 1: Add WebSocket cutover test**

Extend `tests/python/test_ws_dj_agent_flow.py`:

```python
import asyncio
import json
import unittest

from backend.api import auth, ws


class FakeWebSocket:
    def __init__(self, messages):
        self.messages = [json.dumps(message) for message in messages]
        self.sent = []
        self.accepted = False

    async def accept(self):
        self.accepted = True

    async def iter_text(self):
        for message in self.messages:
            yield message

    async def send_json(self, payload):
        self.sent.append(payload)


class FakeStore:
    async def get_user_settings(self, uid):
        return {"voice_preset": "warm_male"}

    async def get_profile(self, uid):
        return {"radio_insights": {"taste_summary": "likes textured music"}}

    async def create_session(self, uid):
        return 7

    async def log_track(self, track_id, name, artist, source, uid=None):
        pass

    async def log_playback_event(self, event_type, song_id=None, uid=None, reason=""):
        pass

    async def get_recent_playable_tracks(self, uid=None, limit=20):
        return []


class FakeDJEngine:
    def detect_scene(self, utc_offset):
        return "daily"

    async def generate_intro(self, profile, scene, user_settings=None):
        return ""

    async def generate_program_break(self, *args, **kwargs):
        return ""


class FakeTTS:
    async def synthesize(self, text, style="daily", voice_preset=None, user_settings=None):
        return b"audio"

    def _hash(self, text, style, voice_preset=None, user_settings=None):
        return f"hash-{text}"


class FakeScheduler:
    def new_session_state(self):
        return {}

    async def pick_next(self, *args, **kwargs):
        return {"id": "first", "name": "First", "ar": [{"name": "Artist"}]}

    async def get_song_url(self, song):
        return f"https://example.test/{song['id']}.mp3"


class FakeQueueDirector:
    def __init__(self):
        self.calls = []

    async def handle_song_request(self, **kwargs):
        self.calls.append(kwargs)
        kwargs["playback_queue"].clear_ready()
        song = {
            "id": "radiohead",
            "name": "Weird Fishes",
            "ar": [{"name": "Radiohead"}],
            "selection_reason": {"type": "dj_agent_verified", "text": "verified"},
        }
        kwargs["playback_queue"].add_ready(song, "/api/radio/audio/radiohead", song["selection_reason"])
        return type("Result", (), {
            "status": "queued",
            "dj_text": "懂了，我先接 Radiohead。",
            "next_song": song,
            "url": "/api/radio/audio/radiohead",
            "decision": {"action": "set_direction_and_play"},
        })()


class DJAgentWebSocketFlowTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.originals = {
            "store": ws.store,
            "dj_engine": ws.dj_engine,
            "tts": ws.tts,
            "scheduler": ws.scheduler,
            "compressor": ws.compressor,
            "profile_engine": ws.profile_engine,
            "audio_resolver": ws.audio_resolver,
            "request_agent": ws.request_agent,
            "radio_brain": ws.radio_brain,
            "queue_director": getattr(ws, "queue_director", None),
            "auth_netease": auth.netease,
        }
        self.addCleanup(self.restore)

    def restore(self):
        for key, value in self.originals.items():
            if key == "auth_netease":
                auth.netease = value
            else:
                setattr(ws, key, value)

    async def test_song_request_uses_queue_director_not_radio_brain_or_old_request_agent(self):
        fake_director = FakeQueueDirector()
        fake_websocket = FakeWebSocket([
            {"type": "handshake", "uid": "42", "settings": {}},
            {"type": "song_request", "text": "不能放点radiohead的吗"},
        ])

        ws.store = FakeStore()
        ws.dj_engine = FakeDJEngine()
        ws.tts = FakeTTS()
        ws.scheduler = FakeScheduler()
        ws.compressor = type("Compressor", (), {"add_round": lambda self, payload: None})()
        ws.profile_engine = None
        ws.audio_resolver = None
        ws.request_agent = object()
        ws.radio_brain = object()
        ws.queue_director = fake_director

        await asyncio.wait_for(ws.ws_handler(fake_websocket), timeout=1.0)

        self.assertEqual(fake_director.calls[0]["request_text"], "不能放点radiohead的吗")
        sent_types = [payload["type"] for payload in fake_websocket.sent]
        self.assertIn("dj_message", sent_types)
        self.assertIn("request_status", sent_types)
        status = [payload for payload in fake_websocket.sent if payload["type"] == "request_status"][-1]
        self.assertEqual(status["status"], "ready")
        self.assertEqual(status["next_track"]["id"], "radiohead")
```

- [ ] **Step 2: Run cutover test to verify it fails**

Run:

```powershell
python -X utf8 -m unittest tests.python.test_ws_dj_agent_flow.DJAgentWebSocketFlowTests.test_song_request_uses_queue_director_not_radio_brain_or_old_request_agent
```

Expected: FAIL because `song_request` still uses old branch.

- [ ] **Step 3: Add helper to build playback context**

In `backend/api/ws.py`, add a small local helper near other nested helpers in `ws_handler`:

```python
def dj_playback_context() -> dict:
    return {
        "current_track": _track_info(current_song) if current_song else {},
        "recent_tracks": [_track_info(song) for song in played_songs[-5:]],
        "ready_queue": [_track_info(item.song) for item in playback_queue.ready_items()],
        "scene": scene,
    }
```

- [ ] **Step 4: Replace `song_request` branch**

In `backend/api/ws.py`, inside `elif msg_type == "song_request":`, keep:

- request text normalization
- prewarm cancellation
- ready queue clearing
- playback event logging

Then replace `RadioBrain` / `SongRequestAgent` / scheduler intent branching with:

```python
if queue_director:
    result = await queue_director.handle_song_request(
        request_text=request_text,
        playback_queue=playback_queue,
        uid=str(uid) if uid else None,
        session_id=session_id,
        profile=profile,
        user_settings=user_settings,
        playback_context=dj_playback_context(),
        recent_turns=compressor.get_context() if hasattr(compressor, "get_context") else [],
    )
    if result.dj_text:
        tts_hash_val = await synthesize_intro_text(result.dj_text)
        await websocket.send_json({
            "type": "dj_message",
            "text": result.dj_text,
            "tts_ready": bool(tts_hash_val),
            "tts_hash": tts_hash_val,
        })
    if result.status == "queued":
        await websocket.send_json(request_status_for_ready_item(request_text))
        await fill_queue(max_items=1, allow_program_break=False)
        continue
    if result.status == "ask":
        await websocket.send_json({
            "type": "request_status",
            "status": "needs_clarification",
            "text": result.dj_text,
        })
        continue
    await websocket.send_json({
        "type": "request_status",
        "status": "not_found",
        "text": result.dj_text or "这个我没接稳，先不乱放。",
    })
    continue
```

Then adjust `request_status_for_ready_item()` to treat reason type `dj_agent_verified` as a first-class ready status:

```python
if reason_type == "dj_agent_verified":
    return {
        "type": "request_status",
        "status": "ready",
        "text": f"我先接这首：{track['name']}。",
        "next_track": track,
    }
```

Do not keep the old positive-request `RadioBrain` route in the new branch. It can remain only as unreachable legacy fallback if `queue_director` is `None` during tests.

- [ ] **Step 5: Run cutover tests**

Run:

```powershell
python -X utf8 -m unittest tests.python.test_ws_dj_agent_flow
```

Expected: PASS.

- [ ] **Step 6: Run existing WebSocket tests and rewrite obsolete expectations**

Run:

```powershell
python -X utf8 -m unittest tests.python.test_ws_user_settings
```

Expected initially: some old `radio_brain` / `request_agent` expectations fail. Rewrite those tests to assert:

- `queue_director.handle_song_request()` is called for positive song requests.
- Old `request_agent.resolve()` is not called for positive requests.
- Old `radio_brain.interpret_user_text()` is not called for positive requests.
- Ready queue contains the director-provided verified track.
- Failure messages do not include "没找到特别准的" or raw user text.

- [ ] **Step 7: Commit**

```powershell
git add backend/api/ws.py tests/python/test_ws_dj_agent_flow.py tests/python/test_ws_user_settings.py
git commit -m "feat: route song requests through DJ agent flow"
```

---

### Task 9: Scheduler Active-Mode Cleanup

**Files:**

- Modify: `backend/engines/scheduler.py`
- Modify: `tests/python/test_scheduler_personalized_pick.py`
- Create or modify: `tests/python/test_queue_director.py`

- [ ] **Step 1: Add regression test that scheduler does not parse new DJ request mode**

Add to `tests/python/test_scheduler_personalized_pick.py`:

```python
async def test_scheduler_ignores_dj_agent_mode_for_natural_language_parsing(self):
    scheduler = self.make_scheduler()
    state = scheduler.new_session_state()
    user_settings = {
        "dj_agent": {
            "active_mode": {
                "label": "Radiohead direction",
                "expires_after_tracks": 3,
            }
        }
    }

    intent = scheduler.apply_listening_intent(
        state,
        "不能放点radiohead的吗",
        user_settings=user_settings,
    )

    self.assertEqual(intent["keywords"], "")
```

If `apply_listening_intent` is no longer needed after the WebSocket cutover, make the test assert it is not used in the new WebSocket path instead. Do not add new rules to parse Radiohead or any other entity.

- [ ] **Step 2: Run targeted scheduler test**

Run:

```powershell
python -X utf8 -m unittest tests.python.test_scheduler_personalized_pick.SchedulerPersonalizedPickTests.test_scheduler_ignores_dj_agent_mode_for_natural_language_parsing
```

Expected: FAIL under current behavior if scheduler still derives raw keywords.

- [ ] **Step 3: Bypass natural-language parsing when `user_settings["dj_agent"]` exists**

In `backend/engines/scheduler.py`, keep fallback behavior but ensure active DJ mode is not treated as raw search intent:

```python
def _dj_agent_mode(self, user_settings: dict | None) -> dict:
    if not isinstance(user_settings, dict):
        return {}
    dj_state = user_settings.get("dj_agent")
    if not isinstance(dj_state, dict):
        return {}
    mode = dj_state.get("active_mode")
    return mode if isinstance(mode, dict) else {}
```

At the top of `apply_listening_intent()`:

```python
if self._dj_agent_mode(user_settings):
    intent = {"raw_text": clean_text, "keywords": "", "mood": ""}
    if session_state:
        session_state.listening_intent = intent
        session_state.intent_picks_remaining = 0
    if isinstance(user_settings, dict):
        user_settings["listening_intent"] = intent
    return intent
```

This is a compatibility guard, not a new interpretation feature.

- [ ] **Step 4: Run scheduler tests**

Run:

```powershell
python -X utf8 -m unittest tests.python.test_scheduler_personalized_pick
```

Expected: PASS after obsolete old-intent tests are rewritten or removed.

- [ ] **Step 5: Commit**

```powershell
git add backend/engines/scheduler.py tests/python/test_scheduler_personalized_pick.py
git commit -m "refactor: keep scheduler out of DJ request interpretation"
```

---

### Task 10: DJ Probe Matrix

**Files:**

- Create: `tests/python/test_dj_agent_probe_matrix.py`

- [ ] **Step 1: Write probe matrix tests using fake LLM decisions**

Create `tests/python/test_dj_agent_probe_matrix.py`:

```python
import json
import unittest

from backend.engines.dj_request_agent import DJRequestAgent


class MappingLLM:
    def __init__(self, mapping):
        self.mapping = mapping
        self.calls = []

    async def chat(self, prompt, max_tokens=300, system=None):
        self.calls.append(prompt)
        for key, value in self.mapping.items():
            if key in prompt:
                return json.dumps(value, ensure_ascii=False)
        return json.dumps({
            "action": "ask_clarifying_question",
            "understood_intent": "unclear",
            "music_task": {"type": "unclear", "search_goals": [], "must_not_search_literal_user_sentence": True},
            "queue_policy": {"duration_tracks": 0, "continue_direction": False},
            "uncertainty": {"level": "high", "should_ask_user": True},
            "dj_response": {"speak_now": "这个我没接稳。"},
            "memory_update": {"session_preference": [], "negative_constraints": []},
        }, ensure_ascii=False)


class DJAgentProbeMatrixTests(unittest.IsolatedAsyncioTestCase):
    async def test_varied_requests_become_structured_music_tasks(self):
        mapping = {
            "齐默尔曼的肖邦": self._decision("artist_work_direction", ["Krystian Zimerman", "Frederic Chopin"], ["Zimerman Chopin Ballade"], 4),
            "鲁宾斯坦弹的肖邦夜曲": self._decision("specific_performer_work_family", ["Arthur Rubinstein", "Frederic Chopin"], ["Arthur Rubinstein Chopin Nocturne"], 3),
            "霍洛维茨的拉赫玛尼诺夫": self._decision("artist_work_direction", ["Vladimir Horowitz", "Sergei Rachmaninoff"], ["Horowitz Rachmaninoff Piano Concerto"], 3),
            "海菲兹的柴可夫斯基小协": self._decision("specific_performer_work_family", ["Jascha Heifetz", "Pyotr Ilyich Tchaikovsky"], ["Heifetz Tchaikovsky Violin Concerto"], 3),
            "Bill Evans的爵士": self._decision("artist_direction", ["Bill Evans"], ["Bill Evans Waltz for Debby"], 4),
            "下午想听点rnb": self._decision("scene_genre_direction", ["R&B"], ["SZA Good Days", "Daniel Caesar Best Part"], 6),
        }
        agent = DJRequestAgent(MappingLLM(mapping))

        for raw in mapping:
            with self.subTest(raw=raw):
                decision = await agent.decide(raw, context_pack={"session_working_memory": {}})
                self.assertNotEqual(decision.action, "ask_clarifying_question")
                self.assertTrue(decision.music_task["search_goals"])
                self.assertNotIn(raw, decision.music_task["search_goals"])
                self.assertTrue(decision.music_task["must_not_search_literal_user_sentence"])
                self.assertGreaterEqual(decision.queue_policy["duration_tracks"], 3)

    def _decision(self, task_type, names, queries, duration):
        return {
            "action": "set_direction_and_play",
            "understood_intent": " / ".join(names),
            "music_task": {
                "type": task_type,
                "primary_entities": [{"role": "music_entity", "name": name} for name in names],
                "search_goals": queries,
                "must_not_search_literal_user_sentence": True,
            },
            "queue_policy": {"duration_tracks": duration, "continue_direction": True},
            "uncertainty": {"level": "low", "should_ask_user": False},
            "dj_response": {"speak_now": "懂了，我先接这条线。"},
            "memory_update": {"session_preference": names, "negative_constraints": []},
        }
```

- [ ] **Step 2: Run probe matrix**

Run:

```powershell
python -X utf8 -m unittest tests.python.test_dj_agent_probe_matrix
```

Expected: PASS.

- [ ] **Step 3: Commit**

```powershell
git add tests/python/test_dj_agent_probe_matrix.py
git commit -m "test: add DJ agent probe matrix"
```

---

### Task 11: End-to-End Backend Verification

**Files:**

- Modify as needed: `tests/python/test_ws_dj_agent_flow.py`
- Modify as needed: `tests/python/test_ws_user_settings.py`
- Modify as needed: `tests/python/test_song_request_agent.py`
- Modify as needed: `tests/python/test_radio_brain.py`

- [ ] **Step 1: Run focused new-flow tests**

Run:

```powershell
python -X utf8 -m unittest `
  tests.python.test_dj_request_agent `
  tests.python.test_search_verify_agent `
  tests.python.test_dj_memory `
  tests.python.test_queue_director `
  tests.python.test_ws_dj_agent_flow `
  tests.python.test_dj_agent_probe_matrix
```

Expected: PASS.

- [ ] **Step 2: Run existing Python suite**

Run:

```powershell
python -X utf8 -m unittest discover tests/python
```

Expected: PASS after updating tests that assumed old positive-request `RadioBrain` / `SongRequestAgent` behavior.

Rules for test updates:

- Keep tests for `SongRequestAgent` only if it remains as a low-level search helper.
- Do not add new entity alias tests to `RadioBrain`.
- Rewrite WebSocket tests around `queue_director` and `dj_agent_verified`.
- Preserve playback, TTS, auth, audio resolver, and onboarding tests.

- [ ] **Step 3: Run JS tests**

Run:

```powershell
node --test tests/js/radio-websocket.test.mjs
node --test netease-bridge/auth-state.test.mjs netease-bridge/song-url.test.mjs
```

Expected: PASS.

- [ ] **Step 4: Start backend for manual backend-level probes**

Use the existing worktree environment. If port `8001` is already running for this branch, reuse it; otherwise start the backend on `8001`.

Run whichever project command is already used in this repo. If uncertain, inspect the running command from terminal history or README before starting a new process.

Expected: app responds at `http://127.0.0.1:8001/health`.

- [ ] **Step 5: Run direct backend probes without browser**

Use direct WebSocket or engine-level probes against the backend path. Probe at least:

```text
不能放点radiohead的吗
我要听齐默尔曼的肖邦
想听鲁宾斯坦弹的肖邦夜曲
来点霍洛维茨的拉赫玛尼诺夫
我想听海菲兹的柴可夫斯基小协
下午想听点rnb
还是刚才那个方向，但别这么吵
不是这个版本
```

Expected for each:

- DJ decision is structured.
- Raw user sentence is not used as the NetEase search query.
- If a candidate is found, it is verified and queued.
- If no candidate is found, the response speaks about the understood music direction, not the raw sentence.
- Session memory active mode is updated or revised.

- [ ] **Step 6: Commit final test fixes**

```powershell
git add backend tests
git commit -m "test: verify DJ agent request flow"
```

---

### Task 12: Legacy Cleanup and Documentation Notes

**Files:**

- Modify: `README.md` if it still describes the old request flow.
- Modify: `docs/superpowers/specs/2026-05-27-dj-agent-request-flow-design.md` only if implementation changes the design.
- Modify: `backend/main.py`
- Modify: `backend/api/ws.py`

- [ ] **Step 1: Remove unused main wiring only after tests pass**

If no tests or code path need old globals, remove:

```python
from backend.engines.song_request_agent import SongRequestAgent
from backend.engines.radio_brain import RadioBrain
```

and the corresponding construction/wiring in `backend/main.py`.

If old modules remain for standalone tests, leave the modules in the repository but do not wire them into the positive request path.

- [ ] **Step 2: Remove unreachable old WebSocket positive-request code**

In `backend/api/ws.py`, remove unreachable code branches that:

- call `radio_brain.interpret_user_text()` for positive requests
- call `request_agent.resolve()` for positive requests
- call `scheduler.apply_listening_intent()` for positive requests

Keep skip learning only if it is rewritten through `DJMemoryManager` or remains independent of request interpretation.

- [ ] **Step 3: Update README architecture summary**

If README still says the radio uses raw `RadioBrain` request routing, update it to:

```markdown
Song requests are handled by a DJ request agent that produces structured music tasks.
Search and version verification are delegated to a separate verifier, while queue continuity is managed by a queue director with bounded session memory.
```

- [ ] **Step 4: Run full verification one more time**

Run:

```powershell
python -X utf8 -m unittest discover tests/python
node --test tests/js/radio-websocket.test.mjs
node --test netease-bridge/auth-state.test.mjs netease-bridge/song-url.test.mjs
```

Expected: PASS.

- [ ] **Step 5: Commit cleanup**

```powershell
git add backend README.md docs tests
git commit -m "refactor: retire legacy song request routing"
```

---

## Completion Checklist

- [ ] `DJRequestAgent` is the only positive user request interpreter in the WebSocket path.
- [ ] `SearchVerifyAgent` uses DJ music tasks, not raw user sentences.
- [ ] `QueueDirector` clears stale ready queue items and queues verified results.
- [ ] Session active mode can persist for multiple tracks.
- [ ] Memory context pack remains bounded.
- [ ] Negative feedback revises queue/mode immediately.
- [ ] Failure text never says "not found: <raw user sentence>".
- [ ] Probe matrix covers varied artists, performers, composers, genres, scenes, corrections, and ambiguous titles.
- [ ] Full Python and JS tests pass.

## Execution Notes

Use small commits exactly as described. If a task exposes old partial changes from the previous repair attempt, handle them in that task instead of reverting them globally. The product goal is not to preserve old `RadioBrain` behavior; it is to replace the positive request path with the DJ agent architecture approved in the spec.

