import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { createRequire } from "node:module";

import type { WebSocket as WebSocketType } from "ws";

import { config } from "./config.js";
import { runtimeStatus } from "./runtimeStatus.js";
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
import { AIStationDirector } from "./radio/stationDirector.js";
import { PlaybackQueue } from "./radio/playbackQueue.js";
import { StreamScheduler } from "./radio/scheduler.js";
import { DJEngine, shouldGenerateSegue } from "./radio/djEngine.js";
import { detectScene, localTimeBlock, normalizeGeo, trackInfo } from "./radio/context.js";
import type { StationEnvironment, TasteProfile, Track, UserSettings, WeatherSnapshot } from "./types.js";
import { compactText } from "./utils/text.js";
import { WeatherService } from "./services/weatherService.js";
import { RadioBrain, type BridgePick, type RadioBrainArgs } from "./radio/radioBrain.js";
import { IntentRouter } from "./radio/intentRouter.js";
import { DecisionTraceStore } from "./radio/decisionTraceStore.js";
import { HostResponder } from "./radio/hostResponder.js";
import { EpisodePlanner } from "./radio/episodePlanner.js";
import { QueueWarmer } from "./radio/queueWarmer.js";
import { ReflectionLoop } from "./radio/reflectionLoop.js";

const require = createRequire(import.meta.url);

process.on("uncaughtException", (error) => {
  console.error("[BOOT] uncaught exception", error);
});
process.on("unhandledRejection", (error) => {
  console.error("[BOOT] unhandled rejection", error);
});

console.log("[BOOT] starting FREQME TypeScript backend");
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
const stationDirector = new AIStationDirector(llm, djRequestAgent, searchVerifyAgent, djMemory);
const scheduler = new StreamScheduler(netease, store, audioResolver);
const djEngine = new DJEngine(llm);
const weatherService = new WeatherService();
const intentRouter = new IntentRouter();
const traceStore = new DecisionTraceStore(store);
const hostResponder = new HostResponder();
const episodePlanner = new EpisodePlanner(llm);
const reflectionLoop = new ReflectionLoop();
const queueWarmer = new QueueWarmer(searchVerifyAgent, traceStore);
const radioBrain = new RadioBrain({
  intentRouter,
  planner: episodePlanner,
  warmer: queueWarmer,
  responder: hostResponder,
  traceStore,
  reflectionLoop,
  bridgePicker: pickBridgeTrack,
});

const projectRoot = path.resolve(".");
const frontendDir = path.join(projectRoot, "frontend");

const server = http.createServer((req, res) => {
  void handleHttpRequest(req, res).catch((error) => {
    sendJson(res, 500, { error: error instanceof Error ? error.message : "server error" });
  });
});

console.log(`[BOOT] binding http://${config.host}:${config.port}`);
server.listen(config.port, config.host, () => {
  console.log(`FREQME TypeScript backend ready on http://${config.host}:${config.port}`);
  void setupWebSocket();
});

async function setupWebSocket(): Promise<void> {
  const { WebSocketServer } = require("ws") as { WebSocketServer: new (options: Record<string, unknown>) => { on: (event: string, handler: (socket: WebSocketType) => void) => void } };
  const wss = new WebSocketServer({ server, path: "/ws" });
  wss.on("connection", (socket: WebSocketType) => {
    void handleRadioSocket(socket);
  });
  console.log("[BOOT] websocket ready");
}

