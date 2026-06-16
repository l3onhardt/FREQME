import type { AudioResolver } from "../services/audioResolver.js";
import type { LLMRouter } from "../services/llmRouter.js";
import type { NeteaseService } from "../services/neteaseService.js";
import { defaultStyleSeedRegistry } from "../radio-agent/styleSeedRegistry.js";
import type { StyleSeedDefinition, StyleSeedRegistry } from "../radio-agent/styleSeedRegistry.js";
import type { MemoryPack, MusicTask, SearchVerification, Track } from "../types.js";
import { asStringList, compactText, dedupe, extractJsonObject, normalizeMatchText } from "../utils/text.js";

const minConfidence = 0.7;

interface QueryPlan {
  queries: string[];
  rejectedQueries: string[];
  generatedQueries: string[];
  preferQueryOrder?: boolean;
}

type QueryResultDiagnostic = NonNullable<NonNullable<SearchVerification["diagnostics"]>["queryResults"]>[number];
type AudioAttemptDiagnostic = NonNullable<NonNullable<SearchVerification["diagnostics"]>["audioAttempts"]>[number];
type SearchStyleSeedRegistry = Pick<StyleSeedRegistry, "match" | "matches" | "queriesFor" | "queriesForDefinition" | "blockedTermsFor">;

export class SearchVerifyAgent {
  constructor(
    private readonly llm: LLMRouter,
    private readonly netease: NeteaseService,
    private readonly audioResolver: AudioResolver,
    private readonly llmTimeoutMs = 12000,
    private readonly styleRegistry: SearchStyleSeedRegistry = defaultStyleSeedRegistry(),
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
    const earlySceneAudioAttempts: AudioAttemptDiagnostic[] = [];
    const attemptedEarlySceneSongIds = new Set<string>();
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

      for (const localScene of this.locallyVerifiedSceneFallbacks(candidates, musicTask, contextPack)) {
        if (attemptedEarlySceneSongIds.has(localScene.id)) continue;
        attemptedEarlySceneSongIds.add(localScene.id);
        const resolved = await this.audioResolver.resolveWithCandidates(localScene, uid);
        earlySceneAudioAttempts.push({
          songId: localScene.id,
          name: localScene.name,
          artist: localScene.artist,
          sourceQuery: localScene.source,
          ok: resolved.ok,
          reason: resolved.reason,
          resolvedSongId: resolved.songId,
        });
        if (resolved.ok) {
          const selectedSong = { ...localScene, id: resolved.songId || localScene.id };
          return {
            status: "verified",
            selectedSong,
            url: resolved.proxyUrl,
            verification: {
              confidence: 0.71,
              matchedEntities: [],
              versionNote: "Playable candidate locally matches the requested station style.",
              risk: "",
            },
            fallbackCandidates: [],
            recoveryOptions: [],
            usedQuery: localScene.source || query,
            diagnostics: {
              searchedQueries: queryResults.map((item) => item.query),
              rejectedQueries: plan.rejectedQueries,
              generatedQueries: plan.generatedQueries,
              candidateIds: candidates.map((candidate) => candidate.id).filter(Boolean),
              attemptedSongIds: [localScene.id],
              queryResults,
              audioAttempts: earlySceneAudioAttempts,
            },
          };
        }
      }
    }
    if (!candidates.length) {
      return this.notFound(musicTask, queries, "No playable candidates were found.", {
        searchedQueries: queries,
        rejectedQueries: plan.rejectedQueries,
        generatedQueries: plan.generatedQueries,
        queryResults,
      });
    }

