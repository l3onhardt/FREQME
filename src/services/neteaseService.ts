import fs from "node:fs";
import path from "node:path";

import NeteaseCloudMusicApi from "NeteaseCloudMusicApi";

import { config } from "../config.js";
import type { Track } from "../types.js";

type ApiFn = (args: Record<string, unknown>) => Promise<{ body: Record<string, unknown> }>;

const api = NeteaseCloudMusicApi as unknown as Record<string, ApiFn>;
const shortCacheTtlMs = 5 * 60 * 1000;
const profileCacheTtlMs = 30 * 60 * 1000;

interface CacheEntry {
  expiresAt: number;
  value: Record<string, unknown>;
}

function loadCookie(filePath: string): string {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as { cookie?: string };
    return typeof parsed.cookie === "string" ? parsed.cookie : "";
  } catch {
    return "";
  }
}

function saveCookie(filePath: string, cookie: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  if (!cookie) {
    try {
      fs.rmSync(filePath, { force: true });
    } catch {
      // ignore stale cookie cleanup errors
    }
    return;
  }
  const tmpPath = `${filePath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify({ cookie, updatedAt: new Date().toISOString() }, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });
  fs.renameSync(tmpPath, filePath);
}

function sanitizeLoginBody(body: unknown): unknown {
  if (!body || typeof body !== "object" || Array.isArray(body)) return body;
  const clean = { ...(body as Record<string, unknown>) };
  delete clean.cookie;
  if (clean.data && typeof clean.data === "object" && !Array.isArray(clean.data)) {
    clean.data = { ...(clean.data as Record<string, unknown>) };
    delete (clean.data as Record<string, unknown>).cookie;
  }
  return clean;
}

function firstPlayableUrl(body: Record<string, unknown>): string {
  const data = Array.isArray(body.data) ? (body.data as Array<Record<string, unknown>>) : [];
  const item = data.find((entry) => entry?.url && Number(entry.code || 200) === 200);
  return String(item?.url || "");
}

function extractSongs(body: Record<string, unknown>): Record<string, unknown>[] {
  const result = body.result;
  if (!result || typeof result !== "object" || Array.isArray(result)) return [];
  const songs = (result as Record<string, unknown>).songs;
  return Array.isArray(songs) ? (songs as Record<string, unknown>[]) : [];
}

export class NeteaseService {
  private cookie = loadCookie(config.neteaseCookiePath);
  private readonly responseCache = new Map<string, CacheEntry>();
  private readonly inflight = new Map<string, Promise<Record<string, unknown>>>();

  private withCookie(args: Record<string, unknown> = {}): Record<string, unknown> {
    return this.cookie ? { ...args, cookie: this.cookie } : args;
  }

  activeCookie(): string {
    return this.cookie;
  }

  useCookie(cookie: string): void {
    this.cookie = cookie;
    this.responseCache.clear();
    this.inflight.clear();
    saveCookie(config.neteaseCookiePath, this.cookie);
  }

  clearCookie(): void {
    this.useCookie("");
  }

  private async call(name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    try {
      const fn = api[name];
      if (typeof fn !== "function") throw new Error(`missing Netease API ${name}`);
      const response = await fn(args);
      return response.body || {};
    } catch (error) {
      return {
        code: -1,
        message: error instanceof Error ? error.message : "NetEase request failed",
      };
    }
  }

  private async cachedCall(name: string, args: Record<string, unknown> = {}, ttlMs = shortCacheTtlMs): Promise<Record<string, unknown>> {
    const key = `${name}:${JSON.stringify(args)}`;
    const now = Date.now();
    const cached = this.responseCache.get(key);
    if (cached && cached.expiresAt > now) return cached.value;
    const existing = this.inflight.get(key);
    if (existing) return existing;
    const task = this.call(name, args)
      .then((value) => {
        if (Number(value.code || 200) !== -1) {
          this.responseCache.set(key, { value, expiresAt: Date.now() + ttlMs });
        }
        return value;
      })
      .finally(() => {
        this.inflight.delete(key);
      });
    this.inflight.set(key, task);
    return task;
  }

  async qrKey(): Promise<Record<string, unknown>> {
    return this.call("login_qr_key");
  }

  async qrCreate(key: string): Promise<Record<string, unknown>> {
    return this.call("login_qr_create", { key, qrimg: true });
  }

  async qrCheck(key: string): Promise<Record<string, unknown>> {
    const body = await this.call("login_qr_check", { key });
    if (Number(body.code) === 803 && typeof body.cookie === "string") {
      this.cookie = body.cookie;
      saveCookie(config.neteaseCookiePath, this.cookie);
    }
    return sanitizeLoginBody(body) as Record<string, unknown>;
  }

  async loginStatus(): Promise<Record<string, unknown>> {
    const body = await this.call("login_status", { cookie: this.cookie });
    return sanitizeLoginBody(body) as Record<string, unknown>;
  }

  async loginRefresh(): Promise<Record<string, unknown>> {
    const body = await this.call("login_refresh", { cookie: this.cookie });
    if (typeof body.cookie === "string") {
      this.cookie = body.cookie;
      saveCookie(config.neteaseCookiePath, this.cookie);
    }
    return sanitizeLoginBody(body) as Record<string, unknown>;
  }

  async userPlaylist(uid: string): Promise<Record<string, unknown>[]> {
    const body = await this.cachedCall("user_playlist", this.withCookie({ uid }), profileCacheTtlMs);
    return Array.isArray(body.playlist) ? (body.playlist as Record<string, unknown>[]) : [];
  }

  async playlistDetail(id: string | number): Promise<Record<string, unknown>> {
    return this.cachedCall("playlist_detail", this.withCookie({ id }), profileCacheTtlMs);
  }

  async userRecord(uid: string): Promise<Record<string, unknown>> {
    return this.cachedCall("user_record", this.withCookie({ uid, type: 1 }), profileCacheTtlMs);
  }

  async recommendSongs(): Promise<Track[]> {
    const body = await this.cachedCall("recommend_songs", this.withCookie(), shortCacheTtlMs);
    const data = body.data;
    const songs =
      data && typeof data === "object" && !Array.isArray(data) && Array.isArray((data as Record<string, unknown>).dailySongs)
        ? ((data as Record<string, unknown>).dailySongs as Record<string, unknown>[])
        : [];
    return songs.map((song) => this.normalizeTrack(song, "daily_personal")).filter((track) => track.id);
  }

  async personalFm(): Promise<Track[]> {
    const body = await this.cachedCall("personal_fm", this.withCookie(), shortCacheTtlMs);
    const songs = Array.isArray(body.data) ? (body.data as Record<string, unknown>[]) : [];
    return songs.map((song) => this.normalizeTrack(song, "personal_fm")).filter((track) => track.id);
  }

  async similarSongs(songId: string): Promise<Track[]> {
    const body = await this.cachedCall("simi_song", { id: songId }, shortCacheTtlMs);
    const songs = Array.isArray(body.songs) ? (body.songs as Record<string, unknown>[]) : [];
    return songs.map((song) => this.normalizeTrack(song, "similar")).filter((track) => track.id);
  }

  async likeList(uid: string): Promise<string[]> {
    const body = await this.cachedCall("like_list", this.withCookie({ uid }), profileCacheTtlMs);
    const ids = Array.isArray(body.ids) ? body.ids : [];
    return ids.map((id) => String(id));
  }

  async search(keywords: string, limit = 8): Promise<Track[]> {
    const cloud = await this.cachedCall("cloudsearch", this.withCookie({ keywords, type: 1, limit }), shortCacheTtlMs);
    let songs = extractSongs(cloud);
    if (!songs.length) {
      const fallback = await this.cachedCall("search", { keywords, type: 1, limit }, shortCacheTtlMs);
      songs = extractSongs(fallback);
    }
    return songs.map((song) => this.normalizeTrack(song, "search")).filter((track) => track.id);
  }

  async songUrl(songId: string): Promise<string> {
    for (const level of ["exhigh", "standard"]) {
      const body = await this.call("song_url_v1", this.withCookie({ id: songId, level }));
      const url = firstPlayableUrl(body);
      if (url) return url;
    }
    const legacy = await this.call("song_url", this.withCookie({ id: songId, br: 320000 }));
    return firstPlayableUrl(legacy);
  }

  async lyrics(songId: string): Promise<Record<string, unknown>> {
    return this.cachedCall("lyric_new", this.withCookie({ id: songId }), 60 * 60 * 1000);
  }

  normalizeTrack(song: Record<string, unknown>, source = ""): Track {
    const artists = Array.isArray(song.ar)
      ? (song.ar as Record<string, unknown>[])
      : Array.isArray(song.artists)
        ? (song.artists as Record<string, unknown>[])
        : [];
    const artist = String((song.artist as string) || artists[0]?.name || "");
    const albumObj = song.al || song.album;
    const album =
      typeof albumObj === "string"
        ? albumObj
        : albumObj && typeof albumObj === "object" && !Array.isArray(albumObj)
          ? String((albumObj as Record<string, unknown>).name || "")
          : "";
    const aliases = song.alias || song.alia || song.aliases;
    const aliasList = Array.isArray(aliases)
      ? aliases.map((alias) => String(alias)).filter(Boolean).slice(0, 5)
      : typeof aliases === "string" && aliases
        ? [aliases]
        : [];
    return {
      id: song.id == null ? "" : String(song.id),
      name: String(song.name || song.title || ""),
      artist,
      album,
      aliases: aliasList,
      source,
      raw: song,
    };
  }
}

export function extractProfile(status: Record<string, unknown>): Record<string, unknown> {
  const data = status.data;
  if (data && typeof data === "object" && !Array.isArray(data)) {
    const profile = (data as Record<string, unknown>).profile;
    if (profile && typeof profile === "object" && !Array.isArray(profile)) {
      return profile as Record<string, unknown>;
    }
  }
  const fallback = status.profile;
  return fallback && typeof fallback === "object" && !Array.isArray(fallback)
    ? (fallback as Record<string, unknown>)
    : {};
}
