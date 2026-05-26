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


class QueueDirector:
    def __init__(self, dj_agent, verifier, playback_queue, memory_manager):
        self.dj_agent = dj_agent
        self.verifier = verifier
        self.playback_queue = playback_queue
        self.memory_manager = memory_manager

    async def handle_request(
        self,
        uid: str | None,
        session_id: int | None,
        request_text: str,
        profile: dict | None = None,
        user_settings: dict | None = None,
        playback_context: dict | None = None,
        recent_turns: list[dict] | None = None,
    ) -> QueueDirectorResult:
        context_pack = await self.memory_manager.build_context_pack(
            uid,
            session_id,
            request_text,
            profile=profile,
            user_settings=user_settings,
            playback_context=playback_context,
            recent_turns=recent_turns,
        )
        decision = await self.dj_agent.decide(request_text, context_pack)
        await self.memory_manager.apply_decision_update(uid, session_id, request_text, decision)

        decision_dict = self._to_dict(decision)
        action = self._field(decision, "action", "")
        if action == "ask_clarifying_question":
            return QueueDirectorResult(
                status="ask",
                dj_text=self._dj_text(decision) or "你想听哪一类？",
                decision=decision_dict,
            )

        if action in PLAYABLE_ACTIONS:
            self.playback_queue.clear_ready()
            verification = await self._verify(decision, uid, request_text)
            if self._is_verified(verification):
                song = dict(self._field(verification, "selected_song", {}) or {})
                url = str(self._field(verification, "url", "") or "")
                selection_reason = {
                    "type": "dj_agent_verified",
                    "understood_intent": str(self._field(decision, "understood_intent", "") or ""),
                    "verification_note": self._verification_note(verification),
                }
                self.playback_queue.add_ready(song, url, selection_reason=selection_reason)
                return QueueDirectorResult(
                    status="queued",
                    dj_text=self._dj_text(decision),
                    next_song=song,
                    url=url,
                    decision=decision_dict,
                    verification=self._to_dict(verification),
                )
            return QueueDirectorResult(
                status="needs_recovery",
                dj_text=self._recovery_text(decision),
                decision=decision_dict,
                verification=self._to_dict(verification),
                recovery_options=self._bounded_recovery_options(verification),
            )

        return QueueDirectorResult(
            status="ask",
            dj_text="我需要再确认一下你想听的音乐方向。",
            decision=decision_dict,
        )

    async def _verify(self, decision, uid: str | None, request_text: str):
        try:
            return await self.verifier.verify(
                self._mapping(self._field(decision, "music_task", {})),
                uid=uid,
                raw_user_text=request_text,
            )
        except Exception as exc:
            return {
                "status": "error",
                "failure_reason": str(exc),
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

    def _recovery_text(self, decision) -> str:
        intent = str(self._field(decision, "understood_intent", "") or "").strip()
        if intent:
            return f"我按这个方向找了，但还没核到可播放的准确版本：{intent}"
        task = self._mapping(self._field(decision, "music_task", {}))
        direction = str(task.get("type") or "这个音乐方向")
        return f"我按{direction}找了，但还没核到可播放的准确版本。"

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