    const local = this.locallyVerifiedSong(candidates, musicTask);
    if (local && this.canUseLocalVerificationWithoutJudge(musicTask)) {
      const resolved = await this.audioResolver.resolveWithCandidates(local, uid);
      if (resolved.ok) {
        const selectedSong = { ...local, id: resolved.songId || local.id };
        return {
          status: "verified",
          selectedSong,
          url: resolved.proxyUrl,
          verification: {
            confidence: 0.72,
            matchedEntities: [],
            versionNote: "Candidate metadata locally matches the concrete query.",
            risk: "",
          },
          fallbackCandidates: [],
          recoveryOptions: [],
          usedQuery: local.source || queries[0] || "",
          diagnostics: {
            searchedQueries: queries,
            rejectedQueries: plan.rejectedQueries,
            generatedQueries: plan.generatedQueries,
            candidateIds: candidates.map((candidate) => candidate.id).filter(Boolean),
            attemptedSongIds: [local.id],
            queryResults,
            audioAttempts: [
              {
                songId: local.id,
                name: local.name,
                artist: local.artist,
                sourceQuery: local.source,
                ok: resolved.ok,
                reason: resolved.reason,
                resolvedSongId: resolved.songId,
              },
            ],
          },
        };
      }
    }

    for (const localScene of this.locallyVerifiedSceneFallbacks(candidates, musicTask, contextPack)) {
      if (attemptedEarlySceneSongIds.has(localScene.id)) continue;
      const resolved = await this.audioResolver.resolveWithCandidates(localScene, uid);
      if (resolved.ok) {
        const selectedSong = { ...localScene, id: resolved.songId || localScene.id };
        return {
          status: "verified",
          selectedSong,
          url: resolved.proxyUrl,
          verification: {
            confidence: 0.71,
            matchedEntities: [],
            versionNote: "Playable candidate locally matches the requested station style.",
            risk: "",
          },
          fallbackCandidates: [],
          recoveryOptions: [],
          usedQuery: localScene.source || queries[0] || "",
          diagnostics: {
            searchedQueries: queries,
            rejectedQueries: plan.rejectedQueries,
            generatedQueries: plan.generatedQueries,
            candidateIds: candidates.map((candidate) => candidate.id).filter(Boolean),
            attemptedSongIds: [localScene.id],
            queryResults,
            audioAttempts: [
              ...earlySceneAudioAttempts.filter((attempt) => attempt.songId !== localScene.id),
              {
                songId: localScene.id,
                name: localScene.name,
                artist: localScene.artist,
                sourceQuery: localScene.source,
                ok: resolved.ok,
                reason: resolved.reason,
                resolvedSongId: resolved.songId,
              },
            ],
          },
        };
      }
    }

