import { AppDatabase } from "./database.js";
import {
  isRadioAgentEventType,
  priorityForRadioAgentEvent,
  type RadioAgentEventType,
  type RadioAgentPriority,
} from "../radio-agent/types.js";

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

export interface RadioAgentEventRecord {
  id?: number;
  uid: string | null;
  sessionId?: number | null;
  type: RadioAgentEventType;
  priority: RadioAgentPriority;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface RadioAgentMemoryRecord {
  uid: string;
  key: string;
  kind: string;
  value: string;
  confidence: number;
  evidenceCount: number;
  evidenceRefs: string[];
  updatedAt: string;
}

export interface RadioLibraryPlaylistRecord {
  uid: string;
  playlistId: string;
  name: string;
  raw: Record<string, unknown>;
  scannedAt: string;
}

export interface RadioLibraryTrackRecord {
  uid: string;
  playlistId: string;
  songId: string;
  songName: string;
  artist: string;
  album: string;
  source: Record<string, unknown>;
  scannedAt: string;
}

export interface RadioAgentArtifactRecord {
  uid: string;
  artifactKey: string;
  content: string;
  sourceVersion: string;
  updatedAt: string;
}

export interface RadioShadowDecisionRecord {
  id: string;
  uid: string | null;
  sessionId?: number | null;
  decisionType: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export class RadioAgentStore {
  constructor(private readonly database: AppDatabase) {}

  appendEvent(event: RadioAgentEventRecord): number {
    const result = this.database.db
      .prepare(`
        INSERT INTO radio_agent_event (uid, session_id, event_type, priority, payload_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `)
      .run(
        event.uid,
        event.sessionId ?? null,
        event.type,
        event.priority,
        json(event.payload),
        event.createdAt,
      );
    return Number(result.lastInsertRowid || 0);
  }

  recentEvents(uid: string | null, sessionId: number | null, limit: number): RadioAgentEventRecord[] {
    const rows = this.database.db
      .prepare(`
        SELECT id, uid, session_id, event_type, priority, payload_json, created_at
        FROM radio_agent_event
        WHERE (uid IS ? OR uid = ?) AND (session_id IS ? OR session_id = ?)
        ORDER BY created_at DESC, id DESC
        LIMIT ?
      `)
      .all(uid, uid, sessionId, sessionId, limit) as Array<Record<string, unknown>>;
    return rows.map((row) => {
      const type = isRadioAgentEventType(row.event_type) ? row.event_type : "idle_tick";
      return {
        id: Number(row.id || 0),
        uid: typeof row.uid === "string" ? row.uid : null,
        sessionId: typeof row.session_id === "number" ? row.session_id : null,
        type,
        priority: radioAgentPriority(row.priority, type),
        payload: parse(String(row.payload_json || "{}"), {}),
        createdAt: String(row.created_at || ""),
      };
    });
  }

  upsertMemory(memory: RadioAgentMemoryRecord): void {
    this.database.db
      .prepare(`
        INSERT INTO radio_agent_memory
          (uid, memory_key, kind, value_text, confidence, evidence_count, evidence_refs_json, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(uid, memory_key) DO UPDATE SET
          kind=excluded.kind,
          value_text=excluded.value_text,
          confidence=excluded.confidence,
          evidence_count=excluded.evidence_count,
          evidence_refs_json=excluded.evidence_refs_json,
          updated_at=excluded.updated_at
      `)
      .run(
        memory.uid,
        memory.key,
        memory.kind,
        memory.value,
        memory.confidence,
        memory.evidenceCount,
        json(memory.evidenceRefs),
        memory.updatedAt,
      );
  }

  memories(uid: string, kind: string, limit: number): RadioAgentMemoryRecord[] {
    const rows = this.database.db
      .prepare(`
        SELECT uid, memory_key, kind, value_text, confidence, evidence_count, evidence_refs_json, updated_at
        FROM radio_agent_memory
        WHERE uid=? AND kind=?
        ORDER BY confidence DESC, evidence_count DESC, updated_at DESC
        LIMIT ?
      `)
      .all(uid, kind, limit) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      uid: String(row.uid || ""),
      key: String(row.memory_key || ""),
      kind: String(row.kind || ""),
      value: String(row.value_text || ""),
      confidence: Number(row.confidence || 0),
      evidenceCount: Number(row.evidence_count || 0),
      evidenceRefs: parse<string[]>(String(row.evidence_refs_json || "[]"), []),
      updatedAt: String(row.updated_at || ""),
    }));
  }

  savePlaylist(uid: string, playlist: RadioLibraryPlaylistRecord): void {
    this.database.db
      .prepare(`
        INSERT INTO radio_library_playlist (uid, playlist_id, name, raw_json, scanned_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(uid, playlist_id) DO UPDATE SET
          name=excluded.name,
          raw_json=excluded.raw_json,
          scanned_at=excluded.scanned_at
      `)
      .run(uid, playlist.playlistId, playlist.name, json(playlist.raw), playlist.scannedAt);
  }

  playlists(uid: string, limit: number): RadioLibraryPlaylistRecord[] {
    const rows = this.database.db
      .prepare(`
        SELECT uid, playlist_id, name, raw_json, scanned_at
        FROM radio_library_playlist
        WHERE uid=?
        ORDER BY scanned_at DESC
        LIMIT ?
      `)
      .all(uid, limit) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      uid: String(row.uid || ""),
      playlistId: String(row.playlist_id || ""),
      name: String(row.name || ""),
      raw: parse(String(row.raw_json || "{}"), {}),
      scannedAt: String(row.scanned_at || ""),
    }));
  }

  savePlaylistTracks(uid: string, playlistId: string, tracks: RadioLibraryTrackRecord[]): void {
    const statement = this.database.db.prepare(`
      INSERT INTO radio_library_track
        (uid, playlist_id, song_id, song_name, artist, album, source_json, scanned_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(uid, playlist_id, song_id) DO UPDATE SET
        song_name=excluded.song_name,
        artist=excluded.artist,
        album=excluded.album,
        source_json=excluded.source_json,
        scanned_at=excluded.scanned_at
    `);
    for (const track of tracks) {
      statement.run(
        uid,
        playlistId,
        track.songId,
        track.songName,
        track.artist || "",
        track.album || "",
        json(track.source),
        track.scannedAt,
      );
    }
  }

  libraryTracks(uid: string, limit: number): RadioLibraryTrackRecord[] {
    const rows = this.database.db
      .prepare(`
        SELECT uid, playlist_id, song_id, song_name, artist, album, source_json, scanned_at
        FROM radio_library_track
        WHERE uid=?
        ORDER BY scanned_at DESC
        LIMIT ?
      `)
      .all(uid, limit) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      uid: String(row.uid || ""),
      playlistId: String(row.playlist_id || ""),
      songId: String(row.song_id || ""),
      songName: String(row.song_name || ""),
      artist: String(row.artist || ""),
      album: String(row.album || ""),
      source: parse(String(row.source_json || "{}"), {}),
      scannedAt: String(row.scanned_at || ""),
    }));
  }

  saveArtifact(uid: string, artifactKey: string, content: string, sourceVersion: string): void {
    this.database.db
      .prepare(`
        INSERT INTO radio_agent_artifact (uid, artifact_key, content, source_version, updated_at)
        VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(uid, artifact_key) DO UPDATE SET
          content=excluded.content,
          source_version=excluded.source_version,
          updated_at=CURRENT_TIMESTAMP
      `)
      .run(uid, artifactKey, content, sourceVersion);
  }

  artifact(uid: string, artifactKey: string): RadioAgentArtifactRecord | null {
    const row = this.database.db
      .prepare(`
        SELECT uid, artifact_key, content, source_version, updated_at
        FROM radio_agent_artifact
        WHERE uid=? AND artifact_key=?
      `)
      .get(uid, artifactKey) as Record<string, unknown> | undefined;
    return row
      ? {
          uid: String(row.uid || ""),
          artifactKey: String(row.artifact_key || ""),
          content: String(row.content || ""),
          sourceVersion: String(row.source_version || ""),
          updatedAt: String(row.updated_at || ""),
        }
      : null;
  }

  saveShadowDecision(decision: RadioShadowDecisionRecord): void {
    this.database.db
      .prepare(`
        INSERT INTO radio_agent_shadow_decision (id, uid, session_id, decision_type, payload_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET payload_json=excluded.payload_json
      `)
      .run(
        decision.id,
        decision.uid,
        decision.sessionId ?? null,
        decision.decisionType,
        json(decision.payload),
        decision.createdAt,
      );
  }

  latestShadowDecisions(uid: string | null, sessionId: number | null, limit: number): RadioShadowDecisionRecord[] {
    const rows = this.database.db
      .prepare(`
        SELECT id, uid, session_id, decision_type, payload_json, created_at
        FROM radio_agent_shadow_decision
        WHERE (uid IS ? OR uid = ?) AND (session_id IS ? OR session_id = ?)
        ORDER BY created_at DESC, rowid DESC
        LIMIT ?
      `)
      .all(uid, uid, sessionId, sessionId, limit) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: String(row.id || ""),
      uid: typeof row.uid === "string" ? row.uid : null,
      sessionId: typeof row.session_id === "number" ? row.session_id : null,
      decisionType: String(row.decision_type || ""),
      payload: parse(String(row.payload_json || "{}"), {}),
      createdAt: String(row.created_at || ""),
    }));
  }
}

function radioAgentPriority(value: unknown, type: RadioAgentEventType): RadioAgentPriority {
  return value === "hot" || value === "warm" || value === "cold" ? value : priorityForRadioAgentEvent(type);
}
