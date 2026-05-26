from __future__ import annotations

from collections.abc import Mapping
from dataclasses import asdict, dataclass, field, is_dataclass


PLAYABLE_ACTIONS = {
    "play_now",
    "set_direction_and_play",
    "revise_mode_and_play",
    "soft_confirm_and_play",
    "continue_current_mode",
    "negative_feedback",
}


@dataclass
class QueueDirectorResult:
    status: str
    dj_text: str = ""
    next_song: dict | None = None
    url: str = ""
    decision: dict = field(default_factory=dict)
    verification: dict = field(default_factory=dict)
    recovery_options: list[dict] = field(default_factory=list)

    def to_dict(self) -> dict:
        def json_safe(value):
            if isinstance(value, Mapping):
                return {str(key): json_safe(item) for key, item in value.items()}
            if is_dataclass(value):
                return json_safe(asdict(value))
            if isinstance(value, list):
                return [json_safe(item) for item in value]
            if isinstance(value, tuple):
                return [json_safe(item) for item in value]
            if isinstance(value, (str, int, float, bool)) or value is None:
                return value
            return str(value)[:240]

        return {
            "status": self.status,
            "dj_text": self.dj_text,
            "next_song": json_safe(self.next_song) if self.next_song is not None else None,
            "url": self.url,
            "decision": json_safe(self.decision or {}),
            "verification": json_safe(self.verification or {}),
            "recovery_options": json_safe(self.recovery_options or []),
        }


