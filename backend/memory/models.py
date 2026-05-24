import aiosqlite
import json
import os

DB_PATH = os.getenv("RADIO_DB_PATH", "data/radio.db")


async def init_db():
    async with aiosqlite.connect(DB_PATH) as db:
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
                song_id TEXT NOT NULL,
                song_name TEXT NOT NULL,
                artist TEXT,
                source TEXT,
                feedback TEXT,
                played_at TEXT DEFAULT CURRENT_TIMESTAMP
            );
            CREATE INDEX IF NOT EXISTS idx_track_played ON track_log(played_at);
            CREATE INDEX IF NOT EXISTS idx_track_song ON track_log(song_id);

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
        """)
        await db.commit()
