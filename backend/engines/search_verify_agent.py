from __future__ import annotations

from dataclasses import dataclass, field
import asyncio
import inspect
import json
import re


MIN_CONFIDENCE = 0.7
MAX_QUERY_LEN = 120
MAX_CANDIDATES_FOR_JUDGEMENT = 16
MAX_RAW_METADATA_CHARS = 700


@dataclass
class SearchVerification:
    status: str
    selected_song: dict | None = None
    url: str = ""
    verification: dict = field(default_factory=dict)
    fallback_candidates: list[dict] = field(default_factory=list)
    recovery_options: list[dict] = field(default_factory=list)
    failure_reason: str = ""
    used_query: str = ""


class SearchVerifyAgent:
    def __init__(self, llm, netease, audio_resolver, llm_timeout_s: float = 8.0):
        self.llm = llm
        self.netease = netease
        self.audio_resolver = audio_resolver
        self.llm_timeout_s = llm_timeout_s

    async def verify(self, music_task: dict, uid: str | None = None, raw_user_text: str = "") -> SearchVerification:
        queries = await self._queries(music_task, raw_user_text)
        candidates = []
        for query in queries:
            try:
                found = await self.netease.search(query, limit=8)
            except Exception:
                found = []
            for candidate in self._pool_list(found)[:8]:
                if not self._is_bad_candidate(candidate, music_task):
                    candidates.append(self._normalize_candidate(candidate, query))
        if not candidates:
            return await self._not_found(music_task, queries, "No candidates returned.")

        judgement = await self._judge(music_task, candidates)
        song = self._chosen_song(candidates, judgement)
        local_verification = {}
        if not song:
            song = self._locally_verified_song_for_concrete_query(candidates, music_task)
            if song:
                local_verification = {
                    "confidence": 0.72,
                    "matched_entities": [],
                    "version_note": "Candidate metadata matched the concrete search target.",
                    "risk": "local_metadata_match",
                }
        if song and not await self._candidate_matches_required_entities(song, music_task):
            song = None
            local_verification = {}
        if not song:
            return SearchVerification(
                status="not_found",
                failure_reason="No candidate passed verification.",
                recovery_options=self._recovery_options(music_task, judgement),
            )

        try:
            resolved = await self.audio_resolver.resolve_with_candidates(song, uid=uid)
        except Exception:
            resolved = None
        if not getattr(resolved, "ok", False):
            return SearchVerification(
                status="not_found",
                failure_reason="Verified candidate was not playable.",
                recovery_options=self._recovery_options(music_task, judgement),
                used_query=song.get("_source_query", ""),
            )

        selected = dict(song)
        if getattr(resolved, "song_id", ""):
            selected["id"] = getattr(resolved, "song_id")
        return SearchVerification(
            status="verified",
            selected_song=selected,
            url=getattr(resolved, "proxy_url", ""),
            verification=local_verification or {
                "confidence": self._safe_float(judgement.get("confidence")),
                "matched_entities": judgement.get("matched_entities") or [],
                "version_note": str(judgement.get("version_note") or ""),
                "risk": str(judgement.get("risk") or ""),
            },
            fallback_candidates=self._bounded_dict_list(judgement.get("fallback_candidates")),
            used_query=song.get("_source_query", ""),
        )

    async def _queries(self, music_task: dict, raw_user_text: str) -> list[str]:
        goals = self._clean_queries(music_task.get("search_goals", []), raw_user_text)
        prompt = f"""Create NetEase search queries from this structured music task.
Use only the structured task fields. Do not reinterpret the full user request.

Act as the DJ's search-planning agent, not as a keyword cleaner:
- For scene_genre_direction, mood, style, time-of-day, or negative constraints, first infer 3 to 5 concrete songs / 具体歌曲 that fit the direction. Search queries must look like "artist title", not "late night R&B", "emotional playlist", or other style buckets.
- For artist_direction, infer concrete songs by that artist/band. Do not return the artist name by itself.
- For artist_work_direction or classical requests, include performer/composer/work/version words so the result can be verified.
- Treat negative_constraints and avoidance words as hard filters. If the task says 别炸, 不要太吵, low-key, quiet, mellow, or not too loud, avoid bombastic vocals, arena-rock energy, aggressive drums, high-BPM tracks, hype songs, and other loud/intense picks even when the broad genre matches.
- For late-night emotional directions, prefer intimate, restrained, sparse, mellow, emotionally precise tracks over karaoke-style ballads, belting, anthems, or over-familiar hype songs.
- Do not include playlists, mixes, utility audio, white noise, study/sleep audio, KTV, backing tracks, or unrequested covers.

Music task:
{json.dumps(music_task, ensure_ascii=False, indent=2)}

Return JSON only:
{{
  "search_queries": ["artist title or performer composer work"],
  "picks": [
    {{"artist": "artist or performer", "title": "song/work title", "query": "artist title", "reason": "short fit reason"}}
  ]
}}"""
        try:
            response = await asyncio.wait_for(
                self._chat_json(
                    prompt,
                    max_tokens=360,
                    system="You create music search queries. Return JSON only.",
                ),
                timeout=self.llm_timeout_s,
            )
            data = self._parse_json(response)
        except Exception:
            data = {}
        generated = self._clean_queries(self._planned_query_values(data), raw_user_text)
        if self._requires_concrete_planned_queries(music_task):
            concrete_generated = self._concrete_queries(generated, music_task)
            if concrete_generated:
                return concrete_generated[:6]
            concrete_goals = self._concrete_queries(goals, music_task)
            if concrete_goals:
                return concrete_goals[:6]
            repaired = await self._repair_underplanned_queries(
                music_task,
                raw_user_text=raw_user_text,
                rejected_queries=self._dedupe(generated + goals),
            )
            concrete_repaired = self._concrete_queries(repaired, music_task)
            if concrete_repaired:
                return concrete_repaired[:6]
            return []
        queries = self._dedupe(generated + goals)
        if queries:
            return queries[:6]
        return self._structured_query_fallback(music_task, raw_user_text)[:6]

    async def _repair_underplanned_queries(
        self,
        music_task: dict,
        raw_user_text: str,
        rejected_queries: list[str],
    ) -> list[str]:
        prompt = f"""This is a second-pass DJ search-planning repair.
The previous plan did not produce executable song/work candidates. Do not use artist lookup tools, alias caches, top-song APIs, or hardcoded mappings. Use music reasoning from the structured task only.

Convert the task into 3 to 5 concrete NetEase search candidates:
- Each candidate must be a specific playable song, recording, work movement, or performer/work/version query.
- For a fuzzy artist/band/entity, infer the intended canonical music entity when needed and choose representative concrete tracks by that entity.
- For a performer/composer/work-family request, turn it into concrete performer + composer + work/version queries.
- For scene, mood, time, or correction requests, infer specific tracks that satisfy the musical direction.
- Negative constraints are hard filters. When the task says quiet, not too loud, low-key, 别炸, 不要太吵, or similar, do not pick loud, bombastic, aggressive, high-energy, anthem-like, or belting tracks.
- Late-night emotional does not mean generic sad hits; choose restrained, intimate, lower-energy tracks that can actually sit in a late-night radio flow.
- Do not return the bare entity, bare genre, playlist query, mood bucket, or the raw user sentence.

Structured music task:
{json.dumps(music_task, ensure_ascii=False, indent=2)}

Rejected underplanned queries:
{json.dumps(rejected_queries, ensure_ascii=False)}

Raw user text is provided only to preserve intent, not to search literally:
{raw_user_text}

Return JSON only:
{{
  "picks": [
    {{"artist": "artist/performer", "title": "specific song/work/version", "query": "NetEase search query", "reason": "short"}}
  ],
  "search_queries": ["same concrete queries if useful"]
}}"""
        try:
            response = await asyncio.wait_for(
                self._chat_json(
                    prompt,
                    max_tokens=420,
                    system="You repair underplanned DJ music search plans into concrete playable candidates. Return JSON only.",
                ),
                timeout=self.llm_timeout_s,
            )
            data = self._parse_json(response)
        except Exception:
            data = {}
        return self._clean_queries(self._planned_query_values(data), raw_user_text)

    def _planned_query_values(self, data: dict) -> list[str]:
        if not isinstance(data, dict):
            return []
        values = []
        picks = data.get("picks")
        if isinstance(picks, list):
            for pick in picks:
                if not isinstance(pick, dict):
                    continue
                query = str(pick.get("query") or "").strip()
                if not query:
                    artist = str(pick.get("artist") or "").strip()
                    title = str(pick.get("title") or "").strip()
                    query = " ".join(part for part in (artist, title) if part).strip()
                if query:
                    values.append(query)
        search_queries = data.get("search_queries")
        if isinstance(search_queries, list):
            values.extend(search_queries)
        elif isinstance(search_queries, str):
            values.append(search_queries)
        return values

    def _requires_concrete_planned_queries(self, music_task: dict) -> bool:
        if not isinstance(music_task, dict):
            return False
        return str(music_task.get("type") or "") in {
            "artist_direction",
            "artist_work_direction",
            "scene_genre_direction",
            "continuation",
            "negative_feedback",
        }

    def _concrete_queries(self, queries: list[str], music_task: dict) -> list[str]:
        return [
            query
            for query in queries
            if self._looks_like_concrete_query(query, music_task)
        ]

    def _looks_like_concrete_query(self, query: str, music_task: dict) -> bool:
        text = str(query or "").strip()
        if not text:
            return False
        if self._looks_like_scene_bucket_query(text) or self._looks_like_scene_descriptor_query(text):
            return False
        if self._looks_like_bare_entity_query(text, music_task):
            return False
        if self._looks_like_artist_descriptor_query(text, music_task):
            return False
        if self._looks_like_generic_direction_query(text):
            return False
        ascii_tokens = re.findall(r"[A-Za-z0-9][A-Za-z0-9'.+&-]*", text)
        cjk_tokens = re.findall(r"[\u4e00-\u9fff]+", text)
        if len(ascii_tokens) >= 2:
            return True
        if len(cjk_tokens) >= 2 and re.search(r"\s", text):
            return True
        if ascii_tokens and cjk_tokens and re.search(r"\s", text):
            return True
        return False

    def _looks_like_bare_entity_query(self, query: str, music_task: dict) -> bool:
        if not isinstance(music_task, dict):
            return False
        task_type = str(music_task.get("type") or "")
        if task_type not in {
            "artist_direction",
            "artist_work_direction",
            "scene_genre_direction",
            "continuation",
            "negative_feedback",
        }:
            return False
        normalized_query = self._normalize_match_text(query)
        if not normalized_query:
            return False
        values = []
        for entity in music_task.get("primary_entities") or []:
            if isinstance(entity, dict) and entity.get("name"):
                values.append(str(entity.get("name")))
        for key in ("style_hint", "work_hint"):
            if music_task.get(key):
                values.append(str(music_task.get(key)))
        return any(
            normalized_query == self._normalize_match_text(value)
            for value in values
            if self._normalize_match_text(value)
        )

    def _looks_like_artist_descriptor_query(self, query: str, music_task: dict) -> bool:
        if not isinstance(music_task, dict):
            return False
        if str(music_task.get("type") or "") not in {"artist_direction", "artist_work_direction"}:
            return False
        query_text = str(query or "").strip()
        if not query_text:
            return False
        generic_tokens = {
            "popular",
            "best",
            "hit",
            "hits",
            "song",
            "songs",
            "music",
            "softer",
            "soft",
            "calm",
            "quiet",
            "mellow",
            "acoustic",
            "recommend",
            "recommendation",
            "推荐",
            "热门",
            "经典",
            "抒情",
            "柔和",
            "安静",
            "不吵",
            "别吵",
            "不炸",
            "别炸",
            "歌曲",
            "音乐",
        }
        remainder = query_text
        for entity in music_task.get("primary_entities") or []:
            if not isinstance(entity, dict):
                continue
            name = str(entity.get("name") or "").strip()
            if not name:
                continue
            remainder = re.sub(re.escape(name), " ", remainder, flags=re.I)
            compact_name = re.sub(r"\s+", "", name)
            if compact_name and compact_name != name:
                remainder = re.sub(re.escape(compact_name), " ", remainder, flags=re.I)
        tokens = [
            token.casefold()
            for token in re.findall(r"[A-Za-z0-9][A-Za-z0-9'.+&-]*|[\u4e00-\u9fff]+", remainder)
        ]
        if not tokens:
            return False
        if any(token in {"song", "songs", "music", "recommend", "recommendation", "歌曲", "音乐", "推荐"} for token in tokens):
            return True
        return all(token in generic_tokens for token in tokens)

    def _looks_like_generic_direction_query(self, query: str) -> bool:
        text = str(query or "").strip().lower()
        if not text:
            return True
        generic_tokens = (
            "深夜",
            "夜晚",
            "晚上",
            "睡前",
            "下午",
            "午后",
            "安静",
            "舒缓",
            "放松",
            "松弛",
            "不炸",
            "别炸",
            "emotional",
            "emo",
            "rnb",
            "r&b",
            "jazz",
            "trip hop",
            "triphop",
            "mellow",
            "chill",
            "quiet",
            "soft",
            "playlist",
            "歌单",
            "音乐",
            "歌曲",
        )
        token_hits = sum(1 for token in generic_tokens if token in text)
        word_count = len(re.findall(r"[A-Za-z0-9+&]+|[\u4e00-\u9fff]{1,4}", text))
        has_artist_title_shape = bool(
            re.search(r"[A-Za-z][A-Za-z0-9'.+&-]*\s+[A-Za-z][A-Za-z0-9'.+&-]*", text)
        )
        return token_hits >= 1 and word_count <= 5 and not has_artist_title_shape

    async def _judge(self, music_task: dict, candidates: list[dict]) -> dict:
        prompt = f"""Choose the best verified playable music candidate for this DJ task.

Task:
{json.dumps(music_task, ensure_ascii=False, indent=2)}

Candidates:
{self._candidate_text(candidates)}

Reject playlists, utility audio, study audio, unrequested covers, unrequested KTV/karaoke, unrequested backing/accompaniment, wrong artists, and wrong classical performers.
Return JSON only:
{{
  "chosen_id": "candidate id or empty",
  "confidence": 0.0,
  "matched_entities": [],
  "version_note": "",
  "risk": "",
  "fallback_candidates": [],
  "recovery_options": []
}}"""
        try:
            response = await asyncio.wait_for(
                self._chat_json(
                    prompt,
                    max_tokens=360,
                    system="You verify music search results. Return JSON only.",
                ),
                timeout=self.llm_timeout_s,
            )
            return self._parse_json(response)
        except Exception:
            return {}

    async def _chat_json(self, prompt: str, max_tokens: int, system: str) -> str:
        kwargs = {
            "max_tokens": max_tokens,
            "system": system,
            "response_format": {"type": "json_object"},
        }
        try:
            return await self.llm.chat(prompt, **kwargs)
        except TypeError as error:
            if not self._looks_like_unsupported_response_format(error):
                raise
            kwargs.pop("response_format", None)
            return await self.llm.chat(prompt, **kwargs)

    def _looks_like_unsupported_response_format(self, error: TypeError) -> bool:
        return "response_format" in str(error) or self._chat_accepts_response_format() is False

    def _chat_accepts_response_format(self) -> bool | None:
        try:
            parameters = inspect.signature(self.llm.chat).parameters
        except (TypeError, ValueError):
            return None
        if any(parameter.kind == inspect.Parameter.VAR_KEYWORD for parameter in parameters.values()):
            return True
        return "response_format" in parameters

    async def _not_found(self, music_task: dict, queries: list[str], reason: str) -> SearchVerification:
        judgement = await self._judge(music_task, [])
        return SearchVerification(
            status="not_found",
            failure_reason=reason,
            recovery_options=self._recovery_options(music_task, judgement),
            used_query=queries[0] if queries else "",
        )

    def _recovery_options(self, music_task: dict, judgement: dict) -> list[dict]:
        options = judgement.get("recovery_options") if isinstance(judgement, dict) else None
        if isinstance(options, list) and options:
            return self._bounded_dict_list(options)
        entities = music_task.get("primary_entities") if isinstance(music_task, dict) else []
        names = [str(item.get("name")) for item in entities or [] if isinstance(item, dict) and item.get("name")]
        task = " ".join(names + [str(music_task.get("work_hint") or music_task.get("style_hint") or "")]).strip()
        return self._bounded_dict_list([
            {
                "type": "adjacent_version",
                "task": task,
                "reason": "Relax exact version while keeping the musical direction.",
            }
        ]) if task else []

    def _chosen_song(self, candidates: list[dict], judgement: dict) -> dict | None:
        if not isinstance(judgement, dict):
            return None
        confidence = self._safe_float(judgement.get("confidence"))
        if confidence < MIN_CONFIDENCE:
            return None
        chosen_id = str(judgement.get("chosen_id") or "").strip()
        if not chosen_id:
            return None
        for candidate in candidates:
            if str(candidate.get("id")) == chosen_id:
                return candidate
        return None

    def _locally_verified_song_for_concrete_query(self, candidates: list[dict], music_task: dict) -> dict | None:
        for candidate in candidates[:8]:
            source_query = str(candidate.get("_source_query") or "")
            if not self._looks_like_concrete_query(source_query, music_task):
                continue
            if self._is_bad_candidate(candidate, music_task):
                continue
            if self._candidate_matches_source_query(candidate, source_query):
                return candidate
        return None

    def _candidate_matches_source_query(self, candidate: dict, source_query: str) -> bool:
        query_tokens = self._meaningful_query_tokens(source_query)
        if len(query_tokens) < 2:
            return False
        title_text = self._normalize_match_text(candidate.get("name") or candidate.get("title") or "")
        artist_text = self._normalize_match_text(self._artist_name(candidate))
        album_text = self._normalize_match_text(self._album_name(candidate))
        metadata = self._normalize_match_text(" ".join(self._metadata_strings(candidate)))
        if not title_text and not artist_text:
            return False

        matched = [token for token in query_tokens if token in metadata]
        if len(matched) < 2:
            return False
        has_title_match = any(token in title_text or token in album_text for token in query_tokens)
        has_artist_match = any(token in artist_text for token in query_tokens)
        return has_title_match and has_artist_match

    def _meaningful_query_tokens(self, query: str) -> list[str]:
        tokens = [
            self._normalize_match_text(token)
            for token in re.findall(r"[A-Za-z0-9][A-Za-z0-9'.+&-]*|[\u4e00-\u9fff]+", str(query or ""))
        ]
        stop = {
            "the",
            "a",
            "an",
            "in",
            "of",
            "and",
            "feat",
            "ft",
            "version",
            "remastered",
        }
        return [token for token in tokens if token and token not in stop]

    async def _candidate_matches_required_entities(self, candidate: dict, music_task: dict) -> bool:
        if not isinstance(music_task, dict):
            return True
        task_type = str(music_task.get("type") or "")
        if task_type not in {"artist_direction", "artist_work_direction", "specific_track"}:
            return True
        required = self._required_artistish_entities(music_task)
        if not required:
            return True
        candidate_text = self._normalize_match_text(" ".join(self._metadata_strings(candidate)))
        if not candidate_text:
            return False
        if any(self._entity_matches_candidate_text(entity, candidate_text) for entity in required):
            return True
        return await self._llm_entity_consistency_check(required, candidate, music_task)

    def _required_artistish_entities(self, music_task: dict) -> list[str]:
        entities = music_task.get("primary_entities") if isinstance(music_task, dict) else []
        if not isinstance(entities, list):
            return []
        artistish_roles = {"artist", "performer", "composer", "music_entity"}
        required = []
        for entity in entities:
            if not isinstance(entity, dict):
                continue
            role = str(entity.get("role") or "music_entity").strip()
            name = str(entity.get("name") or "").strip()
            if role in artistish_roles and name:
                required.append(name)
        return required[:4]

    def _entity_matches_candidate_text(self, entity: str, candidate_text: str) -> bool:
        expected = self._normalize_match_text(entity)
        if not expected:
            return True
        return expected in candidate_text

    async def _llm_entity_consistency_check(
        self,
        required_entities: list[str],
        candidate: dict,
        music_task: dict,
    ) -> bool:
        prompt = f"""Decide whether this selected candidate matches the same intended music entity as the user's structured DJ task.
This is only an entity consistency gate. Accept translations, common non-English names, romanizations, misspellings, and classical performer/composer naming variants when they refer to the same intended music entity.
Reject unrelated artists, uploader names, playlists, covers, and candidates that merely share a mood.

Required entities:
{json.dumps(required_entities, ensure_ascii=False)}

Music task:
{json.dumps(music_task, ensure_ascii=False, indent=2)}

Selected candidate:
{json.dumps(candidate, ensure_ascii=False, indent=2)}

Return JSON only:
{{"matches": true, "confidence": 0.0, "reason": "short"}}"""
        try:
            response = await asyncio.wait_for(
                self._chat_json(
                    prompt,
                    max_tokens=180,
                    system="You verify whether two music entity names refer to the same intended music entity. Return JSON only.",
                ),
                timeout=self.llm_timeout_s,
            )
            data = self._parse_json(response)
        except Exception:
            return False
        if not isinstance(data, dict):
            return False
        return bool(data.get("matches")) and self._safe_float(data.get("confidence")) >= MIN_CONFIDENCE

    def _candidate_text(self, candidates: list[dict]) -> str:
        bounded = candidates[:MAX_CANDIDATES_FOR_JUDGEMENT]
        return json.dumps(bounded, ensure_ascii=False, indent=2)[:12000]

    def _clean_queries(self, values, raw_user_text: str = "") -> list[str]:
        return [
            cleaned
            for cleaned in (self._clean_query(value, raw_user_text) for value in self._pool_values(values))
            if cleaned
        ]

    def _pool_values(self, value) -> list:
        return value if isinstance(value, list) else []

    def _clean_query(self, value, raw_user_text: str = "") -> str:
        query = self._repair_mojibake(" ".join(str(value or "").split()))[:MAX_QUERY_LEN]
        raw = self._repair_mojibake(" ".join(str(raw_user_text or "").split()))
        if not query:
            return ""
        if raw and query == raw:
            return ""

        rejection_prefixes = ("不能放点", "不能播放", "不要放", "别放", "不要播", "别播")
        if any(query.startswith(prefix) for prefix in rejection_prefixes):
            return ""

        command_prefixes = (
            "我想听",
            "想听",
            "放点",
            "来点",
            "给我",
            "播放",
            "播一下",
            "放一下",
            "可以放",
        )
        for prefix in sorted(command_prefixes, key=len, reverse=True):
            if query.startswith(prefix):
                query = query[len(prefix):].strip(" ，,。.!！?？吗嘛呢吧")
                if self._looks_like_compact_chinese_sentence(query):
                    return ""
                break

        query = re.sub(r"^(can|could|would|please|play|listen to|put on|give me)\b", "", query, flags=re.I).strip()
        query = re.sub(r"[?？吗嘛呢吧]+$", "", query).strip()
        if not query:
            return ""
        if self._looks_like_scene_bucket_query(query):
            return ""
        if self._looks_like_scene_descriptor_query(query):
            return ""
        if self._looks_like_compact_chinese_sentence(query) and raw and query in raw:
            return ""
        return query

    def _is_bad_candidate(self, song: dict, music_task: dict | None = None) -> bool:
        text = " ".join(self._metadata_strings(song)).lower()
        utility_tokens = (
            "歌单",
            "playlist",
            "study",
            "学习",
            "自习",
            "white noise",
            "白噪音",
            "白噪声",
            "sleep music",
            "sleep",
            "睡眠",
            "助眠",
            "睡前",
            "utility",
            "sound effect",
            "background music",
            "背景音乐",
            "纯音乐盒",
        )
        if any(token in text for token in utility_tokens):
            return True
        candidate_versions = self._version_categories(text)
        if not candidate_versions:
            return False
        allowed_versions = self._requested_version_categories(music_task)
        return not candidate_versions.issubset(allowed_versions)

    def _requested_version_categories(self, music_task: dict | None) -> set[str]:
        if not isinstance(music_task, dict):
            return set()
        text_parts = []
        for key in ("type", "work_hint", "style_hint"):
            text_parts.append(str(music_task.get(key) or ""))
        for key in ("search_goals", "genres", "moods", "tags"):
            value = music_task.get(key)
            if isinstance(value, list):
                text_parts.extend(str(item) for item in value)
            else:
                text_parts.append(str(value or ""))
        for entity in music_task.get("primary_entities") or []:
            if isinstance(entity, dict):
                text_parts.extend(str(value) for value in entity.values())
        text = self._repair_mojibake(" ".join(text_parts)).lower()
        return self._version_categories(text)

    def _version_categories(self, text: str) -> set[str]:
        categories = set()
        if any(token in text for token in ("cover", "翻唱")):
            categories.add("cover")
        if any(token in text for token in ("ktv", "karaoke", "卡拉ok")):
            categories.add("ktv")
        if any(token in text for token in ("伴奏", "backing", "backing track", "accompaniment", "accompaniment version")):
            categories.add("accompaniment")
        return categories

    def _artist_name(self, song: dict | None) -> str:
        if not isinstance(song, dict):
            return ""
        artist = song.get("artist")
        if isinstance(artist, str) and artist.strip():
            return artist.strip()
        artists = song.get("ar") or song.get("artists") or []
        if isinstance(artists, list) and artists and isinstance(artists[0], dict):
            return str(artists[0].get("name") or "").strip()
        return ""

    def _album_name(self, song: dict | None) -> str:
        if not isinstance(song, dict):
            return ""
        album = song.get("album")
        if isinstance(album, str) and album.strip():
            return album.strip()
        for key in ("al", "album"):
            value = song.get(key)
            if isinstance(value, dict) and value.get("name"):
                return str(value.get("name")).strip()
        return ""

    def _aliases(self, song: dict | None) -> list[str]:
        if not isinstance(song, dict):
            return []
        aliases = song.get("aliases") or song.get("alias") or song.get("alia") or []
        if isinstance(aliases, str):
            aliases = [aliases]
        if not isinstance(aliases, list):
            return []
        return [str(alias).strip()[:120] for alias in aliases if str(alias).strip()][:5]

    def _metadata_strings(self, song: dict | None) -> list[str]:
        if not isinstance(song, dict):
            return []
        parts = [
            str(song.get("name") or song.get("title") or ""),
            self._artist_name(song),
            self._album_name(song),
        ]
        parts.extend(self._aliases(song))
        return [part for part in parts if part]

    def _normalize_candidate(self, song: dict, source_query: str) -> dict:
        title = str(song.get("name") or song.get("title") or "").strip()[:200]
        return {
            "id": song.get("id"),
            "name": title,
            "title": title,
            "artist": self._artist_name(song)[:160],
            "album": self._album_name(song)[:200],
            "aliases": self._aliases(song),
            "_source_query": source_query,
            "source_query": source_query,
            "raw": self._bounded_raw_metadata(song),
        }

    def _bounded_raw_metadata(self, song: dict) -> dict:
        allowed = {}
        for key in ("id", "name", "title", "artist", "ar", "artists", "al", "album", "alia", "alias", "aliases", "duration", "dt"):
            if key in song:
                allowed[key] = song[key]
        raw = json.dumps(allowed, ensure_ascii=False, default=str)[:MAX_RAW_METADATA_CHARS]
        try:
            return json.loads(raw)
        except Exception:
            return {"summary": raw}

    def _pool_list(self, value) -> list[dict]:
        return value if isinstance(value, list) else []

    def _structured_query_fallback(self, music_task: dict, raw_user_text: str) -> list[str]:
        if not isinstance(music_task, dict):
            return []
        parts = []
        for entity in music_task.get("primary_entities") or []:
            if isinstance(entity, dict) and entity.get("name"):
                parts.append(str(entity.get("name")))
        for key in ("work_hint", "style_hint"):
            if music_task.get(key):
                parts.append(str(music_task.get(key)))
        query = self._clean_query(" ".join(parts), "")
        return [query] if query else []

    def _bounded_dict_list(self, value) -> list[dict]:
        if not isinstance(value, list):
            return []
        result = []
        for item in value:
            if not isinstance(item, dict):
                continue
            bounded = {}
            for key in ("type", "task", "reason"):
                if item.get(key) is not None:
                    bounded[key] = str(item.get(key))[:240]
            if bounded:
                result.append(bounded)
            if len(result) >= 3:
                break
        return result

    def _dedupe(self, values: list[str]) -> list[str]:
        result = []
        for value in values:
            if value and value not in result:
                result.append(value)
        return result

    def _parse_json(self, text: str) -> dict:
        raw = str(text or "").strip()
        try:
            return json.loads(raw)
        except Exception:
            match = re.search(r"\{.*\}", raw, re.S)
            if not match:
                return {}
            try:
                return json.loads(match.group(0))
            except Exception:
                return {}

    def _safe_float(self, value) -> float:
        try:
            return float(value)
        except (TypeError, ValueError):
            return 0.0

    def _repair_mojibake(self, text: str) -> str:
        try:
            repaired = text.encode("latin1").decode("utf-8")
        except Exception:
            repaired = text
        replacements = {
            "鎯冲惉": "想听",
            "鎴戞兂鍚": "我想听",
            "鎾斁": "播放",
            "鏀剧偣": "放点",
            "鏉ョ偣": "来点",
            "涓嶈兘鏀剧偣": "不能放点",
            "缁欐垜": "给我",
            "姝屽崟": "歌单",
            "浼村": "伴奏",
        }
        for bad, good in replacements.items():
            repaired = repaired.replace(bad, good)
        return repaired

    def _looks_like_compact_chinese_sentence(self, query: str) -> bool:
        has_cjk = bool(re.search(r"[\u4e00-\u9fff]", query))
        has_ascii_word = bool(re.search(r"[A-Za-z0-9]", query))
        has_separator = bool(re.search(r"\s", query))
        return has_cjk and not has_ascii_word and not has_separator and len(query) > 6

    def _normalize_match_text(self, value) -> str:
        return re.sub(r"[\W_]+", "", str(value or "").casefold(), flags=re.UNICODE)

    def _looks_like_scene_bucket_query(self, query: str) -> bool:
        text = str(query or "").strip().lower()
        bucket_tokens = ("歌单", "歌曲", "音乐", "playlist", "mix", "合集", "助眠", "白噪", "学习")
        scene_tokens = ("晚上", "夜晚", "深夜", "睡前", "安静", "舒缓", "放松", "氛围", "mellow", "chill")
        has_bucket = any(token in text for token in bucket_tokens)
        has_scene = any(token in text for token in scene_tokens)
        has_specific_artistish = bool(re.search(r"[A-Za-z].+\s+[A-Za-z]", text)) and not has_bucket
        return has_bucket and has_scene and not has_specific_artistish

    def _looks_like_scene_descriptor_query(self, query: str) -> bool:
        text = str(query or "").strip().lower()
        scene_tokens = ("晚上", "夜晚", "深夜", "睡前", "安静", "舒缓", "放松", "氛围", "mellow", "chill", "不炸")
        token_count = len(re.findall(r"[A-Za-z0-9+&]+|[\u4e00-\u9fff]{1,4}", text))
        has_scene = sum(1 for token in scene_tokens if token in text) >= 2
        has_specific_ascii = bool(re.search(r"[A-Za-z][A-Za-z0-9'.+&-]*\s+[A-Za-z][A-Za-z0-9'.+&-]*", text))
        return has_scene and token_count <= 8 and not has_specific_ascii
