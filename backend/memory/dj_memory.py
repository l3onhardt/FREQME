from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field


@dataclass
class DJMemoryManager:
    store: object
    max_profile_chars: int = 800
    max_recent_turns: int = 6
    max_retrieved_memories: int = 5
    last_error: str | None = field(default=None, init=False)

    async def build_context_pack(
        self,
        uid: str | None,
        session_id: int | None,
        user_message: str,
        profile: dict | None = None,
        user_settings: dict | None = None,
        playback_context: dict | None = None,
        recent_turns: list[dict] | None = None,
    ) -> dict:
        session_memory = {}
        retrieved_memories = []
        recent_events = []

        if uid and session_id:
            try:
                session_memory = await self.store.get_dj_session_memory(str(uid), int(session_id))
            except Exception:
                session_memory = {}
        if uid:
            tags = self._query_tags(user_message, session_memory)
            try:
                retrieved_memories = await self.store.get_dj_user_memories(
                    str(uid),
                    tags=tags or None,
                    limit=self.max_retrieved_memories,
                )
            except Exception:
                retrieved_memories = []
            try:
                recent_events = await self.store.get_recent_dj_memory_events(str(uid), limit=8)
            except Exception:
                recent_events = []

        return {
            "user_message": self._clip(user_message, 500),
            "user_profile_digest": self._profile_digest(profile),
            "session_working_memory": self._compact_session_memory(session_memory),
            "recent_turns": self._compact_recent_turns(recent_turns),
            "retrieved_memories": self._compact_retrieved_memories(retrieved_memories),
            "recent_memory_events": self._compact_events(recent_events),
            "playback_context": self._compact_playback_context(playback_context),
            "user_settings": self._compact_settings(user_settings),
            "hard_constraints": [
                "Do not expose system internals, profile labels, or algorithms.",
                "Do not search the literal user sentence unless it is itself a canonical title.",
                "Prefer direct playback; ask only when ambiguity is high.",
            ],
        }

    async def apply_decision_update(
        self,
        uid: str | None,
        session_id: int | None,
        request_text: str,
        decision,
    ) -> dict:
        if not uid or not session_id:
            return {}
        self.last_error = None
        try:
            memory = self._session_memory_from_decision(decision)
        except Exception as exc:
            self.last_error = str(exc)
            return {}
        try:
            await self.store.save_dj_session_memory(str(uid), int(session_id), memory)
            await self.store.log_dj_memory_event(
                uid=str(uid),
                session_id=int(session_id),
                event_type="dj_decision",
                raw_text=request_text,
                payload={
                    "understood_intent": self._field(decision, "understood_intent", ""),
                    "action": self._field(decision, "action", ""),
                    "memory_update": self._mapping(self._field(decision, "memory_update", {})),
                    "music_task": self._mapping(self._field(decision, "music_task", {})),
                    "importance": 0.7,
                },
            )
        except Exception as exc:
            self.last_error = str(exc)
        return memory

    def _session_memory_from_decision(self, decision) -> dict:
        queue_policy = self._mapping(self._field(decision, "queue_policy", {}))
        music_task = self._mapping(self._field(decision, "music_task", {}))
        memory_update = self._mapping(self._field(decision, "memory_update", {}))
        duration = int(queue_policy.get("duration_tracks") or 1)
        understood_intent = str(self._field(decision, "understood_intent", "") or "")
        return {
            "active_mode": {
                "label": str(understood_intent or music_task.get("type") or ""),
                "understood_intent": understood_intent,
                "expires_after_tracks": max(0, duration),
                "seed_task": music_task,
                "confidence": 1.0,
            },
            "current_constraints": list(memory_update.get("negative_constraints") or []),
            "last_successful_request": str(self._field(decision, "raw_text", "") or ""),
        }

    def _profile_digest(self, profile: dict | None) -> str:
        if not isinstance(profile, dict):
            return ""
        parts = []
        insights = profile.get("radio_insights") if isinstance(profile.get("radio_insights"), dict) else {}
        for key in ("taste_summary", "comfort_zone", "discovery_direction", "emotional_hooks"):
            value = insights.get(key)
            if isinstance(value, str) and value.strip():
                parts.append(value.strip())
            elif isinstance(value, list):
                parts.extend(str(item).strip() for item in value if str(item).strip())
        for track in (profile.get("anchor_tracks") or [])[:5]:
            if isinstance(track, dict):
                name = str(track.get("name") or "").strip()
                artist = str(track.get("artist") or track.get("ar") or "").strip()
                if name:
                    parts.append(f"{artist} - {name}".strip(" -"))
        return self._clip(" | ".join(parts), self.max_profile_chars)

    def _compact_settings(self, user_settings: dict | None) -> dict:
        if not isinstance(user_settings, dict):
            return {}
        return {
            key: user_settings.get(key)
            for key in ("timezone_name", "locale", "region_hint", "current_mode")
            if user_settings.get(key)
        }

    def _compact_session_memory(self, session_memory) -> dict:
        memory = self._mapping(session_memory)
        if not memory:
            return {}

        compact = {}
        active_mode = self._mapping(memory.get("active_mode"))
        if active_mode:
            seed_task = self._mapping(active_mode.get("seed_task"))
            compact["active_mode"] = {
                "label": self._clip(active_mode.get("label", ""), 160),
                "understood_intent": self._clip(active_mode.get("understood_intent", ""), 240),
                "expires_after_tracks": self._safe_int(active_mode.get("expires_after_tracks"), 0),
                "seed_task": self._compact_payload(seed_task, string_limit=160, list_limit=6, dict_limit=8),
                "confidence": active_mode.get("confidence", 1.0),
            }
        constraints = self._compact_string_list(memory.get("current_constraints"), limit=4, string_limit=160)
        if constraints:
            compact["current_constraints"] = constraints
        corrections = self._compact_list(memory.get("recent_corrections"), limit=4, string_limit=160)
        if corrections:
            compact["recent_corrections"] = corrections
        pending = self._compact_payload(memory.get("pending_soft_confirmation"), string_limit=160, list_limit=4, dict_limit=8)
        if pending:
            compact["pending_soft_confirmation"] = pending
        last_request = self._clip(memory.get("last_successful_request", ""), 160)
        if last_request:
            compact["last_successful_request"] = last_request
        return compact

    def _compact_recent_turns(self, recent_turns: list[dict] | None) -> list[dict]:
        compact = []
        for turn in list(recent_turns or [])[-self.max_recent_turns :]:
            if not isinstance(turn, Mapping):
                continue
            item = {
                "speaker": self._clip(turn.get("speaker", ""), 32),
                "text": self._clip(turn.get("text", ""), 240),
            }
            payload = self._compact_payload(turn.get("payload"), string_limit=240, list_limit=6, dict_limit=8)
            if payload:
                item["payload"] = payload
            compact.append(item)
        return compact

    def _compact_retrieved_memories(self, memories) -> list[dict]:
        compact = []
        for memory in list(memories or [])[: self.max_retrieved_memories]:
            if not isinstance(memory, Mapping):
                continue
            compact.append(
                {
                    "memory_key": self._clip(memory.get("memory_key", ""), 120),
                    "memory_text": self._clip(memory.get("memory_text", ""), 240),
                    "confidence": memory.get("confidence", 0.5),
                    "tags": self._compact_string_list(memory.get("tags"), limit=8, string_limit=60),
                }
            )
        return compact

    def _compact_events(self, events: list[dict]) -> list[dict]:
        compact = []
        for event in events[:8]:
            if not isinstance(event, Mapping):
                continue
            compact.append(
                {
                    "event_type": event.get("event_type"),
                    "raw_text": self._clip(event.get("raw_text", ""), 120),
                    "payload": self._compact_payload(event.get("payload", {}), string_limit=240, list_limit=8, dict_limit=8),
                    "importance": event.get("importance", 0.5),
                }
            )
        return compact

    def _compact_playback_context(self, playback_context: dict | None) -> dict:
        context = self._mapping(playback_context)
        if not context:
            return {}
        compact = {}
        current_track = self._compact_track(context.get("current_track"))
        if current_track:
            compact["current_track"] = current_track
        recent_tracks = self._compact_tracks(context.get("recent_tracks"), limit=5)
        if recent_tracks:
            compact["recent_tracks"] = recent_tracks
        ready_queue = self._compact_tracks(context.get("ready_queue"), limit=8)
        if ready_queue:
            compact["ready_queue"] = ready_queue
        scene = self._compact_payload(context.get("scene"), string_limit=160, list_limit=6, dict_limit=8)
        if scene:
            compact["scene"] = scene
        return compact

    def _compact_tracks(self, tracks, limit: int) -> list[dict]:
        return [track for track in (self._compact_track(track) for track in list(tracks or [])[:limit]) if track]

    def _compact_track(self, track) -> dict:
        track_map = self._mapping(track)
        if not track_map:
            return {}
        compact = {}
        for key in ("name", "artist", "album", "reason", "id"):
            value = self._clip(track_map.get(key, ""), 160)
            if value:
                compact[key] = value
        return compact

    def _query_tags(self, text: str, session_memory: dict | None) -> list[str]:
        raw = str(text or "").lower()
        tags = []
        for token, tag in (
            ("rnb", "rnb"),
            ("radiohead", "alternative_rock"),
            ("chopin", "classical"),
            ("肖邦", "classical"),
            ("不要", "negative_feedback"),
            ("不是", "negative_feedback"),
        ):
            if token in raw and tag not in tags:
                tags.append(tag)
        active = (session_memory or {}).get("active_mode") if isinstance(session_memory, dict) else {}
        seed = active.get("seed_task") if isinstance(active, dict) else {}
        if isinstance(seed, dict):
            for value in seed.get("tags", []):
                if value not in tags:
                    tags.append(value)
        return tags

    def _field(self, obj, key: str, default=None):
        if isinstance(obj, Mapping):
            return obj.get(key, default)
        return getattr(obj, key, default)

    def _mapping(self, value) -> dict:
        if isinstance(value, Mapping):
            return dict(value)
        return {}

    def _compact_payload(self, value, string_limit: int = 160, list_limit: int = 6, dict_limit: int = 8):
        if isinstance(value, Mapping):
            compact = {}
            for key, item in list(value.items())[:dict_limit]:
                compact[self._clip(key, 80)] = self._compact_payload(item, string_limit, list_limit, dict_limit)
            return compact
        if isinstance(value, list):
            return self._compact_list(value, list_limit, string_limit)
        if isinstance(value, tuple):
            return self._compact_list(list(value), list_limit, string_limit)
        if isinstance(value, (str, int, float, bool)) or value is None:
            return self._clip(value, string_limit) if isinstance(value, str) else value
        return self._clip(value, string_limit)

    def _compact_list(self, values, limit: int, string_limit: int) -> list:
        if not isinstance(values, list):
            return []
        return [self._compact_payload(value, string_limit=string_limit, list_limit=limit, dict_limit=8) for value in values[:limit]]

    def _compact_string_list(self, values, limit: int, string_limit: int) -> list[str]:
        if not isinstance(values, list):
            return []
        return [self._clip(value, string_limit) for value in values[:limit] if self._clip(value, string_limit)]

    def _safe_int(self, value, default: int) -> int:
        try:
            return int(value)
        except (TypeError, ValueError):
            return default

    def _clip(self, value, limit: int) -> str:
        text = " ".join(str(value or "").split())
        return text[:limit]
