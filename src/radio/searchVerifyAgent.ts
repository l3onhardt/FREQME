import type { AudioResolver } from "../services/audioResolver.js";
import type { LLMRouter } from "../services/llmRouter.js";
import type { NeteaseService } from "../services/neteaseService.js";
import type { MusicTask, SearchVerification, Track } from "../types.js";
import { asStringList, compactText, dedupe, extractJsonObject, normalizeMatchText } from "../utils/text.js";

const minConfidence = 0.7;

export class SearchVerifyAgent {
  constructor(
    private readonly llm: LLMRouter,
    private readonly netease: NeteaseService,
    private readonly audioResolver: AudioResolver,
    private readonly llmTimeoutMs = 12000,
  ) {}

  async verify(musicTask: MusicTask, uid: string | null = null, rawUserText = ""): Promise<SearchVerification> {
    const queries = await this.queries(musicTask, rawUserText);
    const candidates: Track[] = [];
    for (const query of queries) {
      const found = await this.netease.search(query, 8).catch(() => []);
      for (const candidate of found.slice(0, 8)) {
        if (!this.isBadCandidate(candidate, musicTask)) {
          candidates.push({ ...candidate, source: query });
        }
      }
    }
    if (!candidates.length) return this.notFound(musicTask, queries, "No playable candidates were found.");

    const judgement: Record<string, unknown> = await this.judge(musicTask, candidates).catch(() => ({}));
    let song = this.chosenSong(candidates, judgement);
    if (!song) song = this.locallyVerifiedSong(candidates, musicTask);
    if (song && !this.candidateMatchesRequiredEntities(song, musicTask)) {
      song = null;
    }
    if (!song) return this.notFound(musicTask, queries, "No candidate passed verification.");

    const resolved = await this.audioResolver.resolveWithCandidates(song, uid);
    if (!resolved.ok) {
      return this.notFound(musicTask, queries, "The verified candidate is not playable.");
    }

    const selectedSong = { ...song, id: resolved.songId || song.id };
    return {
      status: "verified",
      selectedSong,
      url: resolved.proxyUrl,
      verification: {
        confidence: Number(judgement.confidence || 0.72),
        matchedEntities: asStringList(judgement.matched_entities, 8),
        versionNote: compactText(judgement.version_note || "Candidate metadata matches the music task.", 180),
        risk: compactText(judgement.risk || "", 160),
      },
      fallbackCandidates: [],
      recoveryOptions: [],
      usedQuery: song.source || queries[0] || "",
    };
  }

  async queries(musicTask: MusicTask, rawUserText = ""): Promise<string[]> {
    const goals = this.cleanQueries(musicTask.searchGoals, rawUserText);
    const requiresConcrete = this.requiresConcreteQueries(musicTask);
    const fastQueries = this.fastConcreteQueries(musicTask, goals);
    if (fastQueries.length) return fastQueries;
    const concreteGoals = goals.filter((query) => this.looksConcrete(query, musicTask));
    if (requiresConcrete && concreteGoals.length) return concreteGoals.slice(0, 6);

    const prompt = `Rewrite this DJ music task into concrete NetEase Cloud Music song searches.

Rules:
- Think as a search-planning agent, not as a keyword matcher.
- For scene, genre, mood, time, continuation, and artist/band directions, infer 3 to 5 concrete songs first.
- Return queries shaped like "artist title" whenever possible.
- Do not return only a bare artist, bare genre, playlist bucket, or the literal listener sentence.
- Avoid playlists, compilations, utility audio, study/sleep audio, KTV, backing tracks, and unrequested covers.
- Keep performer/composer/work hints when the task asks for a performer or classical work.

Music task:
${JSON.stringify(musicTask, null, 2)}

Return only JSON:
{"search_queries": ["artist title"], "picks": [{"artist": "", "title": "", "query": "", "reason": ""}]}`;

    const generated = await this.llm
      .chat(prompt, {
        maxTokens: 420,
        system: "You are a DJ search planning agent. Return only valid JSON.",
        responseFormat: { type: "json_object" },
        timeoutMs: this.llmTimeoutMs,
      })
      .then((text) => this.cleanQueries(this.plannedQueryValues(extractJsonObject(text)), rawUserText))
      .catch(() => []);

    const merged = dedupe([...generated, ...goals]);
    if (!requiresConcrete) return merged.length ? merged.slice(0, 6) : this.structuredFallback(musicTask, rawUserText);
    const concrete = merged.filter((query) => this.looksConcrete(query, musicTask));
    return concrete.slice(0, 6);
  }

