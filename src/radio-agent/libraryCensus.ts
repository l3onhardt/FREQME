import type { Track } from "../types.js";
import type {
  RadioLibraryPlaylistRecord,
  RadioLibraryTrackRecord,
} from "../storage/radioAgentStore.js";

export interface LibraryCensusResult {
  playlistsScanned: number;
  tracksScanned: number;
  failures: Array<{ playlistId: string; reason: string }>;
}

export interface LibraryCensusOptions {
  pageSize?: number;
  now?: () => string;
}

interface LibraryCensusNetease {
  userPlaylist(uid: string, options?: { limit?: number; offset?: number }): Promise<Record<string, unknown>[]>;
  playlistDetail(id: string | number): Promise<Record<string, unknown>>;
  normalizeTrack(song: Record<string, unknown>, source?: string): Track;
}

interface LibraryCensusStore {
  savePlaylist(uid: string, playlist: RadioLibraryPlaylistRecord): void;
  savePlaylistTracks(uid: string, playlistId: string, tracks: RadioLibraryTrackRecord[]): void;
}

export class LibraryCensus {
  private readonly pageSize: number;
  private readonly now: () => string;

  constructor(
    private readonly netease: LibraryCensusNetease,
    private readonly store: LibraryCensusStore,
    options: LibraryCensusOptions = {},
  ) {
    this.pageSize = Math.max(1, Math.floor(options.pageSize ?? 100));
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async scan(uid: string): Promise<LibraryCensusResult> {
    const playlists = await this.fetchAllPlaylists(uid);
    const result: LibraryCensusResult = {
      playlistsScanned: 0,
      tracksScanned: 0,
      failures: [],
    };

    for (const playlist of playlists) {
      const playlistId = stringValue(playlist.id || playlist.playlistId);
      if (!playlistId) continue;
      try {
        const detail = await this.netease.playlistDetail(playlistId);
        const detailPlaylist = extractPlaylist(detail) || playlist;
        const name = stringValue(detailPlaylist.name) || stringValue(playlist.name) || "Untitled Playlist";
        const scannedAt = this.now();
        const sourceTracks = extractTracks(detailPlaylist);
        const tracks = sourceTracks
          .map((song) => this.toLibraryTrack(uid, playlistId, song, scannedAt))
          .filter((track): track is RadioLibraryTrackRecord => Boolean(track));

        this.store.savePlaylist(uid, {
          uid,
          playlistId,
          name,
          raw: detailPlaylist,
          scannedAt,
        });
        this.store.savePlaylistTracks(uid, playlistId, tracks);
        result.playlistsScanned += 1;
        result.tracksScanned += tracks.length;
      } catch (error) {
        result.failures.push({
          playlistId,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return result;
  }

  private async fetchAllPlaylists(uid: string): Promise<Record<string, unknown>[]> {
    const playlists: Record<string, unknown>[] = [];
    let offset = 0;
    while (true) {
      const page = await this.netease.userPlaylist(uid, { limit: this.pageSize, offset });
      playlists.push(...page);
      if (page.length < this.pageSize) break;
      offset += this.pageSize;
    }
    return playlists;
  }

  private toLibraryTrack(
    uid: string,
    playlistId: string,
    song: Record<string, unknown>,
    scannedAt: string,
  ): RadioLibraryTrackRecord | null {
    const track = this.netease.normalizeTrack(song, `library:${playlistId}`);
    const songId = stringValue(track.id);
    const songName = stringValue(track.name);
    if (!songId || !songName) return null;
    return {
      uid,
      playlistId,
      songId,
      songName,
      artist: stringValue(track.artist),
      album: stringValue(track.album),
      source: track.raw || song,
      scannedAt,
    };
  }
}

function extractPlaylist(detail: Record<string, unknown>): Record<string, unknown> | null {
  const playlist = detail.playlist;
  return isRecord(playlist) ? playlist : null;
}

function extractTracks(playlist: Record<string, unknown>): Record<string, unknown>[] {
  const tracks = playlist.tracks;
  if (Array.isArray(tracks)) return tracks.filter(isRecord);
  const trackIds = playlist.trackIds;
  if (Array.isArray(trackIds)) return trackIds.filter(isRecord);
  return [];
}

function stringValue(value: unknown): string {
  return value == null ? "" : String(value).trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
