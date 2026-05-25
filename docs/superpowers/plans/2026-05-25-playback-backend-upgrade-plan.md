# Playback Backend Upgrade Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a more stable and continuous AI radio backend with audio proxying, a prewarmed queue, restrained DJ cadence, and simplified two-voice onboarding.

**Architecture:** Keep the existing FastAPI, WebSocket, SQLite, scheduler, DJ, and NetEase bridge shape. Add focused backend modules for audio resolution and session queue orchestration, then connect them to the existing WebSocket flow. Keep frontend changes minimal and only update onboarding choices and endpoint usage needed for playback.

**Tech Stack:** Python 3.12, FastAPI, aiosqlite, httpx, existing Node NetEase bridge, existing browser frontend JavaScript.

---

## File Structure

- Create `backend/engines/audio_resolver.py`: resolves song audio URLs with fallback order, caches successful URLs, records failures, and creates local proxy URLs.
- Create `backend/engines/playback_queue.py`: manages an in-memory per-session queue with prewarm depth and item states.
- Modify `backend/memory/models.py`: add audio resolution cache and playback event tables.
- Modify `backend/memory/store.py`: add methods for audio cache, failed track lookup, and playback event logging.
- Modify `backend/adapters/netease.py`: add search support and optional metadata-aware URL lookup.
- Modify `backend/api/radio.py`: add `/api/radio/audio/{song_id}` proxy endpoint and simplify onboarding voice presets.
- Modify `backend/api/ws.py`: use playback queue and audio resolver for session start, track end, and skip.
- Modify `backend/engines/dj.py`: add concise segue cadence support using selection reason.
- Modify `frontend/index.html` and `frontend/js/radio.js`: reduce onboarding voice options to two choices and map existing labels to new presets.
- Add tests in `tests/python/` for resolver fallback, queue prewarm/promotion, onboarding presets, and DJ cadence.
- Update existing JS test fixture only if simplified onboarding DOM requires it.

---

### Task 1: Audio Resolution Storage

**Files:**
- Modify: `backend/memory/models.py`
- Modify: `backend/memory/store.py`
- Test: `tests/python/test_audio_resolution_store.py`

- [ ] **Step 1: Write failing storage tests**

Create `tests/python/test_audio_resolution_store.py`:

```python
import os
import tempfile
import unittest

from backend.memory.models import init_db
from backend.memory.store import MemoryStore


class AudioResolutionStoreTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        os.environ["RADIO_DB_PATH"] = os.path.join(self.tmp.name, "radio.db")
        await init_db()
        self.store = MemoryStore()

    async def asyncTearDown(self):
        self.tmp.cleanup()
        os.environ.pop("RADIO_DB_PATH", None)

    async def test_audio_cache_round_trip(self):
        await self.store.save_audio_resolution(
            song_id="42",
            url="https://example.test/42.mp3",
            source="song_url",
            content_type="audio/mpeg",
        )

        cached = await self.store.get_audio_resolution("42")

        self.assertEqual(cached["song_id"], "42")
        self.assertEqual(cached["url"], "https://example.test/42.mp3")
        self.assertEqual(cached["source"], "song_url")
        self.assertEqual(cached["content_type"], "audio/mpeg")

    async def test_failed_track_blocks_recent_replay(self):
        await self.store.log_playback_event(
            uid="u1",
            song_id="bad",
            event_type="url_failed",
            reason="empty_url",
        )

        self.assertTrue(await self.store.was_track_recently_failed("bad", uid="u1"))
        self.assertFalse(await self.store.was_track_recently_failed("other", uid="u1"))
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest tests\python\test_audio_resolution_store.py`

Expected: FAIL because `save_audio_resolution`, `get_audio_resolution`, `log_playback_event`, and `was_track_recently_failed` do not exist.

- [ ] **Step 3: Add database tables**

In `backend/memory/models.py`, inside `init_db()` SQL script, add:

