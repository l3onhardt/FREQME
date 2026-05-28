import { AppDatabase } from "./database.js";
import type { TasteProfile, Track, UserSettings } from "../types.js";
import { config } from "../config.js";

function json(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function parse<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string") return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export class MemoryStore {
  constructor(private readonly database: AppDatabase) {}

  saveAuthAccount(uid: string, account: Record<string, unknown>): void {
    this.database.db
      .prepare(`
        INSERT INTO auth_account (uid, account_json, updated_at)
        VALUES (?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(uid) DO UPDATE SET account_json=excluded.account_json, updated_at=CURRENT_TIMESTAMP
      `)
      .run(uid, json(account));
  }

  getAuthAccount(uid: string): Record<string, unknown> | null {
    const row = this.database.db
      .prepare("SELECT account_json FROM auth_account WHERE uid=?")
      .get(uid) as { account_json?: string } | undefined;
    return row ? parse(row.account_json, {}) : null;
  }

  saveUserSettings(uid: string, settings: UserSettings): void {
    this.database.db
      .prepare(`
        INSERT INTO user_settings (uid, settings_json, updated_at)
        VALUES (?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(uid) DO UPDATE SET settings_json=excluded.settings_json, updated_at=CURRENT_TIMESTAMP
      `)
      .run(uid, json(settings));
  }

  getUserSettings(uid: string): UserSettings | null {
    const row = this.database.db
      .prepare("SELECT settings_json FROM user_settings WHERE uid=?")
      .get(uid) as { settings_json?: string } | undefined;
    return row ? parse<UserSettings>(row.settings_json, null as unknown as UserSettings) : null;
  }

  saveProfile(uid: string, profile: TasteProfile): void {
    this.database.db
      .prepare(`
        INSERT INTO user_profile (uid, profile_json, updated_at)
        VALUES (?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(uid) DO UPDATE SET profile_json=excluded.profile_json, updated_at=CURRENT_TIMESTAMP
      `)
      .run(uid, json(profile));
  }

  getProfile(uid: string): TasteProfile | null {
    const row = this.database.db
      .prepare("SELECT profile_json FROM user_profile WHERE uid=?")
      .get(uid) as { profile_json?: string } | undefined;
    return row ? parse<TasteProfile>(row.profile_json, null as unknown as TasteProfile) : null;
  }

  createSession(uid: string): number {
    const result = this.database.db
      .prepare("INSERT INTO session_log (uid) VALUES (?)")
      .run(uid);
    return Number(result.lastInsertRowid || 0);
  }

  endSession(sessionId: number, songsPlayed: number, summary = ""): void {
    this.database.db
      .prepare(`
        UPDATE session_log
        SET session_end=CURRENT_TIMESTAMP, songs_played=?, summary=?
        WHERE id=?
      `)
      .run(songsPlayed, summary, sessionId);
  }

  sessionCount(uid: string): number {
    const row = this.database.db
      .prepare("SELECT COUNT(*) AS count FROM session_log WHERE uid=?")
      .get(uid) as { count?: number } | undefined;
    return Number(row?.count || 0);
  }

  logTrack(uid: string | null, track: Track, source = "scheduler"): void {
    this.database.db
      .prepare(`
        INSERT INTO track_log (uid, song_id, song_name, artist, source)
        VALUES (?, ?, ?, ?, ?)
      `)
      .run(uid, track.id, track.name, track.artist, source);
  }

  getRecentTrackIds(uid: string | null, limit = 100): string[] {
    const rows = uid
      ? this.database.db
          .prepare("SELECT song_id FROM track_log WHERE uid=? ORDER BY played_at DESC LIMIT ?")
          .all(uid, limit)
      : this.database.db
          .prepare("SELECT song_id FROM track_log ORDER BY played_at DESC LIMIT ?")
          .all(limit);
    return (rows as Array<{ song_id: string }>).map((row) => row.song_id).filter(Boolean);
  }

  getRecentPlayableTracks(uid: string | null, limit = 20): Track[] {
    const rows = uid
      ? this.database.db
          .prepare(`
            SELECT tl.song_id, tl.song_name, tl.artist
            FROM track_log tl
            INNER JOIN audio_resolution_cache arc ON arc.song_id = tl.song_id
            WHERE tl.uid = ?
            GROUP BY tl.song_id
            ORDER BY MAX(tl.played_at) DESC
            LIMIT ?
          `)
          .all(uid, limit)
      : this.database.db
          .prepare(`
            SELECT tl.song_id, tl.song_name, tl.artist
            FROM track_log tl
            INNER JOIN audio_resolution_cache arc ON arc.song_id = tl.song_id
            GROUP BY tl.song_id
            ORDER BY MAX(tl.played_at) DESC
            LIMIT ?
          `)
          .all(limit);
    return (rows as Array<{ song_id: string; song_name: string; artist?: string }>).map((row) => ({
      id: String(row.song_id),
      name: row.song_name || "",
      artist: row.artist || "",
    }));
  }

  logPlaybackEvent(
    eventType: string,
    options: {
      uid?: string | null;
      songId?: string | null;
      reason?: string;
      payload?: Record<string, unknown>;
    } = {},
  ): void {
    this.database.db
      .prepare(`
        INSERT INTO playback_event (uid, song_id, event_type, reason, payload_json)
        VALUES (?, ?, ?, ?, ?)
      `)
      .run(
        options.uid || null,
        options.songId || null,
        eventType,
        options.reason || "",
        options.payload ? json(options.payload) : null,
      );
  }

  wasTrackRecentlyFailed(songId: string, uid: string | null, limit = 50): boolean {
    const row = uid
      ? this.database.db
          .prepare(`
            SELECT 1 FROM playback_event
            WHERE uid=? AND song_id=? AND event_type IN ('url_failed', 'playback_failed')
            ORDER BY created_at DESC LIMIT ?
          `)
          .get(uid, songId, limit)
      : this.database.db
          .prepare(`
            SELECT 1 FROM playback_event
            WHERE song_id=? AND event_type IN ('url_failed', 'playback_failed')
            ORDER BY created_at DESC LIMIT ?
          `)
          .get(songId, limit);
    return Boolean(row);
  }

  saveAudioResolution(songId: string, url: string, source: string, contentType = ""): void {
    this.database.db
      .prepare(`
        INSERT INTO audio_resolution_cache (song_id, url, source, content_type, updated_at)
        VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(song_id) DO UPDATE SET
          url=excluded.url,
          source=excluded.source,
          content_type=excluded.content_type,
          updated_at=CURRENT_TIMESTAMP
      `)
      .run(songId, url, source, contentType);
  }

  getAudioResolution(songId: string): { songId: string; url: string; source: string; contentType: string } | null {
    const row = this.database.db
      .prepare("SELECT song_id, url, source, content_type FROM audio_resolution_cache WHERE song_id=?")
      .get(songId) as
      | { song_id: string; url: string; source: string; content_type?: string }
      | undefined;
    return row
      ? {
          songId: row.song_id,
          url: row.url,
          source: row.source,
          contentType: row.content_type || "",
        }
      : null;
  }

  cacheTts(hash: string, audioPath: string): void {
    this.database.db
      .prepare("INSERT OR REPLACE INTO tts_cache (hash, audio_path) VALUES (?, ?)")
      .run(hash, audioPath);
  }

  getTtsCache(hash: string): string | null {
    const row = this.database.db
      .prepare("SELECT audio_path FROM tts_cache WHERE hash=?")
      .get(hash) as { audio_path?: string } | undefined;
    return row?.audio_path || null;
  }

  checkTokenBudget(): boolean {
    const row = this.database.db
      .prepare("SELECT tokens_used FROM token_usage WHERE date=?")
      .get(today()) as { tokens_used?: number } | undefined;
    return Number(row?.tokens_used || 0) < config.maxDailyTokens;
  }

  addTokens(count: number): void {
    this.database.db
      .prepare(`
        INSERT INTO token_usage (date, tokens_used)
        VALUES (?, ?)
        ON CONFLICT(date) DO UPDATE SET tokens_used = tokens_used + excluded.tokens_used
      `)
      .run(today(), Math.max(0, Math.floor(count)));
  }

  logDjMemoryEvent(args: {
    uid: string;
    sessionId?: number | null;
    eventType: string;
    rawText?: string;
    payload?: Record<string, unknown>;
    importance?: number;
    expiresAt?: string | null;
  }): number {
    const result = this.database.db
      .prepare(`
        INSERT INTO dj_memory_event
          (uid, session_id, event_type, raw_text, payload_json, importance, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        args.uid,
        args.sessionId || null,
        args.eventType,
        args.rawText || "",
        json(args.payload || {}),
        args.importance ?? 0.5,
        args.expiresAt || null,
      );
    return Number(result.lastInsertRowid || 0);
  }

  getRecentDjMemoryEvents(uid: string, limit = 20): Array<Record<string, unknown>> {
    const rows = this.database.db
      .prepare(`
        SELECT id, session_id, event_type, raw_text, payload_json, importance, expires_at, created_at
        FROM dj_memory_event
        WHERE uid=?
        ORDER BY created_at DESC, id DESC
        LIMIT ?
      `)
      .all(uid, limit) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: row.id,
      sessionId: row.session_id,
      eventType: row.event_type,
      rawText: row.raw_text || "",
      payload: parse(String(row.payload_json || "{}"), {}),
      importance: row.importance,
      expiresAt: row.expires_at,
      createdAt: row.created_at,
    }));
  }

  saveDjSessionMemory(uid: string, sessionId: number, memory: Record<string, unknown>): void {
    this.database.db
      .prepare(`
        INSERT INTO dj_session_memory (uid, session_id, memory_json, updated_at)
        VALUES (?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(uid, session_id) DO UPDATE SET
          memory_json=excluded.memory_json,
          updated_at=CURRENT_TIMESTAMP
      `)
      .run(uid, sessionId, json(memory));
  }

  getDjSessionMemory(uid: string, sessionId: number): Record<string, unknown> {
    const row = this.database.db
      .prepare("SELECT memory_json FROM dj_session_memory WHERE uid=? AND session_id=?")
      .get(uid, sessionId) as { memory_json?: string } | undefined;
    return row ? parse(row.memory_json, {}) : {};
  }

  upsertDjUserMemory(args: {
    uid: string;
    memoryKey: string;
    memoryText: string;
    confidence: number;
    evidenceCount: number;
    tags: string[];
  }): void {
    this.database.db
      .prepare(`
        INSERT INTO dj_user_memory
          (uid, memory_key, memory_text, confidence, evidence_count, tags_json, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(uid, memory_key) DO UPDATE SET
          memory_text=excluded.memory_text,
          confidence=excluded.confidence,
          evidence_count=excluded.evidence_count,
          tags_json=excluded.tags_json,
          updated_at=CURRENT_TIMESTAMP
      `)
      .run(
        args.uid,
        args.memoryKey,
        args.memoryText,
        args.confidence,
        args.evidenceCount,
        json(args.tags),
      );
  }

  getDjUserMemories(uid: string, tags: string[] = [], limit = 10): Array<Record<string, unknown>> {
    const rows = this.database.db
      .prepare(`
        SELECT memory_key, memory_text, confidence, evidence_count, tags_json, updated_at
        FROM dj_user_memory
        WHERE uid=?
        ORDER BY confidence DESC, updated_at DESC
        LIMIT ?
      `)
      .all(uid, tags.length ? 100 : limit) as Array<Record<string, unknown>>;
    const wanted = new Set(tags);
    const result: Array<Record<string, unknown>> = [];
    for (const row of rows) {
      const rowTags = parse<string[]>(String(row.tags_json || "[]"), []);
      if (wanted.size && !rowTags.some((tag) => wanted.has(tag))) continue;
      result.push({
        memoryKey: row.memory_key,
        memoryText: row.memory_text,
        confidence: row.confidence,
        evidenceCount: row.evidence_count,
        tags: rowTags,
        updatedAt: row.updated_at,
      });
      if (result.length >= limit) break;
    }
    return result;
  }
}

