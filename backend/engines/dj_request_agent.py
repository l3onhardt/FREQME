from __future__ import annotations

from dataclasses import dataclass, field
import asyncio
import json
import re


ALLOWED_ACTIONS = {
    "play_now",
    "set_direction_and_play",
    "revise_mode_and_play",
    "soft_confirm_and_play",
    "ask_clarifying_question",
    "negative_feedback",
    "continue_current_mode",
}

PLAYABLE_ACTIONS = {
    "play_now",
    "set_direction_and_play",
    "revise_mode_and_play",
    "soft_confirm_and_play",
    "continue_current_mode",
}


@dataclass
class DJDecision:
    action: str
    understood_intent: str = ""
    music_task: dict = field(default_factory=dict)
    queue_policy: dict = field(default_factory=dict)
    uncertainty: dict = field(default_factory=dict)
    dj_response: dict = field(default_factory=dict)
    memory_update: dict = field(default_factory=dict)
    raw_text: str = ""

    def to_dict(self) -> dict:
        return {
            "action": self.action,
            "understood_intent": self.understood_intent,
            "music_task": self.music_task,
            "queue_policy": self.queue_policy,
            "uncertainty": self.uncertainty,
            "dj_response": self.dj_response,
            "memory_update": self.memory_update,
            "raw_text": self.raw_text,
        }