```sql
CREATE TABLE IF NOT EXISTS audio_resolution_cache (
    song_id TEXT PRIMARY KEY,
    url TEXT NOT NULL,
    source TEXT NOT NULL,
    content_type TEXT,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS playback_event (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    uid TEXT,
    song_id TEXT,
    event_type TEXT NOT NULL,
    reason TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_playback_event_song ON playback_event(song_id, created_at);
CREATE INDEX IF NOT EXISTS idx_playback_event_uid_song ON playback_event(uid, song_id, created_at);
```

- [ ] **Step 4: Add store methods**

In `backend/memory/store.py`, add methods:

```python
    async def save_audio_resolution(
        self,
        song_id: str,
        url: str,
        source: str,
        content_type: str = "",
    ) -> None:
        async with connect_db() as db:
            await db.execute(
                "INSERT INTO audio_resolution_cache (song_id, url, source, content_type, updated_at) "
                "VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP) "
                "ON CONFLICT(song_id) DO UPDATE SET url=excluded.url, source=excluded.source, "
                "content_type=excluded.content_type, updated_at=CURRENT_TIMESTAMP",
                (str(song_id), url, source, content_type),
            )
            await db.commit()

    async def get_audio_resolution(self, song_id: str) -> dict | None:
        async with connect_db() as db:
            async with db.execute(
                "SELECT song_id, url, source, content_type, updated_at FROM audio_resolution_cache WHERE song_id=?",
                (str(song_id),),
            ) as cursor:
                row = await cursor.fetchone()
                if not row:
                    return None
                return {
                    "song_id": row[0],
                    "url": row[1],
                    "source": row[2],
                    "content_type": row[3] or "",
                    "updated_at": row[4],
                }

    async def log_playback_event(
        self,
        event_type: str,
        song_id: str | None = None,
        uid: str | None = None,
        reason: str = "",
    ) -> None:
        async with connect_db() as db:
            await db.execute(
                "INSERT INTO playback_event (uid, song_id, event_type, reason) VALUES (?, ?, ?, ?)",
                (str(uid) if uid else None, str(song_id) if song_id else None, event_type, reason),
            )
            await db.commit()

    async def was_track_recently_failed(
        self,
        song_id: str,
        uid: str | None = None,
        limit: int = 50,
    ) -> bool:
        async with connect_db() as db:
            if uid:
                async with db.execute(
                    "SELECT 1 FROM playback_event WHERE uid=? AND song_id=? "
                    "AND event_type IN ('url_failed', 'playback_failed') "
                    "ORDER BY created_at DESC LIMIT ?",
                    (str(uid), str(song_id), limit),
                ) as cursor:
                    return await cursor.fetchone() is not None
            async with db.execute(
                "SELECT 1 FROM playback_event WHERE song_id=? "
                "AND event_type IN ('url_failed', 'playback_failed') "
                "ORDER BY created_at DESC LIMIT ?",
                (str(song_id), limit),
            ) as cursor:
                return await cursor.fetchone() is not None
```

- [ ] **Step 5: Run test to verify it passes**

Run: `python -m pytest tests\python\test_audio_resolution_store.py`

Expected: PASS.

---

### Task 2: Audio Resolver

**Files:**
- Create: `backend/engines/audio_resolver.py`
- Modify: `backend/adapters/netease.py`
- Test: `tests/python/test_audio_resolver.py`

- [ ] **Step 1: Write failing resolver tests**

Create `tests/python/test_audio_resolver.py`:

```python
import unittest

from backend.engines.audio_resolver import AudioResolver


class FakeNetease:
    def __init__(self):
        self.urls = {}
        self.search_results = []

    async def song_url(self, song_id):
        return self.urls.get(str(song_id), "")

    async def search(self, keywords, limit=5):
        return self.search_results[:limit]


class FakeStore:
    def __init__(self):
        self.cache = {}
        self.events = []

    async def get_audio_resolution(self, song_id):
        return self.cache.get(str(song_id))

    async def save_audio_resolution(self, song_id, url, source, content_type=""):
        self.cache[str(song_id)] = {
            "song_id": str(song_id),
            "url": url,
            "source": source,
            "content_type": content_type,
        }

    async def log_playback_event(self, event_type, song_id=None, uid=None, reason=""):
        self.events.append({
            "event_type": event_type,
            "song_id": song_id,
            "uid": uid,
            "reason": reason,
        })


class AudioResolverTests(unittest.IsolatedAsyncioTestCase):
    async def test_uses_cached_resolution_first(self):
        netease = FakeNetease()
        store = FakeStore()
        store.cache["42"] = {"song_id": "42", "url": "https://cached.test/a.mp3", "source": "cache"}
        resolver = AudioResolver(netease, store)

        resolved = await resolver.resolve({"id": "42", "name": "A", "artist": "B"})

        self.assertEqual(resolved.url, "https://cached.test/a.mp3")
        self.assertEqual(resolved.source, "cache")

    async def test_falls_back_to_search_candidate_when_primary_is_empty(self):
        netease = FakeNetease()
        netease.urls = {"1": "", "2": "https://cdn.test/2.mp3"}
        netease.search_results = [{"id": "2", "name": "Song", "ar": [{"name": "Artist"}]}]
        store = FakeStore()
        resolver = AudioResolver(netease, store)

        resolved = await resolver.resolve({"id": "1", "name": "Song", "ar": [{"name": "Artist"}]})

        self.assertEqual(resolved.song_id, "2")
        self.assertEqual(resolved.url, "https://cdn.test/2.mp3")
        self.assertEqual(resolved.source, "search_candidate")

    async def test_logs_failure_when_no_candidate_resolves(self):
        netease = FakeNetease()
        netease.urls = {"1": ""}
        store = FakeStore()
        resolver = AudioResolver(netease, store)

        resolved = await resolver.resolve({"id": "1", "name": "Song"}, uid="u1")

        self.assertFalse(resolved.ok)
        self.assertEqual(store.events[-1]["event_type"], "url_failed")
        self.assertEqual(store.events[-1]["reason"], "empty_url")
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest tests\python\test_audio_resolver.py`

Expected: FAIL because `backend.engines.audio_resolver` does not exist.

- [ ] **Step 3: Add NetEase search adapter**

In `backend/adapters/netease.py`, add:

```python
    async def search(self, keywords: str, limit: int = 5) -> list[dict]:
        try:
            r = await self.client.get(
                f"{BASE}/search",
                params={"keywords": keywords, "limit": limit},
                timeout=10.0,
            )
            data = r.json()
            result = data.get("result", {}) if isinstance(data, dict) else {}
            return result.get("songs", []) if isinstance(result, dict) else []
        except Exception:
            return []
```

- [ ] **Step 4: Implement resolver**

Create `backend/engines/audio_resolver.py`:

```python
from dataclasses import dataclass


@dataclass
class AudioResolution:
    ok: bool
    song_id: str
    url: str = ""
    source: str = ""
    content_type: str = ""
    reason: str = ""

    @property
    def proxy_url(self) -> str:
        return f"/api/radio/audio/{self.song_id}" if self.ok and self.song_id else ""


class AudioResolver:
    def __init__(self, netease, store):
        self.netease = netease
        self.store = store

    async def resolve(self, song: dict, uid: str | None = None) -> AudioResolution:
        song_id = self._song_id(song)
        if not song_id:
            return AudioResolution(False, "", reason="missing_song_id")

        cached = await self.store.get_audio_resolution(song_id)
        if cached and cached.get("url"):
            return AudioResolution(
                True,
                song_id,
                cached["url"],
                cached.get("source", "cache"),
                cached.get("content_type", ""),
            )

        direct = await self._try_song_url(song_id, "song_url")
        if direct.ok:
            await self._cache(direct)
            return direct

        outer_url = f"https://music.163.com/song/media/outer/url?id={song_id}.mp3"
        outer = AudioResolution(True, song_id, outer_url, "outer_url", "audio/mpeg")
        await self._cache(outer)
        return outer

    async def resolve_with_candidates(
        self,
        song: dict,
        uid: str | None = None,
    ) -> AudioResolution:
        first = await self.resolve(song, uid=uid)
        if first.ok and first.source != "outer_url":
            return first

        query = self._query(song)
        if query:
            for candidate in await self.netease.search(query, limit=5):
                candidate_id = self._song_id(candidate)
                if not candidate_id or candidate_id == self._song_id(song):
                    continue
                candidate_resolution = await self._try_song_url(candidate_id, "search_candidate")
                if candidate_resolution.ok:
                    await self._cache(candidate_resolution)
                    return candidate_resolution

        if first.ok:
            return first

        await self.store.log_playback_event(
            "url_failed",
            song_id=self._song_id(song),
            uid=uid,
            reason=first.reason or "empty_url",
        )
        return first

    async def _try_song_url(self, song_id: str, source: str) -> AudioResolution:
        try:
            url = await self.netease.song_url(song_id)
        except Exception:
            return AudioResolution(False, song_id, source=source, reason="timeout")
        if not url:
            return AudioResolution(False, song_id, source=source, reason="empty_url")
        return AudioResolution(True, song_id, url, source, "audio/mpeg")

    async def _cache(self, resolved: AudioResolution) -> None:
        await self.store.save_audio_resolution(
            resolved.song_id,
            resolved.url,
            resolved.source,
            resolved.content_type,
        )

    def _song_id(self, song: dict | None) -> str:
        if not isinstance(song, dict):
            return ""
        value = song.get("id")
        return str(value).strip() if value is not None else ""

    def _artist_name(self, song: dict | None) -> str:
        if not isinstance(song, dict):
            return ""
        artist = song.get("artist")
        if isinstance(artist, str) and artist.strip():
            return artist.strip()
        for key in ("ar", "artists"):
            artists = song.get(key)
            if isinstance(artists, list) and artists:
                first = artists[0]
                if isinstance(first, dict):
                    name = first.get("name")
                    if isinstance(name, str):
                        return name.strip()
        return ""

    def _query(self, song: dict | None) -> str:
        if not isinstance(song, dict):
            return ""
        name = str(song.get("name") or "").strip()
        artist = self._artist_name(song)
        return f"{artist} {name}".strip()
```

- [ ] **Step 5: Run resolver test**

Run: `python -m pytest tests\python\test_audio_resolver.py`

Expected: PASS.

---

### Task 3: Playback Queue

**Files:**
- Create: `backend/engines/playback_queue.py`
- Test: `tests/python/test_playback_queue.py`

- [ ] **Step 1: Write failing queue tests**

Create `tests/python/test_playback_queue.py`:

```python
import unittest

from backend.engines.playback_queue import PlaybackQueue


class PlaybackQueueTests(unittest.TestCase):
    def test_promote_ready_item_marks_previous_played(self):
        queue = PlaybackQueue(prewarm_depth=3)
        queue.add_ready({"id": "1", "name": "A"}, "/audio/1")
        queue.add_ready({"id": "2", "name": "B"}, "/audio/2")

        first = queue.promote_next()
        second = queue.promote_next(previous_event="played")

        self.assertEqual(first.song["id"], "1")
        self.assertEqual(second.song["id"], "2")
        self.assertEqual(queue.items[0].status, "played")
        self.assertEqual(queue.items[1].status, "playing")

    def test_needs_prewarm_counts_ready_and_playing_items(self):
        queue = PlaybackQueue(prewarm_depth=3)
        queue.add_ready({"id": "1"}, "/audio/1")

        self.assertEqual(queue.prewarm_needed(), 2)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest tests\python\test_playback_queue.py`

Expected: FAIL because `PlaybackQueue` does not exist.

- [ ] **Step 3: Implement queue**

Create `backend/engines/playback_queue.py`:

```python
from dataclasses import dataclass, field


@dataclass
class PlaybackQueueItem:
    song: dict
    url: str
    status: str = "ready"
    selection_reason: dict = field(default_factory=dict)
    segue_text: str = ""
    tts_hash: str = ""


class PlaybackQueue:
    def __init__(self, prewarm_depth: int = 3):
        self.prewarm_depth = prewarm_depth
        self.items: list[PlaybackQueueItem] = []

    def add_ready(
        self,
        song: dict,
        url: str,
        selection_reason: dict | None = None,
        segue_text: str = "",
        tts_hash: str = "",
    ) -> PlaybackQueueItem:
        item = PlaybackQueueItem(
            song=song,
            url=url,
            status="ready",
            selection_reason=selection_reason or song.get("selection_reason", {}) or {},
            segue_text=segue_text,
            tts_hash=tts_hash,
        )
        self.items.append(item)
        return item

    def current(self) -> PlaybackQueueItem | None:
        return next((item for item in self.items if item.status == "playing"), None)

    def promote_next(self, previous_event: str = "played") -> PlaybackQueueItem | None:
        current = self.current()
        if current:
            current.status = previous_event
        next_item = next((item for item in self.items if item.status == "ready"), None)
        if next_item:
            next_item.status = "playing"
        self._trim_old_items()
        return next_item

    def mark_current(self, status: str) -> None:
        current = self.current()
        if current:
            current.status = status

    def prewarm_needed(self) -> int:
        active_count = sum(
            1 for item in self.items
            if item.status in {"playing", "ready", "prewarming"}
        )
        return max(0, self.prewarm_depth - active_count)

    def _trim_old_items(self) -> None:
        old = [item for item in self.items if item.status in {"played", "skipped", "failed"}]
        if len(old) <= 10:
            return
        keep_old = set(id(item) for item in old[-10:])
        self.items = [
            item for item in self.items
            if item.status not in {"played", "skipped", "failed"} or id(item) in keep_old
        ]
```

- [ ] **Step 4: Run queue test**

Run: `python -m pytest tests\python\test_playback_queue.py`

Expected: PASS.

---

### Task 4: Simplified Onboarding Voices

**Files:**
- Modify: `frontend/index.html`
- Modify: `frontend/js/radio.js`
- Modify: `backend/api/radio.py`
- Test: `tests/python/test_radio_onboarding.py`

- [ ] **Step 1: Add failing backend test**

In `tests/python/test_radio_onboarding.py`, add:

```python
    async def test_save_onboarding_allows_only_two_voice_presets(self):
        result = await radio.save_onboarding(
            42,
            {"voice_preset": "bright_girl", "current_mode": "陪伴"},
        )

        self.assertEqual(result["settings"]["voice_preset"], "silver_female")
```

Expected helper setup should match the existing test class patterns in that file.

- [ ] **Step 2: Run onboarding test**

Run: `python -m pytest tests\python\test_radio_onboarding.py`

Expected: FAIL because current allowed presets include `bright_girl` and not `silver_female`.

- [ ] **Step 3: Update backend allowed voices**

In `backend/api/radio.py`, change:

```python
    allowed_presets = {"silver_female", "warm_male"}
    voice_preset = payload.get("voice_preset") or "silver_female"
    if voice_preset not in allowed_presets:
        voice_preset = "silver_female"
```

- [ ] **Step 4: Update frontend voice choices**

In `frontend/index.html`, replace the three voice buttons with:

```html
          <button class="choice-card selected" data-voice="silver_female">
            <strong>知性磁性女声</strong>
            <span>银色、成熟、低暖，像深夜里懂音乐的电台姐姐</span>
          </button>
          <button class="choice-card" data-voice="warm_male">
            <strong>温柔磁性男主播</strong>
            <span>沉稳、克制、有靠近感，像陪你慢慢听歌的电台主持人</span>
          </button>
```

In `frontend/js/radio.js`, change fallback voice preset from `warm_female` to `silver_female`.

