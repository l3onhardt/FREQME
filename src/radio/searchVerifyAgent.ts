import type { AudioResolver } from "../services/audioResolver.js";
import type { LLMRouter } from "../services/llmRouter.js";
import type { NeteaseService } from "../services/neteaseService.js";
import type { MemoryPack, MusicTask, SearchVerification, Track } from "../types.js";
import { asStringList, compactText, dedupe, extractJsonObject, normalizeMatchText } from "../utils/text.js";

const minConfidence = 0.7;

interface QueryPlan {
  queries: string[];
  rejectedQueries: string[];
  generatedQueries: string[];
}

type QueryResultDiagnostic = NonNullable<NonNullable<SearchVerification["diagnostics"]>["queryResults"]>[number];
type AudioAttemptDiagnostic = NonNullable<NonNullable<SearchVerification["diagnostics"]>["audioAttempts"]>[number];

export class SearchVerifyAgent {
  constructor(
    private readonly llm: LLMRouter,
    private readonly netease: NeteaseService,
    private readonly audioResolver: AudioResolver,
    private readonly llmTimeoutMs = 12000,
  ) {}

  async verify(
    musicTask: MusicTask,
    uid: string | null = null,
    rawUserText = "",
    contextPack?: MemoryPack,
  ): Promise<SearchVerification> {
    const plan = await this.queryPlan(musicTask, rawUserText, contextPack);
    const queries = plan.queries;
    if (this.requiresConcreteQueries(musicTask) && !queries.length && plan.rejectedQueries.length) {
      return this.notFound(musicTask, queries, "Search planner did not produce concrete song queries.", {
        rejectedQueries: plan.rejectedQueries,
        generatedQueries: plan.generatedQueries,
      });
    }
    const candidates: Track[] = [];
    const queryResults: QueryResultDiagnostic[] = [];
    for (const query of queries) {
      const found = await this.netease.search(query, 8).catch(() => []);
      const results: QueryResultDiagnostic["results"] = [];
      for (const candidate of found.slice(0, 8)) {
        const rejectedReason = this.badCandidateReason(candidate, musicTask);
        results.push({
          id: candidate.id,
          name: candidate.name,
          artist: candidate.artist,
          album: candidate.album,
          accepted: !rejectedReason,
          reason: rejectedReason,
        });
        if (!rejectedReason) {
          candidates.push({ ...candidate, source: query });
        }
      }
      queryResults.push({ query, results });
    }
    if (!candidates.length) {
      return this.notFound(musicTask, queries, "No playable candidates were found.", {
        searchedQueries: queries,
        rejectedQueries: plan.rejectedQueries,
        generatedQueries: plan.generatedQueries,
        queryResults,
      });
    }

    const judgement: Record<string, unknown> = await this.judge(musicTask, candidates).catch(() => ({}));
    const rankedSongs = this.rankedSongs(candidates, judgement, musicTask);
    if (!rankedSongs.length) {
      return this.notFound(musicTask, queries, "No candidate passed verification.", {
        searchedQueries: queries,
        candidateIds: candidates.map((candidate) => candidate.id).filter(Boolean),
        generatedQueries: plan.generatedQueries,
        queryResults,
        verifier: this.verifierDiagnostic(judgement),
      });
    }

    const attemptedSongIds: string[] = [];
    const audioAttempts: AudioAttemptDiagnostic[] = [];
    for (const song of rankedSongs) {
      attemptedSongIds.push(song.id);
      const resolved = await this.audioResolver.resolveWithCandidates(song, uid);
      audioAttempts.push({
        songId: song.id,
        name: song.name,
        artist: song.artist,
        sourceQuery: song.source,
        ok: resolved.ok,
        reason: resolved.reason,
        resolvedSongId: resolved.songId,
      });
      if (!resolved.ok) continue;

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
        diagnostics: {
          searchedQueries: queries,
          rejectedQueries: plan.rejectedQueries,
          generatedQueries: plan.generatedQueries,
          candidateIds: candidates.map((candidate) => candidate.id).filter(Boolean),
          attemptedSongIds,
          queryResults,
          verifier: this.verifierDiagnostic(judgement),
          audioAttempts,
        },
      };
    }