class DJRequestAgent:
    def __init__(self, llm, llm_timeout_s: float = 8.0):
        self.llm = llm
        self.llm_timeout_s = llm_timeout_s

    async def decide(self, user_message: str, context_pack: dict | None = None) -> DJDecision:
        clean = self._clean_user_message(user_message)
        if not clean:
            return self._safe_question(clean)
        prompt = self._prompt(clean, context_pack or {})
        try:
            response = await asyncio.wait_for(
                self.llm.chat(
                    prompt,
                    max_tokens=900,
                    system=(
                        "You are FREQME's private AI DJ request agent. "
                        "Understand the user's music intent from context and output only valid JSON."
                    ),
                ),
                timeout=self.llm_timeout_s,
            )
            data = self._parse_json(response)
        except Exception:
            data = {}
        return self._decision_from_data(clean, data)

    def _prompt(self, user_message: str, context_pack: dict) -> str:
        return f"""User just spoke to the AI radio DJ:
{user_message}

Context pack JSON:
{json.dumps(context_pack, ensure_ascii=False, indent=2)}

Decide what the user wants musically. Be an AI DJ, not a keyword classifier.

Rules:
- Do not search the literal user sentence unless the sentence itself is a canonical title.
- Infer fuzzy artist, band, composer, performer, work-family, scene, style, mood, correction, rejection, or continuation intent.
- Most requests should play now or set a direction and play.
- Ask only when ambiguity is high and context cannot resolve it.
- A request can set a multi-track queue policy.
- Memory update should describe user/session preference, not encyclopedia aliases.
- Never expose profile, algorithm, or system wording in the DJ response.

Return only JSON:
{{
  "action": "play_now | set_direction_and_play | revise_mode_and_play | soft_confirm_and_play | ask_clarifying_question | negative_feedback | continue_current_mode",
  "understood_intent": "internal interpretation",
  "music_task": {{
    "type": "specific_track | artist_direction | artist_work_direction | scene_genre_direction | negative_feedback | continuation",
    "primary_entities": [{{"role": "artist|performer|composer|work|genre", "name": "canonical or inferred name"}}],
    "work_hint": "",
    "style_hint": "",
    "search_goals": ["concrete NetEase-friendly search query"],
    "must_not_search_literal_user_sentence": true
  }},
  "queue_policy": {{"duration_tracks": 1, "continue_direction": false, "avoid_repetition": true}},
  "uncertainty": {{"level": "low|medium|high", "reason": "", "should_ask_user": false}},
  "dj_response": {{"speak_now": "short natural Chinese DJ response", "tone": "warm_confident"}},
  "memory_update": {{"session_preference": [], "possible_long_term_preference": [], "negative_constraints": []}}
}}"""

    def _decision_from_data(self, raw_text: str, data: dict) -> DJDecision:
        if not isinstance(data, dict) or not isinstance(data.get("action"), str):
            return self._safe_question(raw_text)
        action = data["action"]
        if action not in ALLOWED_ACTIONS:
            return self._safe_question(raw_text)

        music_task = self._normalize_music_task(data.get("music_task"))
        if action in PLAYABLE_ACTIONS and not self._is_executable_music_task(music_task):
            return self._safe_question(raw_text)

        queue_policy = self._normalize_queue_policy(data.get("queue_policy"), action)
        uncertainty = self._normalize_uncertainty(data.get("uncertainty"), action)
        dj_response = self._normalize_dj_response(data.get("dj_response"))
        memory_update = self._normalize_memory_update(data.get("memory_update"))
        return DJDecision(
            action=action,
            understood_intent=str(data.get("understood_intent") or ""),
            music_task=music_task,
            queue_policy=queue_policy,
            uncertainty=uncertainty,
            dj_response=dj_response,
            memory_update=memory_update,
            raw_text=raw_text,
        )

    def _safe_question(self, raw_text: str) -> DJDecision:
        return DJDecision(
            action="ask_clarifying_question",
            understood_intent="The request is not clear enough to select music safely.",
            music_task={
                "type": "unclear",
                "primary_entities": [],
                "work_hint": "",
                "style_hint": "",
                "search_goals": [],
                "must_not_search_literal_user_sentence": True,
            },
            queue_policy={"duration_tracks": 0, "continue_direction": False, "avoid_repetition": True},
            uncertainty={"level": "high", "reason": "", "should_ask_user": True},
            dj_response={"speak_now": "这个我没接稳，是想听某个歌手，还是这种氛围？", "tone": "warm_clarifying"},
            memory_update={"session_preference": [], "possible_long_term_preference": [], "negative_constraints": []},
            raw_text=raw_text,
        )

    def _clean_user_message(self, user_message: str) -> str:
        clean = " ".join(str(user_message or "").split())[:500]
        if not clean:
            return ""
        return self._strip_accidental_latin_prefix(clean)

    def _strip_accidental_latin_prefix(self, text: str) -> str:
        match = re.match(r"^[A-Za-z]\s*(?=[\u4e00-\u9fff])", text)
        if not match:
            return text
        candidate = text[match.end():].strip()
        if not self._starts_with_request_marker(candidate):
            return text
        return candidate

    def _starts_with_request_marker(self, text: str) -> bool:
        return str(text or "").startswith(
            (
                "我要",
                "我想",
                "想听",
                "想要",
                "来点",
                "放点",
                "播点",
                "播放",
                "点首",
                "点一首",
                "给我",
                "换成",
                "换点",
                "接着",
                "继续",
                "能不能",
                "不能",
                "可以",
            )
        )

    def _parse_json(self, text: str) -> dict:
        raw = str(text or "").strip()
        try:
            return json.loads(raw)
        except Exception:
            pass

        candidates = [match.group(1) for match in re.finditer(r"```(?:json)?\s*(\{.*?\})\s*```", raw, re.S | re.I)]
        candidates.extend(self._json_object_candidates(raw))
        for candidate in candidates:
            try:
                data = json.loads(candidate)
            except Exception:
                continue
            if isinstance(data, dict):
                return data
        return {}

    def _json_object_candidates(self, text: str) -> list[str]:
        candidates = []
        starts = [index for index, char in enumerate(text) if char == "{"]
        for start in starts:
            depth = 0
            in_string = False
            escape = False
            for index in range(start, len(text)):
                char = text[index]
                if in_string:
                    if escape:
                        escape = False
                    elif char == "\\":
                        escape = True
                    elif char == '"':
                        in_string = False
                    continue
                if char == '"':
                    in_string = True
                elif char == "{":
                    depth += 1
                elif char == "}":
                    depth -= 1
                    if depth == 0:
                        candidates.append(text[start : index + 1])
                        break
        return candidates

    def _normalize_music_task(self, value) -> dict:
        source = value if isinstance(value, dict) else {}
        return {
            "type": str(source.get("type") or ""),
            "primary_entities": self._normalize_primary_entities(source.get("primary_entities")),
            "work_hint": str(source.get("work_hint") or ""),
            "style_hint": str(source.get("style_hint") or ""),
            "search_goals": self._normalize_search_goals(source.get("search_goals")),
            "must_not_search_literal_user_sentence": True,
        }

    def _is_executable_music_task(self, music_task: dict) -> bool:
        return any(
            [
                bool(music_task.get("search_goals")),
                bool(music_task.get("primary_entities")),
                bool(str(music_task.get("work_hint") or "").strip()),
                bool(str(music_task.get("style_hint") or "").strip()),
            ]
        )

    def _normalize_search_goals(self, value) -> list[str]:
        if not isinstance(value, list):
            return []
        goals = []
        for item in value:
            goal = str(item or "").strip()
            if goal:
                goals.append(goal)
        return goals

    def _normalize_primary_entities(self, value) -> list[dict]:
        if not isinstance(value, list):
            return []
        entities = []
        for item in value:
            if not isinstance(item, dict):
                continue
            name = str(item.get("name") or "").strip()
            if not name:
                continue
            role = str(item.get("role") or "").strip() or "music_entity"
            entities.append({"role": role, "name": name})
        return entities

    def _normalize_queue_policy(self, value, action: str) -> dict:
        source = value if isinstance(value, dict) else {}
        return {
            "duration_tracks": self._coerce_duration(source.get("duration_tracks"), default=1),
            "continue_direction": self._coerce_bool(
                source.get("continue_direction"),
                default=action in {"set_direction_and_play", "continue_current_mode"},
            ),
            "avoid_repetition": self._coerce_bool(source.get("avoid_repetition"), default=True),
        }

    def _normalize_uncertainty(self, value, action: str) -> dict:
        source = value if isinstance(value, dict) else {}
        level = source.get("level")
        if level not in {"low", "medium", "high"}:
            level = "medium"
        return {
            "level": level,
            "reason": str(source.get("reason") or ""),
            "should_ask_user": self._coerce_bool(
                source.get("should_ask_user"),
                default=action == "ask_clarifying_question",
            ),
        }

    def _normalize_dj_response(self, value) -> dict:
        source = value if isinstance(value, dict) else {}
        return {
            "speak_now": str(source.get("speak_now") or "我先按我理解到的方向接上。"),
            "tone": str(source.get("tone") or "warm_confident"),
        }

    def _normalize_memory_update(self, value) -> dict:
        source = value if isinstance(value, dict) else {}
        return {
            "session_preference": source.get("session_preference") if isinstance(source.get("session_preference"), list) else [],
            "possible_long_term_preference": (
                source.get("possible_long_term_preference")
                if isinstance(source.get("possible_long_term_preference"), list)
                else []
            ),
            "negative_constraints": source.get("negative_constraints") if isinstance(source.get("negative_constraints"), list) else [],
        }

    def _coerce_duration(self, value, default: int) -> int:
        try:
            duration = int(value)
        except (TypeError, ValueError):
            duration = default
        return max(0, min(8, duration))

    def _coerce_bool(self, value, default: bool) -> bool:
        return value if isinstance(value, bool) else default
