import json
import os
from pathlib import Path

import aiosqlite

DEFAULT_DB_PATH = "data/radio.db"
DB_PATH = DEFAULT_DB_PATH


def get_db_path() -> str:
    return os.getenv("RADIO_DB_PATH", DEFAULT_DB_PATH)


def ensure_db_parent(path: str) -> None:
    parent = Path(path).parent
    if str(parent) and str(parent) != ".":
        parent.mkdir(parents=True, exist_ok=True)


def connect_db():
    path = get_db_path()
    ensure_db_parent(path)
    return aiosqlite.connect(path)


async def init_db():
    async with connect_db() as db:
        await db.executescript("""
            CREATE TABLE IF NOT EXISTS user_profile (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                uid TEXT UNIQUE NOT NULL,
                profile_json TEXT NOT NULL,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS auth_account (
                uid TEXT PRIMARY KEY,
                account_json TEXT NOT NULL,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS user_settings (
                uid TEXT PRIMARY KEY,
                settings_json TEXT NOT NULL,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS track_log (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                uid TEXT,
                song_id TEXT NOT NULL,
                song_name TEXT NOT NULL,
                artist TEXT,
                source TEXT,
                feedback TEXT,
                played_at TEXT DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS dj_script_log (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                topic TEXT,
                script_text TEXT NOT NULL,
                style TEXT,
                related_song_id TEXT,
                tts_hash TEXT,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS session_log (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                uid TEXT NOT NULL,
                session_start TEXT DEFAULT CURRENT_TIMESTAMP,
                session_end TEXT,
                songs_played INTEGER DEFAULT 0,
                topics_covered TEXT,
                summary TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_session_start ON session_log(session_start);

            CREATE TABLE IF NOT EXISTS tts_cache (
                hash TEXT PRIMARY KEY,
                audio_path TEXT NOT NULL,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS token_usage (
                date TEXT PRIMARY KEY,
                tokens_used INTEGER DEFAULT 0
            );
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
        """)
        await _ensure_column(db, "track_log", "uid", "TEXT")
        await db.executescript("""
            CREATE INDEX IF NOT EXISTS idx_track_played ON track_log(played_at);
            CREATE INDEX IF NOT EXISTS idx_track_uid_played ON track_log(uid, played_at);
            CREATE INDEX IF NOT EXISTS idx_track_song ON track_log(song_id);
            CREATE INDEX IF NOT EXISTS idx_session_start ON session_log(session_start);
            CREATE INDEX IF NOT EXISTS idx_playback_event_song ON playback_event(song_id, created_at);
            CREATE INDEX IF NOT EXISTS idx_playback_event_uid_song ON playback_event(uid, song_id, created_at);
        """)
        await db.commit()


async def _ensure_column(db, table: str, column: str, definition: str) -> None:
    async with db.execute(f"PRAGMA table_info({table})") as cursor:
        columns = {row[1] for row in await cursor.fetchall()}
    if column not in columns:
        await db.execute(f"ALTER TABLE {table} ADD COLUMN {column} {definition}")