    return this.notFound(musicTask, queries, "Verified candidates were not playable.", {
      searchedQueries: queries,
      candidateIds: candidates.map((candidate) => candidate.id).filter(Boolean),
      attemptedSongIds,
      generatedQueries: plan.generatedQueries,
      queryResults,
      verifier: this.verifierDiagnostic(judgement),
      audioAttempts,
    });
  }

  async queries(musicTask: MusicTask, rawUserText = "", contextPack?: MemoryPack): Promise<string[]> {
    return (await this.queryPlan(musicTask, rawUserText, contextPack)).queries;
  }

  private async queryPlan(musicTask: MusicTask, rawUserText = "", contextPack?: MemoryPack): Promise<QueryPlan> {
    const goals = this.cleanQueries(musicTask.searchGoals, rawUserText).filter(
      (query) => !this.violatesNegativeConstraints(query, musicTask),
    );
    const requiresConcrete = this.requiresConcreteQueries(musicTask);
    const fastQueries = this.fastConcreteQueries(musicTask, goals);
    if (fastQueries.length) return { queries: fastQueries, rejectedQueries: [], generatedQueries: [] };
    const concreteGoals = goals.filter((query) => this.looksConcrete(query, musicTask));
    if (requiresConcrete && concreteGoals.length && !this.shouldPersonalizeWithPlanner(musicTask, contextPack)) {
      return {
        queries: concreteGoals.slice(0, 6),
        rejectedQueries: goals.filter((query) => !concreteGoals.includes(query)),
        generatedQueries: [],
      };
    }

    const prompt = `Rewrite this DJ music task into concrete NetEase Cloud Music song searches.

Rules:
- Think as a search-planning agent, not as a keyword matcher.
- First infer what this specific listener is likely to mean using their taste profile, recent tracks, session memory, and constraints.
- For scene, genre, mood, time, continuation, and artist/band directions, curate 4 to 8 concrete songs first.
- Return queries shaped like "artist title" whenever possible.
- Do not return only a bare artist, bare genre, playlist bucket, or the literal listener sentence.
- If the task names a performer/composer/arranger/producer/music entity rather than a song, infer representative recordings or works and include useful aliases/transliterations in the queries.
- For classical performers, pianist names, conductors, or composers, queries may be "performer composer work" or "performer work".
- Avoid playlists, compilations, utility audio, study/sleep audio, KTV, backing tracks, and unrequested covers.
- Keep performer/composer/work hints when the task asks for a performer or classical work.
- Prefer songs that fit both the listener's profile and the new request. Use profile anchors as taste signals, not as the only songs to play.
- If the request is abstract, treat search_goals as seed hints; do not stop after one generic or unplayable candidate.

Personal listener context:
${JSON.stringify(this.planningContext(contextPack), null, 2)}

Music task:
${JSON.stringify(musicTask, null, 2)}

Return only JSON:
{"search_queries": ["artist title"], "picks": [{"artist": "", "title": "", "query": "", "reason": ""}]}`;

    const generatedRaw = await this.llm
      .chat(prompt, {
        maxTokens: 420,
        system: "You are a DJ search planning agent. Return only valid JSON.",
        responseFormat: { type: "json_object" },
        timeoutMs: this.llmTimeoutMs,
      })
      .then((text) => this.plannedQueryValues(extractJsonObject(text)))
      .catch(() => []);
    const generated = this.cleanQueries(generatedRaw, rawUserText).filter(
      (query) => !this.violatesNegativeConstraints(query, musicTask),
    );

    const merged = dedupe([...generated, ...goals]);
    if (!requiresConcrete) {
      const fallback = merged.length ? merged.slice(0, 6) : this.structuredFallback(musicTask, rawUserText);
      return {
        queries: fallback,
        rejectedQueries: generatedRaw.filter((query) => !fallback.includes(query)),
        generatedQueries: generated,
      };
    }
    const concrete = merged.filter(
      (query) => this.looksConcrete(query, musicTask) && !this.violatesNegativeConstraints(query, musicTask),
    );
    const fallback = concrete.length ? [] : this.fallbackQueries(musicTask, goals, rawUserText, contextPack);
    const fallbackQueries = fallback.filter(
      (query) => !concrete.includes(query) && !this.violatesNegativeConstraints(query, musicTask),
    );
    return {
      queries: dedupe([...concrete, ...fallbackQueries]).slice(0, 6),
      rejectedQueries: dedupe([...generatedRaw, ...goals]).filter(
        (query) => !concrete.includes(query) && !fallbackQueries.includes(query),
      ),
      generatedQueries: generated,
    };
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

Use semantic matching, aliases, translations, and transliterations when judging performers/composers/works. Reject playlists, utility audio, study/sleep audio, KTV/backing tracks, wrong artists, wrong performers, and unrequested covers.

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
      this.looksDescriptiveSearchGoal(text) ||
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

  private looksDescriptiveSearchGoal(query: string): boolean {
    const normalized = normalizeMatchText(query);
    return /(matching|similar|basedon|taste|summary|profile|vibe|mood|music|tracks|songs|playlist|recommendations)/iu.test(normalized);
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

  private badCandidateReason(track: Track, task: MusicTask): string {
    if (!this.candidateMatchesRequiredEntities(track, task)) return "required_entity_mismatch";
    const negativeReason = this.negativeCandidateReason(track, task);
    if (negativeReason) return negativeReason;
    return this.isBadCandidate(track, task) ? "filtered_candidate" : "";
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

  private rankedSongs(candidates: Track[], judgement: Record<string, unknown>, task: MusicTask): Track[] {
    if (this.isExplicitVerifierRejection(judgement)) return [];
    const ranked: Track[] = [];
    const chosen = this.chosenSong(candidates, judgement);
    if (chosen) ranked.push(chosen);
    const local = this.locallyVerifiedSong(candidates, task);
    if (local) ranked.push(local);
    if (ranked.length) ranked.push(...candidates);
    return ranked.filter((song, index, list) => list.findIndex((item) => item.id === song.id) === index).slice(0, 12);
  }

  private shouldPersonalizeWithPlanner(task: MusicTask, contextPack?: MemoryPack): boolean {
    if (!contextPack) return false;
    if (!["scene_genre_direction", "continuation", "negative_feedback", "artist_direction"].includes(task.type)) return false;
    return Boolean(
      compactText(contextPack.userProfileDigest, 40) ||
        contextPack.retrievedMemories.length ||
        contextPack.recentTurns.length ||
        Object.keys(contextPack.sessionWorkingMemory || {}).length ||
        Object.keys(contextPack.playbackContext || {}).length,
    );
  }

  private planningContext(contextPack?: MemoryPack): Record<string, unknown> {
    if (!contextPack) return {};
    const playback = contextPack.playbackContext || {};
    const settings = contextPack.userSettings || {};
    return {
      profileDigest: compactText(contextPack.userProfileDigest, 900),
      sessionMemory: this.compactJson(contextPack.sessionWorkingMemory, 700),
      recentTurns: contextPack.recentTurns.slice(-5),
      retrievedMemories: contextPack.retrievedMemories.slice(0, 5),
      playback: {
        currentTrack: (playback as Record<string, unknown>).currentTrack,
        recentTracks: Array.isArray((playback as Record<string, unknown>).recentTracks)
          ? ((playback as Record<string, unknown>).recentTracks as unknown[]).slice(-8)
          : [],
        readyQueue: Array.isArray((playback as Record<string, unknown>).readyQueue)
          ? ((playback as Record<string, unknown>).readyQueue as unknown[]).slice(0, 5)
          : [],
        scene: (playback as Record<string, unknown>).scene,
      },
      settings: {
        currentMode: settings.currentMode,
        musicNotes: compactText(settings.musicNotes || "", 300),
        timezoneName: settings.timezoneName,
        locale: settings.locale,
        regionHint: settings.regionHint,
        localTimeBlock: settings.localTimeBlock,
      },
      constraints: contextPack.hardConstraints.slice(0, 5),
    };
  }

  private compactJson(value: unknown, maxLength: number): string {
    return compactText(JSON.stringify(value ?? {}), maxLength);
  }

  private structuredFallback(task: MusicTask, rawUserText: string): string[] {
    const parts = [...task.primaryEntities.map((entity) => entity.name), task.workHint, task.styleHint].filter(Boolean);
    const query = compactText(parts.join(" "), 120);
    return query && query !== compactText(rawUserText, 120) ? [query] : [];
  }

  private fallbackQueries(task: MusicTask, goals: string[], rawUserText: string, contextPack?: MemoryPack): string[] {
    return task.type === "scene_genre_direction"
      ? this.sceneFallbackQueries(task, rawUserText, contextPack)
      : this.entityFallbackQueries(task, goals, rawUserText);
  }

  private entityFallbackQueries(task: MusicTask, goals: string[], rawUserText: string): string[] {
    if (!["artist_direction", "artist_work_direction"].includes(task.type)) return [];
    const entities = task.primaryEntities
      .filter((entity) => ["artist", "performer", "composer", "arranger", "producer", "music_entity"].includes(entity.role))
      .map((entity) => entity.name);
    const seeds = dedupe([...entities, ...goals]).filter((query) => !this.looksSceneBucket(query) && !this.looksCommandSentence(query));
    const work = compactText(task.workHint, 80);
    const style = compactText(task.styleHint, 80);
    const raw = compactText(rawUserText, 120);
    const queries: string[] = [];
    for (const seed of seeds) {
      if (work) queries.push(`${seed} ${work}`);
      if (/piano|classical|chopin|beethoven|brahms|concerto|sonata|ballade|nocturne|古典|钢琴|肖邦|贝多芬|勃拉姆斯/u.test(`${seed} ${style} ${work}`)) {
        queries.push(`${seed} Chopin`);
        queries.push(`${seed} piano recordings`);
      }
      queries.push(seed);
    }
    return this.cleanQueries(queries, raw).filter((query) => query !== raw).slice(0, 6);
  }

  private sceneFallbackQueries(task: MusicTask, rawUserText: string, contextPack?: MemoryPack): string[] {
    const positiveParts = [
      task.styleHint,
      task.workHint,
      ...task.primaryEntities.map((entity) => entity.name),
      ...task.searchGoals,
    ];
    if (!task.negativeConstraints.length) positiveParts.push(rawUserText);
    const text = positiveParts.join(" ");
    const styleSeeds = this.styleSeedQueries(text, task);
    return this.cleanQueries(styleSeeds, rawUserText)
      .filter((query) => this.looksConcrete(query, task))
      .filter((query) => !this.violatesNegativeConstraints(query, task))
      .slice(0, 6);
  }

  private profileAnchorQueries(contextPack: MemoryPack | undefined, task: MusicTask): string[] {
    const digest = contextPack?.userProfileDigest || "";
    const matches = [...digest.matchAll(/([A-Za-z][A-Za-z0-9'.+&-]*(?:\s+[A-Za-z][A-Za-z0-9'.+&-]*){0,2})\s+([A-Za-z][A-Za-z0-9'.+&-]*(?:\s+[A-Za-z][A-Za-z0-9'.+&-]*){0,4})/gu)];
    const values = matches
      .map((match) => compactText(`${match[1]} ${match[2]}`, 100))
      .filter((query) => this.looksConcrete(query, task) && !this.looksStyleBucket(query, task));
    return dedupe(values);
  }

  private styleSeedQueries(normalizedText: string, task: MusicTask): string[] {
    const normalized = normalizeMatchText(normalizedText);
    const blocked = this.normalizedNegativeText(task);
    const blocksRnb = blocked.includes("rnb") || blocked.includes("rb");
    if (!blocksRnb && this.hasRnbMarker(normalizedText)) {
      return [
        "SZA Snooze",
        "Daniel Caesar Japanese Denim",
        "Frank Ocean Pink + White",
        "H.E.R. Focus",
        "Kelela LMK",
        "Brent Faiyaz Clouded",
      ];
    }
    if (normalized.includes("futurebass") || normalized.includes("melodicfuturebass")) {
      return [
        "Seven Lions Rush Over Me",
        "ILLENIUM Good Things Fall Apart",
        "San Holo Light",
        "Flume Never Be Like You",
        "Porter Robinson Shelter",
        "Said The Sky All I Got",
      ];
    }
    if (
      normalized.includes("organichouse") ||
      normalized.includes("chillout") ||
      normalized.includes("ambient") ||
      normalized.includes("舒缓") ||
      normalized.includes("舒服") ||
      normalized.includes("放松")
    ) {
      return [
        "Ben Bohmer Beyond Beliefs",
        "Nora En Pure Come With Me",
        "Lane 8 Atlas",
        "Bonobo Kerala",
        "Tycho Awake",
        "Kiasmos Looped",
      ];
    }
    if (normalized.includes("jazz")) {
      return ["Bill Evans Waltz for Debby", "Chet Baker I Fall In Love Too Easily", "Miles Davis Blue in Green"];
    }
    if (normalized.includes("citypop")) {
      return ["Mariya Takeuchi Plastic Love", "Anri Last Summer Whisper", "Taeko Ohnuki 4:00 AM"];
    }
    if (normalized.includes("shoegaze")) {
      return ["Slowdive Sugar for the Pill", "my bloody valentine When You Sleep", "Ride Vapour Trail"];
    }
    return [];
  }

  private hasRnbMarker(text: string): boolean {
    return /\br\s*&?\s*b\b|\brnb\b/iu.test(text);
  }

  private isExplicitVerifierRejection(judgement: Record<string, unknown>): boolean {
    if (!("chosen_id" in judgement) && !("chosenId" in judgement) && !("confidence" in judgement)) return false;
    const chosenId = compactText(judgement.chosen_id || judgement.chosenId || "", 80);
    const confidence = Number(judgement.confidence || 0);
    return !chosenId && (!Number.isFinite(confidence) || confidence < minConfidence);
  }

  private violatesNegativeConstraints(query: string, task: MusicTask): boolean {
    const normalized = normalizeMatchText(query);
    if (!normalized) return false;
    if (
      this.hasRnbMarker(query) &&
      (task.negativeConstraints || []).some((constraint) => ["rb", "rnb"].includes(normalizeMatchText(constraint)))
    ) {
      return true;
    }
    return this.negativeConstraintTokens(task).some((token) => normalized.includes(token));
  }

  private negativeCandidateReason(track: Track, task: MusicTask): string {
    const metadata = normalizeMatchText(
      `${track.name} ${track.artist} ${track.album || ""} ${track.source || ""} ${(track.aliases || []).join(" ")}`,
    );
    const token = this.negativeConstraintTokens(task).find((item) => metadata.includes(item));
    return token ? `negative_constraint:${token}` : "";
  }

  private negativeConstraintTokens(task: MusicTask): string[] {
    const tokens: string[] = [];
    for (const constraint of task.negativeConstraints || []) {
      const normalized = normalizeMatchText(constraint);
      if (!normalized) continue;
      if (normalized === "rb" || normalized === "rnb") {
        tokens.push(
          "rnb",
          "sza",
          "danielcaesar",
          "frankocean",
          "kelela",
          "brentfaiyaz",
          "summerwalker",
          "jheneaiko",
        );
        continue;
      }
      tokens.push(normalized);
    }
    return dedupe(tokens);
  }

  private normalizedNegativeText(task: MusicTask): string {
    return this.negativeConstraintTokens(task).join(" ");
  }

  private verifierDiagnostic(judgement: Record<string, unknown>): NonNullable<SearchVerification["diagnostics"]>["verifier"] {
    return {
      chosenId: compactText(judgement.chosen_id || "", 80),
      confidence: Number(judgement.confidence || 0),
      matchedEntities: asStringList(judgement.matched_entities, 8),
      risk: compactText(judgement.risk || "", 160),
    };
  }

  private notFound(
    task: MusicTask,
    queries: string[],
    reason: string,
    diagnostics: SearchVerification["diagnostics"] = {},
  ): SearchVerification {
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
      diagnostics: {
        searchedQueries: diagnostics.searchedQueries || queries,
        rejectedQueries: diagnostics.rejectedQueries || [],
        generatedQueries: diagnostics.generatedQueries || [],
        candidateIds: diagnostics.candidateIds || [],
        attemptedSongIds: diagnostics.attemptedSongIds || [],
        queryResults: diagnostics.queryResults || [],
        verifier: diagnostics.verifier,
        audioAttempts: diagnostics.audioAttempts || [],
      },
    };
  }
}
