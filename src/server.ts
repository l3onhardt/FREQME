import fs from "node:fs";
import path from "node:path";
import http from "node:http";

import express from "express";
import { WebSocketServer, WebSocket } from "ws";

import { config } from "./config.js";
import { AppDatabase } from "./storage/database.js";
import { MemoryStore } from "./storage/memoryStore.js";
import { NeteaseService, extractProfile } from "./services/neteaseService.js";
import { AudioResolver } from "./services/audioResolver.js";
import { LLMRouter } from "./services/llmRouter.js";
import { TTSService } from "./services/ttsService.js";
import { LyricService } from "./services/lyricService.js";
import { ProfileEngine } from "./radio/profileEngine.js";
import { DJMemoryManager } from "./radio/djMemory.js";
import { DJRequestAgent } from "./radio/djRequestAgent.js";
import { SearchVerifyAgent } from "./radio/searchVerifyAgent.js";
import { QueueDirector } from "./radio/queueDirector.js";
import { PlaybackQueue } from "./radio/playbackQueue.js";
import { StreamScheduler } from "./radio/scheduler.js";
import { DJEngine, shouldGenerateSegue } from "./radio/djEngine.js";
import { detectScene, localTimeBlock, normalizeGeo, trackInfo } from "./radio/context.js";
import type { TasteProfile, Track, UserSettings } from "./types.js";
import { compactText } from "./utils/text.js";

const database = new AppDatabase();
const store = new MemoryStore(database);
const netease = new NeteaseService();
const llm = new LLMRouter(store);
const tts = new TTSService(store);
const audioResolver = new AudioResolver(netease, store);
const lyrics = new LyricService(netease);
const profileEngine = new ProfileEngine(netease, llm, store);
const djMemory = new DJMemoryManager(store);
const djRequestAgent = new DJRequestAgent(llm);
const searchVerifyAgent = new SearchVerifyAgent(llm, netease, audioResolver);
const queueDirector = new QueueDirector(djRequestAgent, searchVerifyAgent, djMemory);
const scheduler = new StreamScheduler(netease, store, audioResolver);
const djEngine = new DJEngine(llm);

const app = express();
app.use(express.json({ limit: "1mb" }));

const projectRoot = path.resolve(".");
const frontendDir = path.join(projectRoot, "frontend");

app.use("/css", express.static(path.join(frontendDir, "css")));
app.use("/js", express.static(path.join(frontendDir, "js")));

app.get("/health", (_req, res) => res.json({ status: "ok", backend: "typescript" }));
app.get("/", (_req, res) => res.sendFile(path.join(frontendDir, "index.html")));

app.get("/api/auth/qr/key", async (_req, res) => res.json(await netease.qrKey()));
app.get("/api/auth/qr/create", async (req, res) => res.json(await netease.qrCreate(String(req.query.key || ""))));
app.get("/api/auth/qr/check", async (req, res) => res.json(await netease.qrCheck(String(req.query.key || ""))));
app.get("/api/auth/status", async (_req, res) => {
  const status = await netease.loginStatus();
  const profile = extractProfile(status);
  const uid = profile.userId == null ? "" : String(profile.userId);
  if (uid) store.saveAuthAccount(uid, profile, netease.activeCookie());
  res.json(status);
});
app.post("/api/auth/refresh", async (_req, res) => res.json(await netease.loginRefresh()));
app.get("/api/auth/accounts", (_req, res) => {
  res.json({
    active_uid: currentStoredUid(),
    accounts: store.listAuthAccounts().map((account) => ({
      uid: account.uid,
      profile: account.account,
      updated_at: account.updatedAt,
    })),
  });
});
app.post("/api/auth/switch", async (req, res) => {
  const uid = compactText((req.body as Record<string, unknown> | undefined)?.uid || "", 80);
  const cookie = uid ? store.getAuthCookie(uid) : "";
  if (!uid || !cookie) {
    res.status(404).json({ error: "account not found" });
    return;
  }
  netease.useCookie(cookie);
  const status = await netease.loginStatus();
  const profile = extractProfile(status);
  const activeUid = profile.userId == null ? "" : String(profile.userId);
  if (activeUid && activeUid !== uid) {
    res.status(409).json({ error: "account cookie mismatch" });
    return;
  }
  if (activeUid) store.saveAuthAccount(activeUid, profile, netease.activeCookie());
  res.json({ active_uid: activeUid || uid, profile, status });
});
app.post("/api/auth/logout", (_req, res) => {
  netease.clearCookie();
  res.json({ ok: true });
});

app.get("/api/radio/onboarding/:uid", async (req, res) => {
  const uid = String(req.params.uid);
  if (!(await uidMatchesActiveLogin(uid))) {
    res.status(403).json({ error: "forbidden" });
    return;
  }
  const profile = store.getProfile(uid);
  const settings = store.getUserSettings(uid);
  res.json({
    profile_ready: Boolean(profile),
    profile: profile || {},
    settings,
    onboarded: Boolean(settings),
  });
});

