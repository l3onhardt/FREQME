import type { NeteaseService } from "./neteaseService.js";
import type { LyricLine, Track, TrackLyrics } from "../types.js";
import { compactText } from "../utils/text.js";

const timestampPattern = /\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\]/gu;

export function parseLrc(raw: string): LyricLine[] {
  const lines: LyricLine[] = [];
  for (const sourceLine of String(raw || "").split(/\r?\n/u)) {
    const timestamps = [...sourceLine.matchAll(timestampPattern)];
    if (!timestamps.length) continue;
    const text = compactText(sourceLine.replace(timestampPattern, ""), 500);
    if (!text) continue;
    for (const match of timestamps) {
      const minutes = Number(match[1] || 0);
      const seconds = Number(match[2] || 0);
      const fraction = match[3] || "0";
      const fractionMs = Number(fraction.padEnd(3, "0").slice(0, 3));
      const timeMs = (minutes * 60 * 1000) + (seconds * 1000) + fractionMs;
      lines.push({ timeMs, text });
    }
  }
  return lines.sort((left, right) => left.timeMs - right.timeMs);
}

function lyricText(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  return String((value as Record<string, unknown>).lyric || "");
}

function searchableText(value: unknown): string {
  return compactText(value, 200).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

function candidateMatches(candidate: Track, lookup: Partial<Track>): boolean {
  const wantedName = searchableText(lookup.name);
  const wantedArtist = searchableText(lookup.artist);
  const candidateName = searchableText(candidate.name);
  const candidateArtist = searchableText(candidate.artist);
  const nameMatches = !wantedName || candidateName.includes(wantedName) || wantedName.includes(candidateName);
  const artistMatches = !wantedArtist || candidateArtist.includes(wantedArtist) || wantedArtist.includes(candidateArtist);
  return Boolean(candidate.id && nameMatches && artistMatches);
}

export class LyricService {
  constructor(private readonly netease: Pick<NeteaseService, "lyrics" | "search">) {}

  async forSong(songId: string, lookup: Partial<Track> = {}): Promise<TrackLyrics> {
    const id = compactText(songId, 80);
    if (!id) return this.empty("");
    const direct = await this.fromId(id);
    if (direct.lines.length || direct.translatedLines.length) return direct;

    const query = compactText([lookup.artist, lookup.name].filter(Boolean).join(" "), 200);
    if (!query) return direct;

    const candidates = await this.netease.search(query, 5).catch(() => []);
    for (const candidate of candidates) {
      if (!candidateMatches(candidate, lookup) || candidate.id === id) continue;
      const fallback = await this.fromId(candidate.id);
      if (fallback.lines.length || fallback.translatedLines.length) {
        return { ...fallback, songId: id };
      }
    }

    return direct;
  }

  private async fromId(id: string): Promise<TrackLyrics> {
    const body = await this.netease.lyrics(id).catch(() => ({}));
    const lines = parseLrc(lyricText(body, "lrc"));
    const translatedLines = parseLrc(lyricText(body, "tlyric"));
    if (!lines.length && !translatedLines.length) return this.empty(id);
    return {
      songId: id,
      source: "netease",
      lines,
      translatedLines,
    };
  }

  private empty(songId: string): TrackLyrics {
    return {
      songId,
      source: "none",
      lines: [],
      translatedLines: [],
    };
  }
}