- [ ] **Step 5: Run onboarding tests**

Run: `python -m pytest tests\python\test_radio_onboarding.py`

Expected: PASS.

---

### Task 5: Audio Proxy Endpoint

**Files:**
- Modify: `backend/main.py`
- Modify: `backend/api/radio.py`
- Test: `tests/python/test_audio_proxy.py`

- [ ] **Step 1: Write failing proxy tests**

Create `tests/python/test_audio_proxy.py`:

```python
import unittest

from backend.api import radio


class FakeResolver:
    async def resolve_with_candidates(self, song, uid=None):
        class Result:
            ok = True
            url = "https://example.test/audio.mp3"
            content_type = "audio/mpeg"
            reason = ""
        return Result()


class AudioProxyTests(unittest.IsolatedAsyncioTestCase):
    async def test_track_proxy_returns_streaming_response_for_resolved_audio(self):
        radio.audio_resolver = FakeResolver()

        response = await radio.get_audio_proxy("42")

        self.assertTrue(hasattr(response, "status_code"))
```

- [ ] **Step 2: Run proxy test**

Run: `python -m pytest tests\python\test_audio_proxy.py`

Expected: FAIL because endpoint function does not exist.

- [ ] **Step 3: Wire resolver global**

In `backend/api/radio.py`, add module global:

```python
audio_resolver = None
```

In `backend/main.py`, instantiate after scheduler:

```python
from backend.engines.audio_resolver import AudioResolver
...
audio_resolver = AudioResolver(netease_adapter, store)
radio.audio_resolver = audio_resolver
ws.audio_resolver = audio_resolver
```

- [ ] **Step 4: Add endpoint**

In `backend/api/radio.py`, add:

```python
from fastapi.responses import StreamingResponse
import httpx


@router.get("/audio/{song_id}")
async def get_audio_proxy(song_id: str):
    if not audio_resolver:
        return JSONResponse({"error": "audio resolver unavailable"}, status_code=503)
    resolved = await audio_resolver.resolve_with_candidates({"id": song_id})
    if not resolved.ok or not resolved.url:
        return JSONResponse({"error": resolved.reason or "audio unavailable"}, status_code=404)

    client = httpx.AsyncClient(timeout=30.0, follow_redirects=True, trust_env=False)
    try:
        upstream = await client.get(resolved.url)
        if upstream.status_code >= 400:
            await client.aclose()
            return JSONResponse({"error": f"upstream {upstream.status_code}"}, status_code=502)
        media_type = upstream.headers.get("content-type") or resolved.content_type or "audio/mpeg"
        async def body():
            try:
                yield upstream.content
            finally:
                await client.aclose()
        return StreamingResponse(
            body(),
            media_type=media_type,
            headers={"Cache-Control": "public, max-age=3600", "Accept-Ranges": "bytes"},
        )
    except Exception as error:
        await client.aclose()
        return JSONResponse({"error": str(error)}, status_code=502)
```

- [ ] **Step 5: Run proxy test**

Run: `python -m pytest tests\python\test_audio_proxy.py`

Expected: PASS.

---

### Task 6: Queue Integration Into WebSocket

**Files:**
- Modify: `backend/api/ws.py`
- Test: `tests/python/test_ws_playback_queue.py`

- [ ] **Step 1: Write focused unit test around queue helper**

If direct WebSocket testing is too broad, extract helper functions in `ws.py`:

```python
async def _prepare_queue_item(audio_resolver, song, uid):
    resolved = await audio_resolver.resolve_with_candidates(song, uid=uid)
    if not resolved.ok:
        return None
    return song, resolved.proxy_url
```

Test file `tests/python/test_ws_playback_queue.py`:

