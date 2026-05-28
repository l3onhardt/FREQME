import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { config } from "../config.js";

export class AppDatabase {
  readonly db: DatabaseSync;

  constructor(dbPath = config.dbPath) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.init();
  }

  init(): void {
    this.db.exec(`
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

      CREATE TABLE IF NOT EXISTS user_profile (
        uid TEXT PRIMARY KEY,
        profile_json TEXT NOT NULL,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS session_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        uid TEXT NOT NULL,
        session_start TEXT DEFAULT CURRENT_TIMESTAMP,
        session_end TEXT,
        songs_played INTEGER DEFAULT 0,
        summary TEXT
      );

      CREATE TABLE IF NOT EXISTS playback_event (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        uid TEXT,
        song_id TEXT,
        event_type TEXT NOT NULL,
        reason TEXT,
        payload_json TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS track_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        uid TEXT,
        song_id TEXT NOT NULL,
        song_name TEXT NOT NULL,
        artist TEXT,
        source TEXT,
        played_at TEXT DEFAULT CURRENT_TIMESTAMP
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

      CREATE TABLE IF NOT EXISTS audio_resolution_cache (
        song_id TEXT PRIMARY KEY,
        url TEXT NOT NULL,
        source TEXT NOT NULL,
        content_type TEXT,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS tts_cache (
        hash TEXT PRIMARY KEY,
        audio_path TEXT NOT NULL,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS token_usage (
        date TEXT PRIMARY KEY,
        tokens_used INTEGER DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_track_uid_played ON track_log(uid, played_at);
      CREATE INDEX IF NOT EXISTS idx_playback_event_uid_song ON playback_event(uid, song_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_dj_memory_event_uid_created ON dj_memory_event(uid, created_at);
    `);
  }
}