app.post("/api/radio/onboarding/:uid", async (req, res) => {
  const uid = String(req.params.uid);
  if (!(await uidMatchesActiveLogin(uid))) {
    res.status(403).json({ error: "forbidden" });
    return;
  }
  const payload = req.body && typeof req.body === "object" ? req.body : {};
  const settings = normalizeSettings(payload);
  store.saveUserSettings(uid, settings);
  res.json({ settings, onboarded: true });
});

app.get("/api/radio/tts/:hash", (req, res) => {
  const cached = tts.getCachedPath(String(req.params.hash || ""));
  if (!cached) {
    res.status(404).json({ error: "not found" });
    return;
  }
  res.type("audio/wav").sendFile(path.resolve(cached));
});

app.get("/api/radio/audio/:songId", async (req, res) => {
  const songId = String(req.params.songId || "");
  const resolved = await audioResolver.resolve({ id: songId, name: "", artist: "" }, null, req.query.refresh === "1");
  if (!resolved.ok || !resolved.url) {
    res.status(404).json({ error: resolved.reason || "audio unavailable" });
    return;
  }
  await proxyAudio(resolved.url, req.headers.range, res, songId);
});

app.get("/api/radio/lyrics/:songId", async (req, res) => {
  const songId = String(req.params.songId || "");
  res.json(
    await lyrics.forSong(songId, {
      name: String(req.query.name || ""),
      artist: String(req.query.artist || ""),
    }),
  );
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });
wss.on("connection", (socket) => {
  void handleRadioSocket(socket);
});

server.listen(config.port, config.host, () => {
  console.log(`FREQME TypeScript backend ready on http://${config.host}:${config.port}`);
});

async function uidMatchesActiveLogin(uid: string): Promise<boolean> {
  if (!uid) return true;
  const status = await netease.loginStatus();
  const profile = extractProfile(status);
  const activeUid = profile.userId == null ? "" : String(profile.userId);
  return !activeUid || activeUid === uid;
}

function currentStoredUid(): string {
  const statusCookie = netease.activeCookie();
  if (!statusCookie) return "";
  for (const account of store.listAuthAccounts()) {
    if (store.getAuthCookie(account.uid) === statusCookie) return account.uid;
  }
  return "";
}

function normalizeSettings(payload: Record<string, unknown>): UserSettings {
  const voicePreset = compactText(payload.voice_preset || payload.voicePreset || "warm_female", 80);
  const currentMode = compactText(payload.current_mode || payload.currentMode || "陪伴", 40);
  return {
    voicePreset,
    displayName: compactText(payload.display_name || payload.displayName || "", 40),
    musicNotes: compactText(payload.music_notes || payload.musicNotes || "", 500),
    currentMode,
    timezoneName: compactText(payload.timezone_name || payload.timezoneName || "", 80),
    locale: compactText(payload.locale || "", 40),
    regionHint: compactText(payload.region_hint || payload.regionHint || "", 80),
    geo: normalizeGeo(payload.geo),
  };
}

async function proxyAudio(url: string, rangeHeader: string | undefined, res: express.Response, songId: string): Promise<void> {
  try {
    const headers: Record<string, string> = {};
    if (rangeHeader) headers.range = rangeHeader;
    const upstream = await fetch(url, { headers, redirect: "follow" });
    if (!upstream.ok || !upstream.body) {
      audioResolver.markFailed(songId, null, `upstream ${upstream.status}`);
      res.status(502).json({ error: `upstream ${upstream.status}` });
      return;
    }
    const mediaType = upstream.headers.get("content-type") || "audio/mpeg";
    if (!mediaType.toLowerCase().startsWith("audio/")) {
      res.status(502).json({ error: `upstream returned non-audio content: ${mediaType}` });
      return;
    }
    res.status(upstream.status);
    res.setHeader("Content-Type", mediaType);
    res.setHeader("Cache-Control", "public, max-age=3600");
    for (const header of ["accept-ranges", "content-range", "content-length"]) {
      const value = upstream.headers.get(header);
      if (value) res.setHeader(header, value);
    }
    const reader = upstream.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }
    res.end();
  } catch (error) {
    res.status(502).json({ error: error instanceof Error ? error.message : "proxy failed" });
  }
}