  private async judge(musicTask: MusicTask, candidates: Track[]): Promise<Record<string, unknown>> {
    const bounded = candidates.slice(0, 16).map((track) => ({
      id: track.id,
      name: track.name,
      artist: track.artist,
      album: track.album,
      aliases: track.aliases,
      sourceQuery: track.source,
    }));
    const prompt = `Choose the most reliable playable song candidate for this DJ task.

Music task:
${JSON.stringify(musicTask, null, 2)}

Candidates:
${JSON.stringify(bounded, null, 2)}

Reject playlists, utility audio, study/sleep audio, KTV/backing tracks, wrong artists, wrong performers, and unrequested covers.

Return only JSON:
{"chosen_id": "candidate id or empty", "confidence": 0.0, "matched_entities": [], "version_note": "", "risk": "", "fallback_candidates": [], "recovery_options": []}`;
    const text = await this.llm.chat(prompt, {
      maxTokens: 360,
      system: "You are a music search verification agent. Return only valid JSON.",
      responseFormat: { type: "json_object" },
      timeoutMs: this.llmTimeoutMs,
    });
    return extractJsonObject(text);
  }

  private plannedQueryValues(data: Record<string, unknown>): string[] {
    const values: string[] = [];
    if (Array.isArray(data.picks)) {
      for (const pick of data.picks) {
        if (!pick || typeof pick !== "object" || Array.isArray(pick)) continue;
        const source = pick as Record<string, unknown>;
        const query = compactText(source.query || [source.artist, source.title].filter(Boolean).join(" "), 120);
        if (query) values.push(query);
      }
    }
    if (Array.isArray(data.search_queries)) {
      values.push(...data.search_queries.map((query) => compactText(query, 120)));
    }
    return values;
  }

  private cleanQueries(values: string[], rawUserText: string): string[] {
    const raw = compactText(rawUserText, 120);
    return dedupe(
      values
        .map((value) => compactText(value, 120))
        .filter((query) => query && query !== raw)
        .filter((query) => !this.looksSceneBucket(query))
        .filter((query) => !this.looksCommandSentence(query)),
    );
  }

  private requiresConcreteQueries(task: MusicTask): boolean {
    return ["artist_direction", "artist_work_direction", "scene_genre_direction", "continuation", "negative_feedback"].includes(task.type);
  }

  private fastConcreteQueries(task: MusicTask, goals: string[]): string[] {
    if (task.type !== "specific_track") return [];
    const query = goals[0] || dedupe([...task.primaryEntities.map((entity) => entity.name), task.workHint, task.styleHint]).join(" ");
    return query ? [query] : [];
  }