async function handleHttpRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const requestUrl = new URL(req.url || "/", `http://${config.host}:${config.port}`);
  const pathname = requestUrl.pathname;

  if (req.method === "GET" && pathname === "/health") {
    sendJson(res, 200, { status: "ok", backend: "typescript" });
    return;
  }
  if (req.method === "GET" && pathname === "/ready") {
    sendJson(res, 200, runtimeStatus());
    return;
  }
  if (req.method === "GET" && pathname === "/") {
    sendFile(res, path.join(frontendDir, "index.html"), "text/html; charset=utf-8");
    return;
  }
  if ((req.method === "GET" || req.method === "HEAD") && pathname === "/favicon.ico") {
    res.writeHead(204);
    res.end();
    return;
  }
  if (req.method === "GET" && (pathname.startsWith("/css/") || pathname.startsWith("/js/"))) {
    sendFrontendAsset(res, pathname);
    return;
  }
  if (req.method === "GET" && pathname === "/api/auth/qr/key") {
    sendJson(res, 200, await netease.qrKey());
    return;
  }
  if (req.method === "GET" && pathname === "/api/auth/qr/create") {
    sendJson(res, 200, await netease.qrCreate(requestUrl.searchParams.get("key") || ""));
    return;
  }
  if (req.method === "GET" && pathname === "/api/auth/qr/check") {
    sendJson(res, 200, await netease.qrCheck(requestUrl.searchParams.get("key") || ""));
    return;
  }
  if (req.method === "GET" && pathname === "/api/auth/status") {
    const status = await netease.loginStatus();
    const profile = extractProfile(status);
    const uid = profile.userId == null ? "" : String(profile.userId);
    if (uid) store.saveAuthAccount(uid, profile, netease.activeCookie());
    sendJson(res, 200, status);
    return;
  }
  if (req.method === "POST" && pathname === "/api/auth/refresh") {
    sendJson(res, 200, await netease.loginRefresh());
    return;
  }
  if (req.method === "GET" && pathname === "/api/auth/accounts") {
    sendJson(res, 200, {
      active_uid: currentStoredUid(),
      accounts: store.listAuthAccounts().map((account) => ({
        uid: account.uid,
        profile: account.account,
        updated_at: account.updatedAt,
      })),
    });
    return;
  }
  if (req.method === "POST" && pathname === "/api/auth/switch") {
    const body = await readJsonBody(req);
    const uid = compactText(body.uid || "", 80);
    const cookie = uid ? store.getAuthCookie(uid) : "";
    if (!uid || !cookie) {
      sendJson(res, 404, { error: "account not found" });
      return;
    }
    netease.useCookie(cookie);
    const status = await netease.loginStatus();
    const profile = extractProfile(status);
    const activeUid = profile.userId == null ? "" : String(profile.userId);
    if (activeUid && activeUid !== uid) {
      sendJson(res, 409, { error: "account cookie mismatch" });
      return;
    }
    if (activeUid) store.saveAuthAccount(activeUid, profile, netease.activeCookie());
    sendJson(res, 200, { active_uid: activeUid || uid, profile, status });
    return;
  }
  if (req.method === "POST" && pathname === "/api/auth/logout") {
    netease.clearCookie();
    sendJson(res, 200, { ok: true });
    return;
  }

  const onboardingUid = matchPrefix(pathname, "/api/radio/onboarding/");
  if (onboardingUid && req.method === "GET") {
    const uid = onboardingUid;
    if (!(await uidMatchesActiveLogin(uid))) {
      sendJson(res, 403, { error: "forbidden" });
      return;
    }
    const profile = store.getProfile(uid);
    const settings = store.getUserSettings(uid);
    sendJson(res, 200, {
      profile_ready: Boolean(profile),
      profile: profile || {},
      settings,
      onboarded: Boolean(settings),
    });
    return;
  }
  if (onboardingUid && req.method === "POST") {
    const uid = onboardingUid;
    if (!(await uidMatchesActiveLogin(uid))) {
      sendJson(res, 403, { error: "forbidden" });
      return;
    }
    const settings = normalizeSettings(await readJsonBody(req));
    store.saveUserSettings(uid, settings);
    sendJson(res, 200, { settings, onboarded: true });
    return;
  }

  const ttsHash = matchPrefix(pathname, "/api/radio/tts/");
  if (ttsHash && req.method === "GET") {
    const cached = tts.getCachedPath(ttsHash);
    if (!cached) {
      sendJson(res, 404, { error: "not found" });
      return;
    }
    sendFile(res, path.resolve(cached), "audio/wav");
    return;
  }

  const audioSongId = matchPrefix(pathname, "/api/radio/audio/");
  if (audioSongId && req.method === "GET") {
    const resolved = await audioResolver.resolve({ id: audioSongId, name: "", artist: "" }, null, requestUrl.searchParams.get("refresh") === "1");
    if (!resolved.ok || !resolved.url) {
      sendJson(res, 404, { error: resolved.reason || "audio unavailable" });
      return;
    }
    const range = Array.isArray(req.headers.range) ? req.headers.range[0] : req.headers.range;
    await proxyAudio(resolved.url, range, res, audioSongId);
    return;
  }

  const lyricSongId = matchPrefix(pathname, "/api/radio/lyrics/");
  if (lyricSongId && req.method === "GET") {
    sendJson(
      res,
      200,
      await lyrics.forSong(lyricSongId, {
        name: requestUrl.searchParams.get("name") || "",
        artist: requestUrl.searchParams.get("artist") || "",
      }),
    );
    return;
  }

  sendJson(res, 404, { error: "not found" });
}