class QueueDirector:
    def __init__(self, dj_request_agent, search_verify_agent, memory_manager):
        self.dj_agent = dj_request_agent
        self.verifier = search_verify_agent
        self.memory_manager = memory_manager

    async def handle_song_request(
        self,
        request_text: str,
        playback_queue,
        uid: str | None,
        session_id: int | None,
        profile: dict | None,
        user_settings: dict | None,
        playback_context: dict | None,
        recent_turns: list[dict] | None = None,
    ) -> QueueDirectorResult:
        context_pack = await self._build_context_pack(
            uid,
            session_id,
            request_text,
            profile,
            user_settings,
            playback_context,
            recent_turns,
        )
        try:
            decision = await self.dj_agent.decide(request_text, context_pack)
        except Exception:
            return QueueDirectorResult(
                status="needs_recovery",
                dj_text="I could not safely understand that music request.",
                decision={},
                verification={},
                recovery_options=[],
            )

        await self._apply_decision_update(uid, session_id, request_text, decision)

        decision_dict = self._safe_dict(decision, request_text)
        action = self._field(decision, "action", "")
        if action == "ask_clarifying_question":
            return QueueDirectorResult(
                status="ask",
                dj_text=self._safe_dj_text(
                    self._dj_text(decision),
                    request_text,
                    fallback="Which direction should I play?",
                ),
                decision=decision_dict,
            )

        if action in PLAYABLE_ACTIONS:
            playback_queue.clear_ready()
            if not self._has_executable_music_task(decision):
                return QueueDirectorResult(
                    status="needs_recovery",
                    dj_text=self._recovery_text(decision, request_text),
                    decision=decision_dict,
                )

            verification = await self._verify(decision, uid, request_text)
            if self._is_verified(verification):
                song = dict(self._field(verification, "selected_song", {}) or {})
                url = str(self._field(verification, "url", "") or "")
                selection_reason = {
                    "type": "dj_agent_verified",
                    "understood_intent": self._safe_text(
                        self._field(decision, "understood_intent", ""),
                        request_text,
                        fallback="",
                    ),
                    "verification_note": self._safe_text(
                        self._verification_note(verification),
                        request_text,
                        fallback="",
                    ),
                }
                selection_reason["text"] = (
                    selection_reason["verification_note"]
                    or selection_reason["understood_intent"]
                    or "DJ request verified"
                )
                playback_queue.add_ready(song, url, selection_reason=selection_reason)
                return QueueDirectorResult(
                    status="queued",
                    dj_text=self._safe_dj_text(
                        self._dj_text(decision),
                        request_text,
                        fallback="Queued the verified track.",
                    ),
                    next_song=song,
                    url=url,
                    decision=decision_dict,
                    verification=self._safe_dict(verification, request_text),
                )

            return QueueDirectorResult(
                status="needs_recovery",
                dj_text=self._recovery_text(decision, request_text),
                decision=decision_dict,
                verification=self._safe_dict(verification, request_text),
                recovery_options=self._bounded_recovery_options(verification),
            )

        return QueueDirectorResult(
            status="ask",
            dj_text="I need to confirm the music direction first.",
            decision=decision_dict,
        )

    async def handle_request(
        self,
        uid: str | None,
        session_id: int | None,
        request_text: str,
        profile: dict | None = None,
        user_settings: dict | None = None,
        playback_context: dict | None = None,
        recent_turns: list[dict] | None = None,
        playback_queue=None,
    ) -> QueueDirectorResult:
        if playback_queue is None:
            raise TypeError("playback_queue is required")
        return await self.handle_song_request(
            request_text,
            playback_queue=playback_queue,
            uid=uid,
            session_id=session_id,
            profile=profile,
            user_settings=user_settings,
            playback_context=playback_context,
            recent_turns=recent_turns,
        )

    async def _build_context_pack(
        self,
        uid,
        session_id,
        request_text,
        profile,
        user_settings,
        playback_context,
        recent_turns,
    ) -> dict:
        try:
            return await self.memory_manager.build_context_pack(
                uid,
                session_id,
                request_text,
                profile=profile,
                user_settings=user_settings,
                playback_context=playback_context,
                recent_turns=recent_turns,
            )
        except Exception:
            return {
                "user_profile_digest": "",
                "session_working_memory": {},
                "recent_turns": list(recent_turns or [])[-3:],
                "playback_context": playback_context or {},
                "user_settings": user_settings or {},
                "hard_constraints": [
                    "Do not expose system internals.",
                    "Do not search the literal user sentence unless it is a canonical title.",
                ],
            }

    async def _apply_decision_update(self, uid, session_id, request_text, decision) -> None:
        try:
            await self.memory_manager.apply_decision_update(uid, session_id, request_text, decision)
        except Exception:
            return None

    async def _verify(self, decision, uid: str | None, request_text: str):
        try:
            return await self.verifier.verify(
                self._mapping(self._field(decision, "music_task", {})),
                uid=uid,
                raw_user_text=request_text,
            )
        except Exception:
            return {
                "status": "error",
                "failure_reason": "Search verification failed safely.",
                "recovery_options": [],
            }

    def _is_verified(self, verification) -> bool:
        return (
            self._field(verification, "status", "") == "verified"
            and bool(self._mapping(self._field(verification, "selected_song", {})))
            and bool(str(self._field(verification, "url", "") or ""))
        )

    def _dj_text(self, decision) -> str:
        response = self._mapping(self._field(decision, "dj_response", {}))
        return str(response.get("speak_now") or "")

    def _safe_dj_text(self, text: str, request_text: str, fallback: str) -> str:
        return self._safe_text(text, request_text, fallback=fallback) or fallback

    def _safe_text(self, text, request_text: str, fallback: str = "") -> str:
        value = str(text or "").strip()
        if not value or self._contains_raw_text(value, request_text):
            return fallback
        return value[:240]

    def _recovery_text(self, decision, request_text: str = "") -> str:
        intent = str(self._field(decision, "understood_intent", "") or "").strip()
        if intent and not self._contains_raw_text(intent, request_text):
            return f"I tried that direction but could not verify a playable match: {intent}"

        task = self._mapping(self._field(decision, "music_task", {}))
        direction = str(task.get("type") or "this music direction").strip()
        if self._contains_raw_text(direction, request_text):
            direction = "this music direction"
        return f"I tried {direction} but could not verify a playable match."

    def _verification_note(self, verification) -> str:
        data = self._mapping(self._field(verification, "verification", {}))
        return str(data.get("version_note") or data.get("risk") or "")

    def _bounded_recovery_options(self, verification) -> list[dict]:
        options = self._field(verification, "recovery_options", [])
        if not isinstance(options, list):
            return []
        result = []
        for option in options:
            if not isinstance(option, Mapping):
                continue
            bounded = {}
            for key in ("type", "task", "reason"):
                if option.get(key) is not None:
                    bounded[key] = str(option.get(key))[:240]
            if bounded:
                result.append(bounded)
            if len(result) >= 3:
                break
        return result

    def _has_executable_music_task(self, decision) -> bool:
        task = self._mapping(self._field(decision, "music_task", {}))
        return any(
            [
                bool(self._nonempty_list(task.get("search_goals"))),
                bool(self._nonempty_list(task.get("primary_entities"))),
                bool(str(task.get("work_hint") or "").strip()),
                bool(str(task.get("style_hint") or "").strip()),
            ]
        )

    def _nonempty_list(self, value) -> list:
        if not isinstance(value, list):
            return []
        return [item for item in value if item]

    def _contains_raw_text(self, candidate: str, request_text: str) -> bool:
        raw = " ".join(str(request_text or "").split())
        text = " ".join(str(candidate or "").split())
        return bool(raw and text and (raw in text or text in raw))

    def _safe_dict(self, value, request_text: str) -> dict:
        data = self._to_dict(value)
        return self._sanitize_value(data, request_text) if isinstance(data, dict) else {}

    def _sanitize_value(self, value, request_text: str):
        if isinstance(value, Mapping):
            clean = {}
            for key, item in value.items():
                key_text = str(key)
                if key_text == "raw_text":
                    continue
                clean[key_text] = self._sanitize_value(item, request_text)
            return clean
        if isinstance(value, list):
            return [self._sanitize_value(item, request_text) for item in value]
        if isinstance(value, tuple):
            return [self._sanitize_value(item, request_text) for item in value]
        if isinstance(value, str):
            return "[redacted]" if self._contains_raw_text(value, request_text) else value
        if isinstance(value, (int, float, bool)) or value is None:
            return value
        return str(value)

    def _to_dict(self, value) -> dict:
        if value is None:
            return {}
        if isinstance(value, Mapping):
            return dict(value)
        to_dict = getattr(value, "to_dict", None)
        if callable(to_dict):
            data = to_dict()
            return dict(data) if isinstance(data, Mapping) else {}
        if is_dataclass(value):
            return asdict(value)
        return {}

    def _mapping(self, value) -> dict:
        if isinstance(value, Mapping):
            return dict(value)
        return {}

    def _field(self, obj, key: str, default=None):
        if isinstance(obj, Mapping):
            return obj.get(key, default)
        return getattr(obj, key, default)