async function handleRadioSocket(socket: WebSocket): Promise<void> {
  let uid: string | null = null;
  let scene = "日常";
  let profile: TasteProfile | null = null;
  let settings: Partial<UserSettings> = {};
  let currentTrack: Track | null = null;
  let currentSongId: string | null = null;
  let sessionId: number | null = null;
  let trackIndex = 0;
  const playedTracks: Track[] = [];
  const loggedTrackIds = new Set<string>();
  const queue = new PlaybackQueue(1);
  const schedulerState = scheduler.newSessionState();
  const recentTurns: Array<Record<string, unknown>> = [];
  let prewarmTask: Promise<void> | null = null;
  let introSendCancelled = false;

  const send = (payload: Record<string, unknown>): void => {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
  };

  const synthesize = async (text: string): Promise<string> => {
    const result = await tts.synthesize(text, scene, settings.voicePreset, settings);
    return result.ok ? result.hash : "";
  };

  const synthesizeAndSendDjMessage = (text: string): void => {
    if (!text) return;
    send({ type: "dj_message", text, tts_ready: false, tts_hash: "" });
    void (async () => {
      const hash = await synthesize(text);
      if (hash) {
        send({ type: "dj_message", text, tts_ready: true, tts_hash: hash });
      }
    })().catch(() => undefined);
  };

  const rememberCurrentTrack = (track: Track): void => {
    currentTrack = track;
    currentSongId = track.id;
    trackIndex += 1;
    playedTracks.push(track);
    if (track.id && !loggedTrackIds.has(track.id)) {
      store.logTrack(uid, track, "scheduler");
      store.logPlaybackEvent("started", { uid, songId: track.id });
      loggedTrackIds.add(track.id);
    }
  };

  const sendTrack = (track: Track, url: string): void => {
    send({ type: "play_track", track: trackInfo(track), url });
    rememberCurrentTrack(track);
  };

  const fillQueue = async (maxItems?: number, allowProgramBreak = true): Promise<void> => {
    let added = 0;
    let attempts = 0;
    while (queue.prewarmNeeded() > 0) {
      if (maxItems != null && added >= maxItems) break;
      if (attempts >= 12) {
        const fallback = await addRecentPlayableFallback();
        if (fallback) added += 1;
        break;
      }
      attempts += 1;
      const track = await scheduler.pickNext({
        currentSongId,
        profile,
        userSettings: settings,
        sessionState: schedulerState,
        uid,
      });
      if (!track) break;
      const prepared = await scheduler.prepareTrack(track, uid);
      if (!prepared) continue;
      let segueText = "";
      let ttsHash = "";
      if (allowProgramBreak && shouldGenerateSegue(trackIndex + queue.readyItems().length + 1)) {
        segueText = await djEngine
          .generateProgramBreak({
            profile,
            scene,
            playedTracks,
            nextTrack: prepared.track,
            settings,
          })
          .catch(() => "");
        if (segueText) ttsHash = await synthesize(segueText);
      }
      queue.addReady(
        prepared.track,
        prepared.url,
        prepared.track.selectionReason || { type: "scheduler", text: "继续电台流。" },
        { segueText, ttsHash },
      );
      added += 1;
    }
  };

  const addRecentPlayableFallback = async (): Promise<boolean> => {
    for (const track of store.getRecentPlayableTracks(uid, 20)) {
      if (!track.id || track.id === currentSongId) continue;
      const prepared = await scheduler.prepareTrack(track, uid);
      if (!prepared) continue;
      queue.addReady(prepared.track, prepared.url, {
        type: "recent_playable_fallback",
        text: "先接上一首刚刚确认可播的歌，让电台不断档。",
      });
      return true;
    }
    return false;
  };

  const sendPreparedNext = async (previousEvent = "played"): Promise<void> => {
    if (prewarmTask) await Promise.race([prewarmTask, new Promise((resolve) => setTimeout(resolve, 1500))]).catch(() => null);
    if (!queue.readyItems().length) await fillQueue(1, false);
    const item = queue.promoteNext(previousEvent);
    if (!item) {
      send({ type: "error", message: "暂时没有更多歌曲，请稍后再试。" });
      return;
    }
    if (item.segueText) {
      send({
        type: "segue",
        text: item.segueText,
        tts_ready: Boolean(item.ttsHash),
        tts_hash: item.ttsHash || "",
        next_track: trackInfo(item.track),
        url: item.url,
      });
      rememberCurrentTrack(item.track);
    } else {
      sendTrack(item.track, item.url);
    }
    prewarmTask = fillQueue(1).catch(() => undefined);
  };

  socket.on("message", (raw) => {
    void (async () => {
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(raw.toString()) as Record<string, unknown>;
      } catch {
        return;
      }
      const type = String(message.type || "");
      if (type === "handshake") {
        uid = message.uid == null ? null : String(message.uid);
        if (uid && !(await uidMatchesActiveLogin(uid))) {
          send({ type: "error", message: "登录账号和当前电台用户不一致，请重新登录。" });
          socket.close();
          return;
        }
        const stored = uid ? store.getUserSettings(uid) : null;
        settings = {
          ...(stored || normalizeSettings((message.settings as Record<string, unknown>) || {})),
          timezoneName: compactText(message.timezone_name || "", 80) || stored?.timezoneName,
          locale: compactText(message.locale || "", 40) || stored?.locale,
          regionHint: compactText(message.region_hint || "", 80) || stored?.regionHint,
          geo: normalizeGeo(message.geo) || stored?.geo,
        };
        scene = detectScene(Number(message.utc_offset ?? 480));
        settings.localTimeBlock = localTimeBlock(scene);
        profile = uid ? store.getProfile(uid) : null;
        if (!profile && uid) {
          void profileEngine
            .analyze(uid)
            .then((analyzed) => {
              profile = analyzed;
            })
            .catch(() => undefined);
        }
        sessionId = uid ? store.createSession(uid) : null;
        const defaultIntro = djEngine.defaultIntro(scene);
        const defaultTtsTask = synthesize(defaultIntro).catch(() => "");
        const introTask = djEngine.generateIntro(profile, scene, settings).catch(() => "");
        send({
          type: "session_start",
          profile: profile || {},
          scene,
          intro_text: defaultIntro,
          tts_ready: false,
          tts_hash: "",
        });
        const defaultHash = await defaultTtsTask;
        send({ type: "intro", text: defaultIntro, tts_ready: Boolean(defaultHash), tts_hash: defaultHash });
        await fillQueue(1);
        const item = queue.promoteNext();
        if (item) sendTrack(item.track, item.url);
        void (async () => {
          const intro = await introTask;
          if (!intro || introSendCancelled) return;
          const hash = await synthesize(intro);
          send({ type: "intro", text: intro, tts_ready: Boolean(hash), tts_hash: hash });
        })();
        prewarmTask = fillQueue(1).catch(() => undefined);
      }

      if (type === "track_ended") {
        await sendPreparedNext("played");
      }

      if (type === "skip") {
        queue.markCurrent("skipped");
        if (currentSongId) {
          store.logPlaybackEvent("skipped", { uid, songId: currentSongId });
          if (profile) {
            profile.learned.skippedTrackIds = [currentSongId, ...profile.learned.skippedTrackIds.filter((id) => id !== currentSongId)].slice(0, 20);
            if (uid) store.saveProfile(uid, profile);
          }
        }
        await sendPreparedNext("skipped");
      }

      if (type === "song_request") {
        const requestText = compactText(message.text || "", 120);
        if (!requestText) return;
        introSendCancelled = true;
        store.logPlaybackEvent("song_request", { uid, songId: currentSongId, reason: requestText });
        const result = await queueDirector.handleSongRequest({
          requestText,
          playbackQueue: queue,
          uid,
          sessionId,
          profile,
          userSettings: settings,
          playbackContext: {
            currentTrack: trackInfo(currentTrack),
            recentTracks: playedTracks.slice(-10).map(trackInfo),
            readyQueue: queue.readyItems().map((item) => trackInfo(item.track)),
            scene,
          },
          recentTurns,
        });
        recentTurns.push({ user: requestText, result: result.status, at: new Date().toISOString() });
        if (result.status === "queued") {
          if (result.decision?.queuePolicy.continueDirection && result.decision.queuePolicy.durationTracks > 1) {
            scheduler.applyListeningIntent(
              schedulerState,
              {
                label:
                  result.decision.musicTask.styleHint ||
                  result.decision.musicTask.primaryEntities.map((entity) => entity.name).join(" / ") ||
                  requestText,
                rawText: requestText,
                expiresAfterTracks: result.decision.queuePolicy.durationTracks,
                constraints: result.decision.musicTask.negativeConstraints,
                seedTask: result.decision.musicTask,
              },
              settings,
            );
          }
          if (result.djText) {
            synthesizeAndSendDjMessage(result.djText);
          }
          const ready = queue.readyItems()[0];
          if (ready) {
            send({
              type: "request_status",
              status: "ready",
              text: ready.selectionReason.text || `下一首准备好了：${ready.track.name}`,
              next_track: trackInfo(ready.track),
            });
            void sendPreparedNext("played").catch(() => undefined);
          }
          prewarmTask = fillQueue(1, false).catch(() => undefined);
          return;
        }
        if (result.status === "ask") {
          send({ type: "request_status", status: "needs_clarification", text: result.djText });
          return;
        }
        send({ type: "request_status", status: "not_found", text: result.djText || "我没拿到足够稳的可播放版本，先不乱放。" });
      }
    })().catch((error) => {
      send({ type: "error", message: error instanceof Error ? error.message : "电台出错了。" });
    });
  });

  socket.on("close", () => {
    if (sessionId) store.endSession(sessionId, playedTracks.length, "用户断开");
  });
}

process.on("SIGINT", () => {
  server.close(() => process.exit(0));
});
