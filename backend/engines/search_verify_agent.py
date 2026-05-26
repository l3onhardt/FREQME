from __future__ import annotations

from dataclasses import dataclass, field
import asyncio
import json
import re


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
                    enriched = dict(candidate)
                    enriched["_source_query"] = query
                    candidates.append(enriched)
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

        resolved = await self.audio_resolver.resolve_with_candidates(song, uid=uid)
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
                "confidence": float(judgement.get("confidence") or 0.0),
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
        prompt = f"""Create NetEase search queries from this music task.
Do not include the raw user sentence unless it is a canonical music title.

Music task:
{json.dumps(music_task, ensure_ascii=False, indent=2)}

Raw user text:
{raw_user_text}

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
        chosen_id = str((judgement or {}).get("chosen_id") or "").strip()
        if chosen_id:
            for candidate in candidates:
                if str(candidate.get("id")) == chosen_id:
                    return candidate
        confidence = float((judgement or {}).get("confidence") or 0.0)
        if confidence <= 0 and candidates:
            return None
        return candidates[0] if candidates else None

    def _candidate_text(self, candidates: list[dict]) -> str:
        lines = []
        for index, song in enumerate(candidates[:24]):
            artist = self._artist_name(song)
            album = ""
            if isinstance(song.get("al"), dict):
                album = str(song["al"].get("name") or "")
            lines.append(
                f"{index}. id={song.get('id')} | {song.get('name')} - {artist} | album={album} | source={song.get('_source_query')}"
            )
        return "\n".join(lines)

    def _clean_query(self, value, raw_user_text: str = "") -> str:
        query = " ".join(str(value or "").split())[:120]
        raw = " ".join(str(raw_user_text or "").split())
        if not query:
            return ""
        command_fragments = ("我想听", "想听", "放点", "来点", "不能放点", "给我", "播放")
        if query == raw and any(fragment in raw for fragment in command_fragments):
            return ""
        if query in command_fragments:
            return ""
        return query

    def _is_bad_candidate(self, song: dict) -> bool:
        text = f"{song.get('name', '')} {self._artist_name(song)}".lower()
        bad_tokens = ("歌单", "playlist", "study", "white noise", "sleep music", "伴奏", "karaoke")
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
