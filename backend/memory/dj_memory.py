from __future__ import annotations

from dataclasses import dataclass


@dataclass
class DJMemoryManager:
    store: object
    max_profile_chars: int = 800
    max_recent_turns: int = 6
    max_retrieved_memories: int = 5

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
            "session_working_memory": session_memory if isinstance(session_memory, dict) else {},
            "recent_turns": list(recent_turns or [])[-self.max_recent_turns :],
            "retrieved_memories": list(retrieved_memories or [])[: self.max_retrieved_memories],
            "recent_memory_events": self._compact_events(recent_events),
            "playback_context": playback_context or {},
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
        memory = self._session_memory_from_decision(decision)
        try:
            await self.store.save_dj_session_memory(str(uid), int(session_id), memory)
            await self.store.log_dj_memory_event(
                uid=str(uid),
                session_id=int(session_id),
                event_type="dj_decision",
                raw_text=request_text,
                payload={
                    "understood_intent": getattr(decision, "understood_intent", ""),
                    "action": getattr(decision, "action", ""),
                    "memory_update": getattr(decision, "memory_update", {}),
                    "music_task": getattr(decision, "music_task", {}),
                    "importance": 0.7,
                },
            )
        except Exception:
            pass
        return memory

    def _session_memory_from_decision(self, decision) -> dict:
        queue_policy = getattr(decision, "queue_policy", {}) or {}
        music_task = getattr(decision, "music_task", {}) or {}
        memory_update = getattr(decision, "memory_update", {}) or {}
        duration = int(queue_policy.get("duration_tracks") or 1)
        return {
            "active_mode": {
                "label": str(getattr(decision, "understood_intent", "") or music_task.get("type") or ""),
                "understood_intent": str(getattr(decision, "understood_intent", "") or ""),
                "expires_after_tracks": max(0, duration),
                "seed_task": music_task,
                "confidence": 1.0,
            },
            "current_constraints": list(memory_update.get("negative_constraints") or []),
            "last_successful_request": str(getattr(decision, "raw_text", "") or ""),
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

    def _compact_events(self, events: list[dict]) -> list[dict]:
        compact = []
        for event in events[:8]:
            compact.append(
                {
                    "event_type": event.get("event_type"),
                    "raw_text": self._clip(event.get("raw_text", ""), 120),
                    "payload": event.get("payload", {}),
                    "importance": event.get("importance", 0.5),
                }
            )
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

    def _clip(self, value, limit: int) -> str:
        text = " ".join(str(value or "").split())
        return text[:limit]
