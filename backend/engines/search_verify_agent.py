from __future__ import annotations

from dataclasses import dataclass, field
import asyncio
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
                if not self._is_bad_candidate(candidate):
                    candidates.append(self._normalize_candidate(candidate, query))
        if not candidates:
            return await self._not_found(music_task, queries, "No candidates returned.")

        judgement = await self._judge(music_task, candidates)
        song = self._chosen_song(candidates, judgement)
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
            verification={
                "confidence": self._safe_float(judgement.get("confidence")),
                "matched_entities": judgement.get("matched_entities") or [],
                "version_note": str(judgement.get("version_note") or ""),
                "risk": str(judgement.get("risk") or ""),
            },
            fallback_candidates=judgement.get("fallback_candidates") or [],
            used_query=song.get("_source_query", ""),
        )

    async def _queries(self, music_task: dict, raw_user_text: str) -> list[str]:
        goals = [
            self._clean_query(query, raw_user_text)
            for query in music_task.get("search_goals", [])
            if self._clean_query(query, raw_user_text)
        ]
        prompt = f"""Create NetEase search queries from this structured music task.
Use only the structured task fields. Do not reinterpret the full user request.

Music task:
{json.dumps(music_task, ensure_ascii=False, indent=2)}

Return JSON only:
{{"search_queries":["artist title or performer composer work"]}}"""
        try:
            response = await asyncio.wait_for(
                self.llm.chat(prompt, max_tokens=220, system="You create music search queries. Return JSON only."),
                timeout=self.llm_timeout_s,
            )
            data = self._parse_json(response)
        except Exception:
            data = {}
        generated = [
            self._clean_query(query, raw_user_text)
            for query in data.get("search_queries", [])
            if self._clean_query(query, raw_user_text)
        ]
        return self._dedupe(generated + goals)[:6]

    async def _judge(self, music_task: dict, candidates: list[dict]) -> dict:
        prompt = f"""Choose the best verified playable music candidate for this DJ task.

Task:
{json.dumps(music_task, ensure_ascii=False, indent=2)}

Candidates:
{self._candidate_text(candidates)}

Reject playlists, utility audio, study audio, covers unless requested, wrong artists, and wrong classical performers.
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
                self.llm.chat(prompt, max_tokens=360, system="You verify music search results. Return JSON only."),
                timeout=self.llm_timeout_s,
            )
            return self._parse_json(response)
        except Exception:
            return {}

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
            return options[:3]
        entities = music_task.get("primary_entities") if isinstance(music_task, dict) else []
        names = [str(item.get("name")) for item in entities or [] if isinstance(item, dict) and item.get("name")]
        task = " ".join(names + [str(music_task.get("work_hint") or music_task.get("style_hint") or "")]).strip()
        return [{"type": "adjacent_version", "task": task, "reason": "Relax exact version while keeping the musical direction."}] if task else []

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

    def _candidate_text(self, candidates: list[dict]) -> str:
        bounded = candidates[:MAX_CANDIDATES_FOR_JUDGEMENT]
        return json.dumps(bounded, ensure_ascii=False, indent=2)[:12000]

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
                break

        query = re.sub(r"^(can|could|would|please|play|listen to|put on|give me)\b", "", query, flags=re.I).strip()
        query = re.sub(r"[?？吗嘛呢吧]+$", "", query).strip()
        if not query:
            return ""
        if self._looks_like_chinese_command_query(query):
            return ""
        return query

    def _is_bad_candidate(self, song: dict) -> bool:
        text = " ".join(self._metadata_strings(song)).lower()
        bad_tokens = (
            "歌单",
            "playlist",
            "study",
            "white noise",
            "白噪音",
            "sleep music",
            "sleep",
            "睡眠",
            "助眠",
            "utility",
            "sound effect",
            "background music",
            "ktv",
            "karaoke",
            "伴奏",
            "backing track",
            "backing",
            "accompaniment",
            "翻唱",
            "cover",
            "纯音乐盒",
        )
        return any(token in text for token in bad_tokens)

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

    def _looks_like_chinese_command_query(self, query: str) -> bool:
        has_cjk = bool(re.search(r"[\u4e00-\u9fff]", query))
        has_ascii_word = bool(re.search(r"[A-Za-z0-9]", query))
        return has_cjk and not has_ascii_word and len(query) > 6