function matchPrefix(pathname: string, prefix: string): string {
  return pathname.startsWith(prefix) ? decodeURIComponent(pathname.slice(prefix.length)) : "";
}

function sendJson(res: http.ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

async function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 1024 * 1024) throw new Error("request body too large");
    chunks.push(buffer);
  }
  if (!chunks.length) return {};
  const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
}

function sendFrontendAsset(res: http.ServerResponse, pathname: string): void {
  const file = path.resolve(frontendDir, decodeURIComponent(pathname.slice(1)));
  if (!file.startsWith(frontendDir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    sendJson(res, 404, { error: "not found" });
    return;
  }
  const contentType = file.endsWith(".js") ? "application/javascript; charset=utf-8" : "text/css; charset=utf-8";
  sendFile(res, file, contentType);
}

function sendFile(res: http.ServerResponse, file: string, contentType: string): void {
  if (!fs.existsSync(file)) {
    sendJson(res, 404, { error: "not found" });
    return;
  }
  res.writeHead(200, {
    "Content-Type": contentType,
    "Content-Length": fs.statSync(file).size,
    "Cache-Control": "public, max-age=0",
  });
  fs.createReadStream(file).pipe(res);
}

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

function stationEnvironment(scene: string, settings: Partial<UserSettings>, weather: WeatherSnapshot | null = null): StationEnvironment {
  const weatherText = weather
    ? [weather.condition, weather.temperatureC == null ? "" : `${weather.temperatureC}C`].filter(Boolean).join(" ")
    : "天气未知";
  return {
    scene,
    localTimeBlock: settings.localTimeBlock || "",
    timezoneName: settings.timezoneName,
    locale: settings.locale,
    regionHint: settings.regionHint,
    geo: settings.geo,
    weather,
    summary: [scene, settings.regionHint || "", settings.localTimeBlock || "", weatherText].filter(Boolean).join("，"),
  };
}

async function pickBridgeTrack(uid: string | null, profile: TasteProfile | null): Promise<BridgePick | null> {
  const tryCandidate = async (track: Track, reason: string): Promise<BridgePick | null> => {
    if (!track.id) return null;
    try {
      const prepared = await scheduler.prepareTrack(track, uid);
      if (!prepared) return null;
      return { track: prepared.track, url: prepared.url, reason };
    } catch {
      return null;
    }
  };

  for (const track of store.getRecentPlayableTracks(uid, 20)) {
    const bridge = await tryCandidate(track, "先接上一首确认可播的歌，让电台马上有声音。");
    if (bridge) return bridge;
  }

  for (const track of profile?.anchorTracks || []) {
    const bridge = await tryCandidate(track, "先从你的熟悉锚点开场，再慢慢往今天的频率展开。");
    if (bridge) return bridge;
  }

  return null;
}

async function proxyAudio(url: string, rangeHeader: string | undefined, res: http.ServerResponse, songId: string): Promise<void> {
  try {
    const headers: Record<string, string> = {};
    if (rangeHeader) headers.range = rangeHeader;
    const upstream = await fetch(url, { headers, redirect: "follow" });
    if (!upstream.ok || !upstream.body) {
      audioResolver.markFailed(songId, null, `upstream ${upstream.status}`);
      sendJson(res, 502, { error: `upstream ${upstream.status}` });
      return;
    }
    const mediaType = upstream.headers.get("content-type") || "audio/mpeg";
    if (!mediaType.toLowerCase().startsWith("audio/")) {
      sendJson(res, 502, { error: `upstream returned non-audio content: ${mediaType}` });
      return;
    }
    res.statusCode = upstream.status;
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
    sendJson(res, 502, { error: error instanceof Error ? error.message : "proxy failed" });
  }
}

async function handleRadioSocket(socket: WebSocketType): Promise<void> {
  let uid: string | null = null;
  let scene = "日常";
  let profile: TasteProfile | null = null;
  let settings: Partial<UserSettings> = {};
  let currentTrack: Track | null = null;
  let currentSongId: string | null = null;
  let sessionId: number | null = null;
  let environment: StationEnvironment = stationEnvironment(scene, settings);
  let trackIndex = 0;
  const playedTracks: Track[] = [];
  const loggedTrackIds = new Set<string>();
  const queue = new PlaybackQueue(1);
  const schedulerState = scheduler.newSessionState();
  const stationState = stationDirector.newSessionState();
  const recentTurns: Array<Record<string, unknown>> = [];
  let prewarmTask: Promise<void> | null = null;
  let introSendCancelled = false;

  const send = (payload: Record<string, unknown>): void => {
    if (socket.readyState === 1) socket.send(JSON.stringify(payload));
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

  const brainArgs = (requestText: string): RadioBrainArgs => {
    const readyQueue = queue.readyItems().map((item) => item.track);
    const recentTracks = playedTracks.slice(-8);
    const playbackContext = {
      currentTrack,
      recentTracks,
      playedTracks: recentTracks,
      readyQueue,
      scene,
      environment,
    };
    const contextPack = djMemory.buildContextPack({
      uid,
      sessionId,
      requestText,
      profile,
      userSettings: settings,
      playbackContext,
      recentTurns,
    });
    return {
      queue,
      uid,
      sessionId,
      profile,
      settings,
      environment,
      currentTrack,
      playedTracks,
      recentTurns,
      contextPack,
    };
  };

  const saveSessionWorkingMemory = (args: RadioBrainArgs): void => {
    if (uid && sessionId) {
      store.saveDjSessionMemory(uid, sessionId, args.contextPack.sessionWorkingMemory);
    }
  };

  const waitForReadyItem = async (timeoutMs = 9000): Promise<ReturnType<typeof queue.readyItems>[number] | null> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const ready = queue.readyItems()[0];
      if (ready) return ready;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return queue.readyItems()[0] || null;
  };

  const kickBrainContinuation = (): void => {
    prewarmTask = radioBrain
      .handleUserText({ ...brainArgs("继续保持这个感觉"), text: "继续保持这个感觉" })
      .then(() => undefined)
      .catch(() => undefined);
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
      const directed = await stationDirector.pickNext({
        state: stationState,
        uid,
        sessionId,
        profile,
        userSettings: settings,
        environment,
        currentTrack,
        playedTracks,
        readyQueue: queue.readyItems().map((item) => item.track),
        recentTurns,
      });
      if (directed.status === "queued" && directed.track && directed.url) {
        let segueText = "";
        let ttsHash = "";
        if (allowProgramBreak && shouldGenerateSegue(trackIndex + queue.readyItems().length + 1)) {
          segueText = await djEngine
            .generateProgramBreak({
              profile,
              scene,
              playedTracks,
              nextTrack: directed.track,
              settings,
            })
            .catch(() => "");
          if (segueText) ttsHash = await synthesize(segueText);
        }
        queue.addReady(
          directed.track,
          directed.url,
          directed.track.selectionReason || { type: "ai_station_director", text: directed.plan?.stationBrief || "AI 正在接管电台走向。" },
          { segueText, ttsHash },
        );
        added += 1;
        continue;
      }

      store.logPlaybackEvent("ai_station_degraded_fallback", { uid, songId: currentSongId, reason: directed.djText });
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
      const queuedTrack = {
        ...prepared.track,
        selectionReason: {
          type: "degraded_scheduler_fallback",
          text: prepared.track.selectionReason?.text || "AI 暂时没有拿到稳的计划，先用降级电台不断档。",
        },
      };
      let segueText = "";
      let ttsHash = "";
      if (allowProgramBreak && shouldGenerateSegue(trackIndex + queue.readyItems().length + 1)) {
        segueText = await djEngine
          .generateProgramBreak({
            profile,
            scene,
            playedTracks,
            nextTrack: queuedTrack,
            settings,
          })
          .catch(() => "");
        if (segueText) ttsHash = await synthesize(segueText);
      }
      queue.addReady(
        queuedTrack,
        prepared.url,
        queuedTrack.selectionReason,
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

  const runStationDirectorRequestFallback = async (requestText: string): Promise<void> => {
    const result = await stationDirector.handleUserRequest({
      requestText,
      state: stationState,
      uid,
      sessionId,
      profile,
      userSettings: settings,
      environment,
      currentTrack,
      playedTracks,
      readyQueue: queue.readyItems().map((item) => item.track),
      recentTurns,
    });
    recentTurns.push({ user: requestText, result: result.status, at: new Date().toISOString() });
    if (result.status === "queued" && result.track && result.url) {
      queue.clearReady();
      queue.addReady(
        result.track,
        result.url,
        result.track.selectionReason || { type: "ai_station_director", text: result.plan?.stationBrief || "AI 已经重排电台方向。" },
      );
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
    kickBrainContinuation();
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
        environment = stationEnvironment(scene, settings, await weatherService.current(settings.geo).catch(() => null));
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
        await radioBrain.startSession(brainArgs("startup")).catch(() => undefined);
        if (!queue.readyItems().length) {
          await fillQueue(1, false);
        }
        const item = queue.promoteNext();
        if (item) sendTrack(item.track, item.url);
        void (async () => {
          const intro = await introTask;
          if (!intro || introSendCancelled) return;
          const hash = await synthesize(intro);
          send({ type: "intro", text: intro, tts_ready: Boolean(hash), tts_hash: hash });
        })();
        kickBrainContinuation();
      }

      if (type === "track_ended") {
        await sendPreparedNext("played");
      }

      if (type === "skip") {
        queue.markCurrent("skipped");
        stationDirector.recordFeedback(stationState, { type: "skip", track: currentTrack ? trackInfo(currentTrack) : null });
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
        const args = brainArgs(requestText);
        const result = await radioBrain.handleUserText({ ...args, text: requestText }).catch(() => null);
        if (!result) {
          await runStationDirectorRequestFallback(requestText);
          return;
        }
        saveSessionWorkingMemory(args);
        if (result.status === "explained") {
          send({ type: "request_status", status: "explained", text: result.hostText });
          synthesizeAndSendDjMessage(result.hostText);
          recentTurns.push({ user: requestText, result: result.status, at: new Date().toISOString() });
          return;
        }
        send({ type: "request_status", status: "planning", text: result.hostText });
        synthesizeAndSendDjMessage(result.hostText);
        const ready = await waitForReadyItem(9000);
        if (ready) {
          recentTurns.push({ user: requestText, result: "ready", at: new Date().toISOString() });
          send({
            type: "request_status",
            status: "ready",
            text: ready.selectionReason.text || result.hostText,
            next_track: trackInfo(ready.track),
          });
          await sendPreparedNext("played");
          return;
        }
        await runStationDirectorRequestFallback(requestText);
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