```python
import unittest

from backend.api.ws import _prepare_queue_item


class FakeResolver:
    async def resolve_with_candidates(self, song, uid=None):
        class Result:
            ok = True
            proxy_url = "/api/radio/audio/42"
        return Result()


class WsPlaybackQueueTests(unittest.IsolatedAsyncioTestCase):
    async def test_prepare_queue_item_uses_proxy_url(self):
        song, url = await _prepare_queue_item(FakeResolver(), {"id": "42"}, "u1")

        self.assertEqual(song["id"], "42")
        self.assertEqual(url, "/api/radio/audio/42")
```

- [ ] **Step 2: Run test**

Run: `python -m pytest tests\python\test_ws_playback_queue.py`

Expected: FAIL until helper exists.

- [ ] **Step 3: Add queue globals and session queue**

In `backend/api/ws.py`, add imports:

```python
from backend.engines.playback_queue import PlaybackQueue
```

Add global:

```python
audio_resolver = None
```

Inside `ws_handler`, add:

```python
playback_queue = PlaybackQueue(prewarm_depth=3)
```

- [ ] **Step 4: Add helper functions**

In `backend/api/ws.py`, add:

```python
async def _prepare_queue_item(audio_resolver, song: dict, uid: str | None):
    if not audio_resolver:
        return song, await scheduler.get_song_url(song)
    resolved = await audio_resolver.resolve_with_candidates(song, uid=uid)
    if not resolved.ok:
        return None
    return song, resolved.proxy_url
```

Add local helper inside `ws_handler`:

```python
    async def fill_queue():
        while playback_queue.prewarm_needed() > 0:
            song = await scheduler.pick_next(
                current_song_id,
                profile=profile,
                user_settings=user_settings,
                session_state=scheduler_state,
                uid=str(uid) if uid else None,
            )
            if not song:
                break
            prepared = await _prepare_queue_item(audio_resolver, song, str(uid) if uid else None)
            if not prepared:
                continue
            prepared_song, prepared_url = prepared
            playback_queue.add_ready(
                prepared_song,
                prepared_url,
                prepared_song.get("selection_reason", {}),
            )
```

- [ ] **Step 5: Use queue on session start and next**

In handshake after intro:

```python
                await fill_queue()
                item = playback_queue.promote_next()
                if item:
                    await send_track(item.song, item.url)
```

In `play_next_with_segue`, call `await fill_queue()`, then `item = playback_queue.promote_next(previous_event="skipped" if prev_song_id else "played")`, then send item. Continue filling queue after promotion.

- [ ] **Step 6: Run WebSocket queue test**

Run: `python -m pytest tests\python\test_ws_playback_queue.py`

Expected: PASS.

---

### Task 7: Restrained DJ Cadence

**Files:**
- Modify: `backend/engines/dj.py`
- Modify: `backend/api/ws.py`
- Test: `tests/python/test_dj_cadence.py`

- [ ] **Step 1: Write failing cadence tests**

Create `tests/python/test_dj_cadence.py`:

```python
import unittest

from backend.engines.dj import should_generate_segue


class DjCadenceTests(unittest.TestCase):
    def test_generates_segue_every_other_song(self):
        self.assertFalse(should_generate_segue(1))
        self.assertTrue(should_generate_segue(2))
        self.assertFalse(should_generate_segue(3))
        self.assertTrue(should_generate_segue(4))
```

- [ ] **Step 2: Run test**

Run: `python -m pytest tests\python\test_dj_cadence.py`

Expected: FAIL because function does not exist.

- [ ] **Step 3: Implement cadence function**

In `backend/engines/dj.py`, add:

```python
def should_generate_segue(track_index: int) -> bool:
    return track_index > 0 and track_index % 2 == 0
```

Update segue prompt to include selection reason text when present:

```python
reason = ""
if isinstance(next_song, dict):
    selection_reason = next_song.get("selection_reason")
    if isinstance(selection_reason, dict):
        reason = selection_reason.get("text", "")
```

Add the reason into the prompt:

```python
接歌理由：{reason}
```

Require concise line:

```python
请生成一句 18-36 个中文字符的短串词，只解释音乐如何自然接到下一首。
```

