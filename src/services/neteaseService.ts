import fs from "node:fs";
import path from "node:path";
import { constants, createCipheriv, createHash, createPublicKey, publicEncrypt, randomBytes, randomInt } from "node:crypto";
import { createRequire } from "node:module";

import { config } from "../config.js";
import type { Track } from "../types.js";

const shortCacheTtlMs = 5 * 60 * 1000;
const profileCacheTtlMs = 30 * 60 * 1000;
const require = createRequire(import.meta.url);
const neteaseDomain = "https://music.163.com";
const neteaseApiDomain = "https://interface.music.163.com";
const iv = "0102030405060708";
const presetKey = "0CoJUm6Qyw8W8jud";
const eapiKey = "e82ckenh8dichen8";
const base62 = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const publicKey = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDgtQn2JZ34ZC28NWYpAUd98iZ37BUrX/aKzmFbt7clFSs6sXqHauqKWqdtLkF2KexO40H1YTX8z2lSgBBOAxLsvaklV8k4cBFK9snQXE9/DDaFt6Rr7iVZMldczhC0JNgTz+SHXT6CBHuX3e9SdB1Ua44oncaTWz7OBGLbCiK45wIDAQAB
-----END PUBLIC KEY-----`;

type CryptoMode = "weapi" | "eapi" | "api";
type QrCodeModule = { toDataURL(text: string): Promise<string> };

interface NeteaseResponse {
  body: Record<string, unknown>;
  cookie: string[];
  status: number;
}

interface CacheEntry {
  expiresAt: number;
  value: Record<string, unknown>;
}

interface RouteDefinition {
  crypto?: CryptoMode;
  uri: string;
  data: (args: Record<string, unknown>) => Record<string, unknown>;
  shape?: (response: NeteaseResponse) => Record<string, unknown>;
}

const routes: Record<string, RouteDefinition> = {
  login_qr_key: {
    uri: "/api/login/qrcode/unikey",
    data: () => ({ type: 3 }),
    shape: (response) => ({ data: response.body, code: 200 }),
  },
  login_qr_check: {
    uri: "/api/login/qrcode/client/login",
    data: (args) => ({ key: args.key, type: 3 }),
    shape: (response) => ({ ...response.body, cookie: response.cookie.join(";") }),
  },
  login_status: {
    crypto: "weapi",
    uri: "/api/w/nuser/account/get",
    data: () => ({}),
    shape: (response) => (Number(response.body.code) === 200 ? { data: { ...response.body } } : response.body),
  },
  login_refresh: {
    uri: "/api/login/token/refresh",
    data: () => ({}),
    shape: (response) => ({ ...response.body, cookie: response.cookie.join(";") }),
  },
  user_playlist: {
    crypto: "weapi",
    uri: "/api/user/playlist",
    data: (args) => ({ uid: args.uid, limit: args.limit || 30, offset: args.offset || 0, includeVideo: true }),
  },
  playlist_detail: {
    uri: "/api/v6/playlist/detail",
    data: (args) => ({ id: args.id, n: 100000, s: args.s || 8 }),
  },
  user_record: {
    crypto: "weapi",
    uri: "/api/v1/play/record",
    data: (args) => ({ uid: args.uid, type: args.type || 0 }),
  },
  recommend_songs: {
    crypto: "weapi",
    uri: "/api/v3/discovery/recommend/songs",
    data: () => ({}),
  },
  personal_fm: {
    crypto: "weapi",
    uri: "/api/v1/radio/get",
    data: () => ({}),
  },
  simi_song: {
    crypto: "weapi",
    uri: "/api/v1/discovery/simiSong",
    data: (args) => ({ songid: args.id, limit: args.limit || 50, offset: args.offset || 0 }),
  },
  like_list: {
    uri: "/api/song/like/get",
    data: (args) => ({ uid: args.uid }),
  },
  cloudsearch: {
    uri: "/api/cloudsearch/pc",
    data: (args) => ({ s: args.keywords, type: args.type || 1, limit: args.limit || 30, offset: args.offset || 0, total: true }),
  },
  search: {
    uri: "/api/search/get",
    data: (args) => ({ s: args.keywords, type: args.type || 1, limit: args.limit || 30, offset: args.offset || 0 }),
  },
  song_url_v1: {
    uri: "/api/song/enhance/player/url/v1",
    data: (args) => ({ ids: `[${args.id}]`, level: args.level, encodeType: "flac" }),
  },
  song_url: {
    uri: "/api/song/enhance/player/url",
    data: (args) => ({ ids: JSON.stringify(String(args.id).split(",")), br: Number(args.br || 999000) }),
  },
  lyric_new: {
    uri: "/api/song/lyric/v1",
    data: (args) => ({ id: args.id, cp: false, tv: 0, lv: 0, rv: 0, kv: 0, yv: 0, ytv: 0, yrv: 0 }),
  },
};

function aesEncrypt(text: string, mode: "cbc" | "ecb", key: string, cipherIv = "", format: "base64" | "hex" = "base64"): string {
  const cipher = createCipheriv(`aes-128-${mode}`, Buffer.from(key, "utf8"), mode === "cbc" ? Buffer.from(cipherIv, "utf8") : null);
  cipher.setAutoPadding(true);
  const encrypted = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  return format === "hex" ? encrypted.toString("hex").toUpperCase() : encrypted.toString("base64");
}

function rsaEncrypt(text: string): string {
  const key = createPublicKey(publicKey);
  const keySize = Math.ceil((key.asymmetricKeyDetails?.modulusLength || 1024) / 8);
  const input = Buffer.from(text, "utf8");
  const padded = Buffer.concat([Buffer.alloc(Math.max(0, keySize - input.length)), input]).subarray(-keySize);
  return publicEncrypt({ key, padding: constants.RSA_NO_PADDING }, padded).toString("hex");
}

function randomSecretKey(): string {
  let value = "";
  for (let i = 0; i < 16; i += 1) value += base62[randomInt(base62.length)];
  return value;
}

function weapiEncrypt(data: Record<string, unknown>): Record<string, string> {
  const text = JSON.stringify(data);
  const secretKey = randomSecretKey();
  return {
    params: aesEncrypt(aesEncrypt(text, "cbc", presetKey, iv), "cbc", secretKey, iv),
    encSecKey: rsaEncrypt(secretKey.split("").reverse().join("")),
  };
}

function eapiEncrypt(uri: string, data: Record<string, unknown>): Record<string, string> {
  const text = JSON.stringify(data);
  const digest = createHash("md5").update(`nobody${uri}use${text}md5forencrypt`).digest("hex");
  return {
    params: aesEncrypt(`${uri}-36cd479b6b5-${text}-36cd479b6b5-${digest}`, "ecb", eapiKey, "", "hex"),
  };
}

function cookieToRecord(cookie: unknown): Record<string, string> {
  if (!cookie) return {};
  if (typeof cookie === "object" && !Array.isArray(cookie)) {
    return Object.fromEntries(Object.entries(cookie as Record<string, unknown>).map(([key, value]) => [key, String(value)]));
  }
  return String(cookie)
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .reduce<Record<string, string>>((record, part) => {
      const index = part.indexOf("=");
      if (index > 0) record[decodeURIComponent(part.slice(0, index))] = decodeURIComponent(part.slice(index + 1));
      return record;
    }, {});
}

function recordToCookie(record: Record<string, unknown>): string {
  return Object.entries(record)
    .filter(([, value]) => value !== undefined && value !== "")
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
    .join("; ");
}

function setCookies(headers: Headers): string[] {
  const withGetter = headers as Headers & { getSetCookie?: () => string[] };
  const values = typeof withGetter.getSetCookie === "function" ? withGetter.getSetCookie() : [];
  const fallback = headers.get("set-cookie");
  return (values.length ? values : fallback ? [fallback] : []).map((cookie) => cookie.replace(/\s*Domain=[^(;|$)]+;*/i, ""));
}

async function qrImage(url: string): Promise<string> {
  const qrcode = require("qrcode") as QrCodeModule;
  return qrcode.toDataURL(url);
}

async function requestNetease(uri: string, rawData: Record<string, unknown>, args: Record<string, unknown>, cryptoMode: CryptoMode): Promise<NeteaseResponse> {
  const cookie = cookieToRecord(args.cookie);
  const csrfToken = cookie.__csrf || "";
  const headers: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded",
  };
  let url = "";
  let payload: Record<string, string | number | boolean | unknown> = { ...rawData, e_r: false };

  if (cryptoMode === "weapi") {
    headers.Referer = neteaseDomain;
    headers["User-Agent"] =
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
    if (Object.keys(cookie).length) headers.Cookie = recordToCookie(cookie);
    payload = weapiEncrypt({ ...payload, csrf_token: csrfToken });
    url = `${neteaseDomain}/weapi/${uri.slice(5)}`;
  } else {
    const requestId = `${Date.now()}_${String(randomInt(1000)).padStart(4, "0")}`;
    const header = {
      osver: cookie.osver || "16.2",
      deviceId: cookie.deviceId || randomBytes(16).toString("hex"),
      os: cookie.os || "iPhone OS",
      appver: cookie.appver || "9.0.90",
      versioncode: cookie.versioncode || "140",
      mobilename: cookie.mobilename || "",
      buildver: cookie.buildver || String(Date.now()).slice(0, 10),
      resolution: cookie.resolution || "1920x1080",
      __csrf: csrfToken,
      channel: cookie.channel || "distribution",
      requestId,
      ...(cookie.MUSIC_U ? { MUSIC_U: cookie.MUSIC_U } : {}),
      ...(cookie.MUSIC_A ? { MUSIC_A: cookie.MUSIC_A } : {}),
    };
    headers.Cookie = recordToCookie({ ...cookie, ...header });
    headers["User-Agent"] = "NeteaseMusic 9.0.90/5038 (iPhone; iOS 16.2; zh_CN)";
    if (cryptoMode === "api") {
      url = `${neteaseApiDomain}${uri}`;
    } else {
      payload = eapiEncrypt(uri, { ...payload, header });
      url = `${neteaseApiDomain}/eapi/${uri.slice(5)}`;
    }
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: new URLSearchParams(payload as Record<string, string>).toString(),
      signal: controller.signal,
    });
    const text = await response.text();
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(text) as Record<string, unknown>;
    } catch {
      body = { code: response.status, raw: text };
    }
    return {
      body,
      cookie: setCookies(response.headers),
      status: Number(body.code || response.status),
    };
  } finally {
    clearTimeout(timeout);
  }
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
      const route = routes[name];
      if (!route) throw new Error(`missing Netease API ${name}`);
      const response = await requestNetease(route.uri, route.data(args), args, route.crypto || "eapi");
      return route.shape ? route.shape(response) : response.body || {};
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
    const qrurl = `https://music.163.com/login?codekey=${encodeURIComponent(key)}`;
    return {
      code: 200,
      data: {
        qrurl,
        qrimg: await qrImage(qrurl),
      },
    };
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