  private looksConcrete(query: string, task: MusicTask): boolean {
    const text = compactText(query);
    if (
      !text ||
      this.looksSceneBucket(text) ||
      this.looksStyleBucket(text, task) ||
      this.looksBareEntity(text, task) ||
      this.looksCommandSentence(text)
    ) {
      return false;
    }
    const ascii = text.match(/[A-Za-z0-9][A-Za-z0-9'.+&-]*/gu) || [];
    const cjk = text.match(/[\u4e00-\u9fff]+/gu) || [];
    if (ascii.length >= 2) return true;
    if (cjk.length >= 2 && /\s/u.test(text)) return true;
    return Boolean(ascii.length && cjk.length && /\s/u.test(text));
  }

  private looksBareEntity(query: string, task: MusicTask): boolean {
    const normalized = normalizeMatchText(query);
    const values = [...task.primaryEntities.map((entity) => entity.name), task.styleHint, task.workHint].filter(Boolean);
    return values.some((value) => normalizeMatchText(value) === normalized);
  }

  private looksStyleBucket(query: string, task: MusicTask): boolean {
    if (!["scene_genre_direction", "continuation", "negative_feedback"].includes(task.type)) return false;
    const normalized = normalizeMatchText(query);
    const styleValues = [...task.primaryEntities.map((entity) => entity.name), task.styleHint]
      .map((value) => normalizeMatchText(value))
      .filter(Boolean);
    const containsStyle = styleValues.some((value) => normalized.includes(value));
    if (!containsStyle) return false;

    const generic = new Set([
      "song",
      "songs",
      "artist",
      "artists",
      "track",
      "tracks",
      "music",
      "classic",
      "classics",
      "hit",
      "hits",
      "playlist",
      "mix",
      "slow",
      "jam",
      "jams",
      "quiet",
      "night",
      "chill",
      "mellow",
      "华语",
      "中文",
      "英文",
      "欧美",
      "经典",
      "热门",
      "歌",
      "歌手",
      "歌曲",
      "音乐",
    ]);
    const tokens = query.match(/[A-Za-z0-9][A-Za-z0-9'.+&-]*|[\u4e00-\u9fff]+/gu) || [];
    const contentTokens = tokens
      .map((token) => normalizeMatchText(token))
      .filter((token) => token && !generic.has(token) && !styleValues.some((style) => style.includes(token) || token.includes(style)));
    return contentTokens.length < 2;
  }

  private looksCommandSentence(query: string): boolean {
    return (
      /^(不要|别放|我想听|想听|我要听|我要|来点|放点|播点|播放|给我听|给我放)/u.test(query) ||
      /^(please|play|put on|i want|i'd like)\b/iu.test(query)
    );
  }

  private looksSceneBucket(query: string): boolean {
    const lowered = query.toLowerCase();
    const bucket = /(歌单|歌曲|音乐|playlist|mix|合集|学习|睡眠|白噪音)/iu.test(lowered);
    const scene = /(晚上|夜晚|深夜|睡前|安静|舒缓|放松|氛围|mellow|chill|emo|rnb|r&b)/iu.test(lowered);
    const specificAscii = /[A-Za-z][A-Za-z0-9'.+&-]*\s+[A-Za-z][A-Za-z0-9'.+&-]*/u.test(query);
    return (bucket && scene && !specificAscii) || (scene && query.split(/\s+/u).length <= 3 && !specificAscii);
  }

  private isBadCandidate(track: Track, task: MusicTask): boolean {
    const text = `${track.name} ${track.artist} ${track.album || ""} ${(track.aliases || []).join(" ")}`.toLowerCase();
    if (/(歌单|playlist|study|学习|自习|white noise|白噪音|sleep music|睡眠|助眠|sound effect|背景音乐|纯音乐盒)/iu.test(text)) {
      return true;
    }
    const versionTokens = this.versionCategories(text);
    if (!versionTokens.size) return false;
    const allowed = this.versionCategories(JSON.stringify(task).toLowerCase());
    for (const token of versionTokens) {
      if (!allowed.has(token)) return true;
    }
    return false;
  }

  private versionCategories(text: string): Set<string> {
    const result = new Set<string>();
    if (/(cover|翻唱)/iu.test(text)) result.add("cover");
    if (/(ktv|karaoke|卡拉ok)/iu.test(text)) result.add("ktv");
    if (/(伴奏|backing|accompaniment)/iu.test(text)) result.add("accompaniment");
    return result;
  }

  private chosenSong(candidates: Track[], judgement: Record<string, unknown>): Track | null {
    const confidence = Number(judgement.confidence || 0);
    if (!Number.isFinite(confidence) || confidence < minConfidence) return null;
    const chosenId = compactText(judgement.chosen_id || "", 80);
    if (!chosenId) return null;
    return candidates.find((candidate) => candidate.id === chosenId) || null;
  }

  private locallyVerifiedSong(candidates: Track[], task: MusicTask): Track | null {
    return (
      candidates.slice(0, 8).find((candidate) => {
        if (!candidate.source || !this.looksConcrete(candidate.source, task)) return false;
        if (this.isBadCandidate(candidate, task)) return false;
        const metadata = normalizeMatchText(`${candidate.artist} ${candidate.name} ${candidate.album || ""}`);
        const tokens = candidate.source
          .split(/\s+/u)
          .map((token) => normalizeMatchText(token))
          .filter((token) => token && !["the", "a", "an", "of", "and", "version"].includes(token));
        return tokens.filter((token) => metadata.includes(token)).length >= Math.min(2, tokens.length);
      }) || null
    );
  }

  private candidateMatchesRequiredEntities(candidate: Track, task: MusicTask): boolean {
    if (!["artist_direction", "artist_work_direction", "specific_track"].includes(task.type)) return true;
    const required = task.primaryEntities.filter((entity) => ["artist", "performer", "composer", "music_entity"].includes(entity.role));
    if (!required.length) return true;
    const metadata = normalizeMatchText(`${candidate.artist} ${candidate.name} ${candidate.album || ""} ${(candidate.aliases || []).join(" ")}`);
    return required.some((entity) => {
      const expected = normalizeMatchText(entity.name);
      return expected && (metadata.includes(expected) || expected.includes(normalizeMatchText(candidate.artist)));
    });
  }

  private structuredFallback(task: MusicTask, rawUserText: string): string[] {
    const parts = [...task.primaryEntities.map((entity) => entity.name), task.workHint, task.styleHint].filter(Boolean);
    const query = compactText(parts.join(" "), 120);
    return query && query !== compactText(rawUserText, 120) ? [query] : [];
  }

  private notFound(task: MusicTask, queries: string[], reason: string): SearchVerification {
    const entityText = [...task.primaryEntities.map((entity) => entity.name), task.workHint, task.styleHint].filter(Boolean).join(" ");
    return {
      status: "not_found",
      verification: {},
      fallbackCandidates: [],
      recoveryOptions: entityText
        ? [
            {
              type: "adjacent_version",
              task: entityText,
              reason: "Keep the music direction but relax exact version constraints.",
            },
          ]
        : [],
      failureReason: reason,
      usedQuery: queries[0] || "",
    };
  }
}
