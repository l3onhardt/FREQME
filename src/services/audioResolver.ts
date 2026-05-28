import type { Track } from "../types.js";
import { normalizeMatchText } from "../utils/text.js";
import type { MemoryStore } from "../storage/memoryStore.js";
import type { NeteaseService } from "./neteaseService.js";

export interface AudioResolution {
  ok: boolean;
  songId: string;
  url: string;
  source: string;
  contentType: string;
  reason: string;
  proxyUrl: string;
}

function result(args: Partial<AudioResolution> & { ok: boolean; songId: string }): AudioResolution {
  const ok = args.ok;
  const songId = args.songId;
  return {
    ok,
    songId,
    url: args.url || "",
    source: args.source || "",
    contentType: args.contentType || "",
    reason: args.reason || "",
    proxyUrl: ok && songId ? `/api/radio/audio/${songId}` : "",
  };
}

export class AudioResolver {
  constructor(
    private readonly netease: NeteaseService,
    private readonly store: MemoryStore,
  ) {}

  async resolve(track: Track, uid: string | null = null, forceRefresh = false): Promise<AudioResolution> {
    if (!track.id) return result({ ok: false, songId: "", reason: "missing_song_id" });

    const cached = forceRefresh ? null : this.store.getAudioResolution(track.id);
    if (cached?.url && this.isPlayableUrl(cached.url)) {
      return result({
        ok: true,
        songId: track.id,
        url: cached.url,
        source: cached.source || "cache",
        contentType: cached.contentType || "audio/mpeg",
      });
    }

    const direct = await this.trySongUrl(track.id, "song_url");
    if (direct.ok) {
      this.store.saveAudioResolution(direct.songId, direct.url, direct.source, direct.contentType);
      return direct;
    }

    this.store.logPlaybackEvent("url_failed", {
      uid,
      songId: track.id,
      reason: direct.reason || "empty_url",
    });
    return direct;
  }

  async resolveWithCandidates(track: Track, uid: string | null = null, forceRefresh = false): Promise<AudioResolution> {
    const first = await this.resolve(track, uid, forceRefresh);
    if (first.ok) return first;

    const query = [track.artist, track.name].filter(Boolean).join(" ").trim();
    if (!query) return first;

    const candidates = await this.netease.search(query, 5);
    for (const candidate of candidates) {
      if (!candidate.id || candidate.id === track.id) continue;
      if (!this.isSameRecording(track, candidate)) continue;
      const candidateResolution = await this.trySongUrl(candidate.id, "search_candidate");
      if (candidateResolution.ok) {
        this.store.saveAudioResolution(
          candidateResolution.songId,
          candidateResolution.url,
          candidateResolution.source,
          candidateResolution.contentType,
        );
        return candidateResolution;
      }
    }

    return first;
  }

  private async trySongUrl(songId: string, source: string): Promise<AudioResolution> {
    try {
      const url = await this.netease.songUrl(songId);
      if (!url) return result({ ok: false, songId, source, reason: "empty_url" });
      if (!this.isPlayableUrl(url)) return result({ ok: false, songId, source, reason: "unplayable_url" });
      return result({ ok: true, songId, source, url, contentType: "audio/mpeg" });
    } catch {
      return result({ ok: false, songId, source, reason: "timeout" });
    }
  }

  private isPlayableUrl(url: string): boolean {
    return Boolean(url) && !url.includes("music.163.com/song/media/outer/url");
  }

  private isSameRecording(left: Track, right: Track): boolean {
    const leftName = normalizeMatchText(left.name);
    const rightName = normalizeMatchText(right.name);
    if (!leftName || leftName !== rightName) return false;
    const leftArtist = normalizeMatchText(left.artist);
    const rightArtist = normalizeMatchText(right.artist);
    return !leftArtist || leftArtist === rightArtist;
  }
}