    const judgement: Record<string, unknown> = await this.judge(musicTask, candidates).catch(() => ({}));
    const rankedSongs = this.rankedSongs(candidates, judgement, musicTask, contextPack, plan);
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
      audioAttempts: [...earlySceneAudioAttempts, ...audioAttempts],
    });
  }

  async queries(musicTask: MusicTask, rawUserText = "", contextPack?: MemoryPack): Promise<string[]> {
    return (await this.queryPlan(musicTask, rawUserText, contextPack)).queries;
  }

  private async queryPlan(musicTask: MusicTask, rawUserText = "", contextPack?: MemoryPack): Promise<QueryPlan> {
    const cleanedGoals = this.cleanQueries(musicTask.searchGoals, rawUserText);
    const rejectedByNegative = cleanedGoals.filter((query) => this.violatesNegativeConstraints(query, musicTask));
    const goals = cleanedGoals.filter((query) => !this.violatesNegativeConstraints(query, musicTask));
    if (cleanedGoals.length && rejectedByNegative.length === cleanedGoals.length) {
      return { queries: [], rejectedQueries: rejectedByNegative, generatedQueries: [] };
    }
    const requiresConcrete = this.requiresConcreteQueries(musicTask);
    const fastQueries = this.fastConcreteQueries(musicTask, goals);
    if (fastQueries.length) return { queries: fastQueries, rejectedQueries: [], generatedQueries: [] };
    const fastStyleQueries = this.fastStyleQueries(musicTask, goals, rawUserText, contextPack);
    if (fastStyleQueries.length) {
      return {
        queries: fastStyleQueries.slice(0, 6),
        rejectedQueries: dedupe([...cleanedGoals, ...goals]).filter((query) => !fastStyleQueries.includes(query)),
        generatedQueries: [],
      };
    }
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
    const shouldDemoteSingleAnchor = this.shouldDemoteSingleAnchorQuery(musicTask, concrete, contextPack);
    const needsStyleBackup = this.shouldAppendStyleBackupQueries(musicTask, concrete);
    const fallback =
      concrete.length && !shouldDemoteSingleAnchor && !needsStyleBackup
        ? []
        : this.fallbackQueries(musicTask, goals, rawUserText, contextPack);
    const fallbackQueries = fallback.filter(
      (query) => !concrete.includes(query) && !this.violatesNegativeConstraints(query, musicTask),
    );
    const preferQueryOrder = shouldDemoteSingleAnchor && fallbackQueries.length > 0;
    const queries = preferQueryOrder ? dedupe([...fallbackQueries, ...concrete]) : dedupe([...concrete, ...fallbackQueries]);
    return {
      queries: queries.slice(0, 6),
      rejectedQueries: dedupe([...generatedRaw, ...goals]).filter(
        (query) => !concrete.includes(query) && !fallbackQueries.includes(query),
      ),
      generatedQueries: generated,
      preferQueryOrder,
    };
  }

  private shouldAppendStyleBackupQueries(task: MusicTask, concreteQueries: string[]): boolean {
    if (!["scene_genre_direction", "continuation", "negative_feedback"].includes(task.type)) return false;
    if (concreteQueries.length >= 4) return false;
    const text = [task.styleHint, task.workHint, ...task.primaryEntities.map((entity) => entity.name), ...task.searchGoals].join(" ");
    return normalizeMatchText(text).includes("jazz");
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

  private fastStyleQueries(task: MusicTask, goals: string[], rawUserText: string, contextPack?: MemoryPack): string[] {
    if (!["scene_genre_direction", "continuation", "negative_feedback"].includes(task.type)) return [];
    const explicitText = [task.styleHint, task.workHint, ...task.primaryEntities.map((entity) => entity.name), rawUserText].join(" ");
    const expandedText = [explicitText, ...task.searchGoals].join(" ");
    const registryMatch =
      this.registryMatchAllowedByTask(explicitText, task) || this.registryMatchAllowedByTask(expandedText, task);
    if (registryMatch) {
      const hasConcreteGoal = goals.some((query) => this.looksConcrete(query, task));
      if (hasConcreteGoal) return [];
      if (contextPack && registryMatch.id === "rnb" && goals.length === 0) return [];
      return this.styleQueriesForDefinition(registryMatch, task, rawUserText, contextPack);
    }
    const normalized = normalizeMatchText(expandedText);
    if (normalized.includes("jazz")) {
      if (this.negativeConstraintsBlockStyle(task, "jazz")) return [];
      return this.fallbackQueries(task, goals, rawUserText, contextPack);
    }
    if (!this.hasRnbMarker(expandedText)) return [];
    if (contextPack || this.negativeConstraintsBlockStyle(task, "R&B")) return [];
    if (goals.some((query) => this.looksConcrete(query, task))) return [];
    return this.fallbackQueries(task, goals, rawUserText, contextPack);
  }

  private negativeConstraintsBlockStyle(task: MusicTask, style: string): boolean {
    const styleKey = normalizeMatchText(style);
    if (!styleKey) return false;
    return this.negativeConstraintTokens(task).some((token) => {
      if (!token) return false;
      if (token === styleKey) return true;
      return token.includes(styleKey) || styleKey.includes(token);
    });
  }

  private styleBlockedByNegativeConstraints(task: MusicTask, definition: { id: string; markers: string[] }): boolean {
    const styleValues = [definition.id, ...definition.markers];
    return styleValues.some((style) => this.negativeConstraintsBlockStyle(task, style));
  }

  private registryMatchAllowedByTask(text: string, task: MusicTask): StyleSeedDefinition | null {
    const matches = typeof this.styleRegistry.matches === "function"
      ? this.styleRegistry.matches(text)
      : [this.styleRegistry.match(text)].filter((item): item is StyleSeedDefinition => Boolean(item));
    return matches.find((definition) => !this.styleBlockedByNegativeConstraints(task, definition)) || null;
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

  private locallyVerifiedSceneFallbacks(candidates: Track[], task: MusicTask, contextPack?: MemoryPack): Track[] {
    if (!["scene_genre_direction", "continuation", "negative_feedback"].includes(task.type)) return [];
    const taskText = normalizeMatchText([
      task.styleHint,
      task.workHint,
      ...task.primaryEntities.map((entity) => entity.name),
      ...task.searchGoals,
    ].join(" "));
    if (!taskText.includes("jazz") && !this.hasRnbMarker(taskText)) return [];
    const recent = this.recentTrackKeys(contextPack);
    return candidates.filter((candidate, index, list) => {
        if (list.findIndex((item) => item.id === candidate.id) !== index) return false;
        if (recent.has(this.trackKey(candidate))) return false;
        const source = normalizeMatchText(candidate.source || "");
        const metadata = normalizeMatchText(`${candidate.artist} ${candidate.name} ${candidate.album || ""}`);
        if (taskText.includes("jazz")) {
          if (this.isKnownQuietJazzSeed(source, metadata)) return !this.isBadCandidate(candidate, task);
          if (!source.includes("jazzpianobaracademy")) return false;
          if (!metadata.includes("jazzpianobaracademy")) return false;
          if (!metadata.includes("piano") && !source.includes("piano")) return false;
          return !this.isBadCandidate(candidate, task);
        }
        if (this.hasRnbMarker(taskText)) {
          if (!this.isKnownRnbSeed(source, metadata)) return false;
          return !this.isBadCandidate(candidate, task);
        }
        return !this.isBadCandidate(candidate, task);
      });
  }

  private canUseLocalVerificationWithoutJudge(task: MusicTask): boolean {
    return task.type === "specific_track";
  }

  private isKnownQuietJazzSeed(source: string, metadata: string): boolean {
    const seeds = [
      { source: "billevanswaltzfordebby", artist: "billevans", title: "waltzfordebby" },
      { source: "chetbakerifallinlovetooeasily", artist: "chetbaker", title: "ifallinlovetooeasily" },
      { source: "chetbakeralmostblue", artist: "chetbaker", title: "almostblue" },
      { source: "milesdavisblueingreen", artist: "milesdavis", title: "blueingreen" },
    ];
    return seeds.some((seed) => source.includes(seed.source) && metadata.includes(seed.artist) && metadata.includes(seed.title));
  }

  private isKnownRnbSeed(source: string, metadata: string): boolean {
    const seeds = [
      { source: "frankoceanpinkpuss", artist: "frankocean", title: "pinkwhite", titleAliases: ["pinkpuss"] },
      { source: "danielcaesarjapanesedenim", artist: "danielcaesar", title: "japanesedenim" },
      { source: "frankoceanpinkwhite", artist: "frankocean", title: "pinkwhite" },
      { source: "szabrokenclocks", artist: "sza", title: "brokenclocks" },
      { source: "summerwalkersession32", artist: "summerwalker", title: "session32" },
      { source: "jheneaikowhilewereyoung", artist: "jheneaiko", title: "whilewereyoung" },
      { source: "jhenaikowhilewereyoung", artist: "jhenaiko", title: "whilewereyoung" },
      { source: "herfocus", artist: "her", title: "focus" },
      { source: "kelelalmk", artist: "kelela", title: "lmk" },
      { source: "brentfaiyazclouded", artist: "brentfaiyaz", title: "clouded" },
      { source: "szasnooze", artist: "sza", title: "snooze" },
      { source: "giveonheartbreakanniversary", artist: "giveon", title: "heartbreakanniversary" },
      { source: "migueladorn", artist: "miguel", title: "adorn" },
      { source: "theinternetgirl", artist: "theinternet", title: "girl" },
      { source: "sondertoofast", artist: "sonder", title: "toofast" },
      { source: "jorjasmithbluelights", artist: "jorjasmith", title: "bluelights" },
      { source: "ravynlenaeskintight", artist: "ravynlenae", title: "skintight" },
      { source: "snohaalegraiwantyouaround", artist: "snohaalegra", title: "iwantyouaround" },
      { source: "partynextdoorrecognize", artist: "partynextdoor", title: "recognize" },
      { source: "usherclimax", artist: "usher", title: "climax" },
      { source: "dangelountitled", artist: "dangelo", title: "untitled" },
    ];
    return seeds.some((seed) => {
      if (!source.includes(seed.source)) return false;
      if (!metadata.includes(seed.artist)) return false;
      const titles = [seed.title, ...(seed.titleAliases || [])];
      return titles.some((title) => metadata.includes(title));
    });
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

  private rankedSongs(
    candidates: Track[],
    judgement: Record<string, unknown>,
    task: MusicTask,
    contextPack?: MemoryPack,
    plan?: QueryPlan,
  ): Track[] {
    if (this.isExplicitVerifierRejection(judgement)) return [];
    const ranked: Track[] = [];
    const chosen = this.chosenSong(candidates, judgement);
    if (chosen) ranked.push(chosen);
    const local = this.locallyVerifiedSong(candidates, task);
    if (plan?.preferQueryOrder && local) ranked.unshift(local);
    else if (local) ranked.push(local);
    if (ranked.length) ranked.push(...candidates);
    const unique = ranked.filter((song, index, list) => list.findIndex((item) => item.id === song.id) === index);
    const recent = this.recentTrackKeys(contextPack);
    const fresh = unique.filter((song) => !recent.has(this.trackKey(song)));
    return (fresh.length ? fresh : unique).slice(0, 12);
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

  private shouldDemoteSingleAnchorQuery(
    task: MusicTask,
    concreteQueries: string[],
    contextPack?: MemoryPack,
  ): boolean {
    if (!["scene_genre_direction", "continuation", "negative_feedback"].includes(task.type)) return false;
    if (concreteQueries.length !== 1 || !contextPack) return false;
    const query = concreteQueries[0] || "";
    if (this.recentQueryKeys(contextPack).has(normalizeMatchText(query))) return true;
    const text = [
      contextPack.userProfileDigest,
      JSON.stringify(contextPack.retrievedMemories || []),
      JSON.stringify(this.recentTracks(contextPack)),
    ].join(" ");
    const normalizedContext = normalizeMatchText(text);
    if (!normalizedContext) return false;
    const styleText = [
      task.styleHint,
      task.workHint,
      ...task.primaryEntities.map((entity) => entity.name),
      ...task.searchGoals,
    ].join(" ");
    const isStyleSeed = this.styleSeedQueries(styleText, task, contextPack).some(
      (seed) => normalizeMatchText(seed) === normalizeMatchText(query),
    );
    if (!isStyleSeed) return false;
    return this.queryAnchorKeys(query).some((key) => normalizedContext.includes(key));
  }

  private queryAnchorKeys(query: string): string[] {
    const tokens = query.match(/[A-Za-z0-9][A-Za-z0-9'.+&-]*|[\u4e00-\u9fff]+/gu) || [];
    if (tokens.length < 2) return [];
    const keys = [
      normalizeMatchText(tokens[0]),
      normalizeMatchText(tokens.slice(0, 2).join(" ")),
    ].filter((key) => key.length >= 3);
    return dedupe(keys);
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
      rawUserText,
    ];
    const text = positiveParts.join(" ");
    const styleSeeds = this.styleSeedQueries(text, task, contextPack);
    return this.cleanQueries(styleSeeds, rawUserText)
      .filter((query) => this.looksConcrete(query, task))
      .filter((query) => !this.recentQueryKeys(contextPack).has(normalizeMatchText(query)))
      .filter((query) => !this.recentLocalSeedQueryKeys(contextPack).has(normalizeMatchText(query)))
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

  private styleSeedQueries(normalizedText: string, task: MusicTask, contextPack?: MemoryPack): string[] {
    const match = this.registryMatchAllowedByTask(normalizedText, task);
    if (!match) return [];
    return this.styleQueriesForDefinition(match, task, "", contextPack);
  }

  private styleQueriesForDefinition(
    definition: StyleSeedDefinition,
    task: MusicTask,
    rawUserText: string,
    contextPack?: MemoryPack,
  ): string[] {
    return this.cleanQueries(this.styleRegistry.queriesForDefinition(definition, this.recentTracks(contextPack)), rawUserText)
      .filter((query) => this.looksConcrete(query, task))
      .filter((query) => !this.recentQueryKeys(contextPack).has(normalizeMatchText(query)))
      .filter((query) => !this.recentLocalSeedQueryKeys(contextPack).has(normalizeMatchText(query)))
      .filter((query) => !this.violatesNegativeConstraints(query, task));
  }

  private preferFreshQueries(queries: string[], contextPack?: MemoryPack): string[] {
    const recent = this.recentQueryKeys(contextPack);
    const fresh = queries.filter((query) => !recent.has(normalizeMatchText(query)));
    return fresh.length ? [...fresh, ...queries.filter((query) => recent.has(normalizeMatchText(query)))] : queries;
  }

  private recentQueryKeys(contextPack?: MemoryPack): Set<string> {
    const keys = new Set<string>();
    for (const track of this.recentTracks(contextPack)) {
      const key = this.trackKey(track);
      if (key) keys.add(key);
    }
    return keys;
  }

  private recentLocalSeedQueryKeys(contextPack?: MemoryPack): Set<string> {
    const keys = new Set<string>();
    for (const track of this.recentTracks(contextPack)) {
      const artist = normalizeMatchText(track.artist || "");
      const name = normalizeMatchText(track.name || "");
      if (artist.includes("jazzpianobaracademy") && name.includes("italiandinnerbackgroundmusic")) {
        keys.add(normalizeMatchText("jazz piano bar academy quiet"));
      }
      if (artist.includes("jazzpianobaracademy") && name.includes("magicalpiano")) {
        keys.add(normalizeMatchText("jazz piano bar academy reading"));
        keys.add(normalizeMatchText("Jazz Piano Bar Academy Piano Instrumental Music"));
      }
      if (artist.includes("jazzpianobaracademy") && name.includes("pianoinstrumentalmusic")) {
        keys.add(normalizeMatchText("jazz piano bar academy reading"));
        keys.add(normalizeMatchText("Jazz Piano Bar Academy Piano Instrumental Music"));
      }
      if (artist.includes("jazzpianobaracademy") && name.includes("barmusicchilloutcafe")) {
        keys.add(normalizeMatchText("jazz piano bar academy quiet"));
      }
    }
    return keys;
  }

  private recentTrackKeys(contextPack?: MemoryPack): Set<string> {
    const keys = new Set<string>();
    for (const track of this.recentTracks(contextPack)) {
      const key = this.trackKey(track);
      if (key) keys.add(key);
    }
    return keys;
  }

  private recentTracks(contextPack?: MemoryPack): Track[] {
    const playback = contextPack?.playbackContext || {};
    const values = [
      (playback as Record<string, unknown>).currentTrack,
      ...this.asTrackList((playback as Record<string, unknown>).recentTracks),
      ...this.asTrackList((playback as Record<string, unknown>).readyQueue),
    ];
    return values.filter((item): item is Track => Boolean(item && typeof item === "object" && !Array.isArray(item)));
  }

  private asTrackList(value: unknown): unknown[] {
    return Array.isArray(value) ? value : [];
  }

  private trackKey(track: Partial<Track>): string {
    return normalizeMatchText(`${track.artist || ""} ${track.name || ""}`);
  }

  private hasRnbMarker(text: string): boolean {
    const normalized = normalizeMatchText(text);
    return /\br\s*&?\s*b\b|\brnb\b/iu.test(text) || normalized.includes("rnb") || normalized.includes("rb");
  }

  private hasEmoMarker(text: string): boolean {
    return (
      /\bemo\b|sad\s+alt|sad\s+indie|melanchol|heartbreak/iu.test(text) ||
      /忧郁|深沉|内省|情绪内敛|独处|沉思|情感张力|不吵闹|夜晚.*情绪|晚上.*情绪/u.test(text)
    );
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
      if (normalized === "edm" || normalized === "electronicdancemusic") {
        tokens.push(
          "edm",
          "electronicdancemusic",
          "dubstep",
          "brostep",
          "deephouse",
          "house",
          "futurebass",
          "drumandbass",
          "liquiddrumandbass",
          "dnb",
          "trap",
          "techno",
          "trance",
        );
        continue;
      }
      if (normalized === "dubstep") {
        tokens.push("dubstep", "brostep");
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