- [ ] **Step 4: Use cadence in WebSocket**

Inside `ws_handler`, add `track_index = 0`. Increment when sending a track. In `play_next_with_segue`, only generate segue if `should_generate_segue(track_index)`.

- [ ] **Step 5: Run cadence test**

Run: `python -m pytest tests\python\test_dj_cadence.py`

Expected: PASS.

---

### Task 8: Scheduler Avoids Failed Tracks

**Files:**
- Modify: `backend/engines/scheduler.py`
- Test: `tests/python/test_scheduler_failed_tracks.py`

- [ ] **Step 1: Write failing test**

Create `tests/python/test_scheduler_failed_tracks.py`:

```python
import unittest

from backend.engines.scheduler import StreamScheduler
from backend.core.event_bus import EventBus


class FakeStore:
    async def get_recent_tracks(self, limit=100, uid=None):
        return []

    async def was_track_recently_failed(self, song_id, uid=None, limit=50):
        return str(song_id) == "bad"


class SchedulerFailedTracksTests(unittest.IsolatedAsyncioTestCase):
    async def test_choose_candidate_skips_recently_failed_song(self):
        scheduler = StreamScheduler(None, FakeStore(), EventBus())
        songs = [
            {"id": "bad", "name": "Broken", "ar": [{"name": "A"}]},
            {"id": "good", "name": "Good", "ar": [{"name": "B"}]},
        ]

        selected = await scheduler._choose_candidate_async(songs, set(), set(), uid="u1")

        self.assertEqual(selected["id"], "good")
```

- [ ] **Step 2: Run test**

Run: `python -m pytest tests\python\test_scheduler_failed_tracks.py`

Expected: FAIL because `_choose_candidate_async` does not exist.

- [ ] **Step 3: Add async candidate chooser**

In `backend/engines/scheduler.py`, add:

```python
    async def _choose_candidate_async(
        self,
        songs: list[dict],
        recent_ids: set[str],
        recent_artists: set[str],
        uid: str | None = None,
    ) -> dict | None:
        candidates = []
        for song in songs:
            sid = self._song_id(song)
            if not sid:
                continue
            try:
                failed = await self.store.was_track_recently_failed(sid, uid=uid)
            except Exception:
                failed = False
            if not failed:
                candidates.append(song)
        return self._choose_candidate(candidates, recent_ids, recent_artists)
```

Replace calls to `_choose_candidate(...)` in `pick_next` with `await self._choose_candidate_async(..., uid=uid)`.

- [ ] **Step 4: Run scheduler failed track test**

Run: `python -m pytest tests\python\test_scheduler_failed_tracks.py`

Expected: PASS.

---

### Task 9: Full Verification

**Files:**
- No production file changes.

- [ ] **Step 1: Run Python tests**

Run: `python -m pytest tests\python`

Expected: all tests pass.

- [ ] **Step 2: Run NetEase bridge tests**

Run from `netease-bridge`: `npm test`

Expected: all tests pass.

- [ ] **Step 3: Run frontend JS behavior tests**

Run: `node --test tests\js\radio-websocket.test.mjs`

Expected: all tests pass.

- [ ] **Step 4: Restart app and health check**

Run service restart the same way as current project startup.

Check:

```powershell
curl.exe -s http://127.0.0.1:8000/health
curl.exe -s -o NUL -w "%{http_code}" http://127.0.0.1:8000/
curl.exe -s -o NUL -w "%{http_code}" http://127.0.0.1:3000/health
```

Expected: health JSON contains `ok`, page returns `200`, bridge returns `200`.

---

## Self-Review

- Spec coverage: audio proxy, fallback resolution, queue prewarm, restrained DJ cadence, simplified onboarding, event logging, and tests are covered.
- Placeholder scan: no TBD/TODO/fill-later wording is used as a task instruction.
- Type consistency: resolver returns `AudioResolution`; queue returns `PlaybackQueueItem`; WebSocket helper uses `proxy_url`; store methods match tests.
