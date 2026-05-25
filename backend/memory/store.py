import json
from datetime import datetime

from backend.memory.models import connect_db
from backend.core.config import get_settings


class MemoryStore:
    async def save_profile(self, uid: str, profile: dict) -> None:
        async with connect_db() as db:
            await db.execute(
                "INSERT INTO user_profile (uid, profile_json, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) "
                "ON CONFLICT(uid) DO UPDATE SET profile_json=excluded.profile_json, updated_at=CURRENT_TIMESTAMP",
                (uid, json.dumps(profile, ensure_ascii=False))
            )
            await db.commit()

    async def get_profile(self, uid: str) -> dict | None:
        async with connect_db() as db:
            async with db.execute(
                "SELECT profile_json FROM user_profile WHERE uid=?", (uid,)
            ) as cursor:
                row = await cursor.fetchone()
                return json.loads(row[0]) if row else None

    async def save_auth_account(self, uid: str, account: dict) -> None:
        async with connect_db() as db:
            await db.execute(
                "INSERT INTO auth_account (uid, account_json, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) "
                "ON CONFLICT(uid) DO UPDATE SET account_json=excluded.account_json, updated_at=CURRENT_TIMESTAMP",
                (uid, json.dumps(account, ensure_ascii=False)),
            )
            await db.commit()

    async def get_auth_account(self, uid: str) -> dict | None:
        async with connect_db() as db:
            async with db.execute(
                "SELECT account_json FROM auth_account WHERE uid=?", (uid,)
            ) as cursor:
                row = await cursor.fetchone()
                return json.loads(row[0]) if row else None

    async def save_user_settings(self, uid: str, settings: dict) -> None:
        async with connect_db() as db:
            await db.execute(
                "INSERT INTO user_settings (uid, settings_json, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) "
                "ON CONFLICT(uid) DO UPDATE SET settings_json=excluded.settings_json, updated_at=CURRENT_TIMESTAMP",
                (uid, json.dumps(settings, ensure_ascii=False)),
            )
            await db.commit()

    async def get_user_settings(self, uid: str) -> dict | None:
        async with connect_db() as db:
            async with db.execute(
                "SELECT settings_json FROM user_settings WHERE uid=?", (uid,)
            ) as cursor:
                row = await cursor.fetchone()
                return json.loads(row[0]) if row else None

    async def log_track(
        self,
        song_id: str,
        name: str,
        artist: str,
        source: str,
        uid: str | None = None,
    ) -> None:
        async with connect_db() as db:
            await db.execute(
                "INSERT INTO track_log (uid, song_id, song_name, artist, source) VALUES (?,?,?,?,?)",
                (str(uid) if uid else None, song_id, name, artist, source)
            )
            await db.commit()

    async def get_recent_tracks(
        self,
        limit: int = 100,
        uid: str | None = None,
    ) -> list[str]:
        async with connect_db() as db:
            if uid:
                async with db.execute(
                    "SELECT song_id FROM track_log WHERE uid=? ORDER BY played_at DESC LIMIT ?",
                    (str(uid), limit),
                ) as cursor:
                    return [row[0] for row in await cursor.fetchall()]
            async with db.execute(
                "SELECT song_id FROM track_log ORDER BY played_at DESC LIMIT ?", (limit,)
            ) as cursor:
                return [row[0] for row in await cursor.fetchall()]

    async def log_script(self, topic: str, script: str, style: str,
                         song_id: str = "", tts_hash: str = "") -> None:
        async with connect_db() as db:
            await db.execute(
                "INSERT INTO dj_script_log (topic, script_text, style, related_song_id, tts_hash) VALUES (?,?,?,?,?)",
                (topic, script, style, song_id, tts_hash)
            )
            await db.commit()

    async def create_session(self, uid: str) -> int:
        async with connect_db() as db:
            cursor = await db.execute(
                "INSERT INTO session_log (uid) VALUES (?)", (uid,)
            )
            await db.commit()
            return cursor.lastrowid

    async def end_session(self, session_id: int, songs: int,
                          topics: str, summary: str) -> None:
        async with connect_db() as db:
            await db.execute(
                "UPDATE session_log SET session_end=CURRENT_TIMESTAMP, songs_played=?, topics_covered=?, summary=? WHERE id=?",
                (songs, topics, summary, session_id)
            )
            await db.commit()

    async def session_count(self, uid: str) -> int:
        async with connect_db() as db:
            async with db.execute(
                "SELECT COUNT(*) FROM session_log WHERE uid=?", (uid,)
            ) as cursor:
                row = await cursor.fetchone()
                return row[0] if row else 0

    async def cache_tts(self, hash_val: str, path: str) -> None:
        async with connect_db() as db:
            await db.execute(
                "INSERT OR IGNORE INTO tts_cache (hash, audio_path) VALUES (?,?)",
                (hash_val, path)
            )
            await db.commit()

    async def get_tts_cache(self, hash_val: str) -> str | None:
        async with connect_db() as db:
            async with db.execute(
                "SELECT audio_path FROM tts_cache WHERE hash=?", (hash_val,)
            ) as cursor:
                row = await cursor.fetchone()
                return row[0] if row else None

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
                (
                    str(uid) if uid else None,
                    str(song_id) if song_id else None,
                    event_type,
                    reason,
                ),
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

    async def check_token_budget(self) -> bool:
        today = datetime.now().strftime("%Y-%m-%d")
        settings = get_settings()
        async with connect_db() as db:
            async with db.execute(
                "SELECT tokens_used FROM token_usage WHERE date=?", (today,)
            ) as cursor:
                row = await cursor.fetchone()
                return (row[0] if row else 0) < settings.max_daily_tokens

    async def add_tokens(self, count: int) -> None:
        today = datetime.now().strftime("%Y-%m-%d")
        async with connect_db() as db:
            await db.execute(
                "INSERT INTO token_usage (date, tokens_used) VALUES (?,?) ON CONFLICT(date) DO UPDATE SET tokens_used = tokens_used + ?",
                (today, count, count)
            )
            await db.commit()
