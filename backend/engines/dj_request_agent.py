from __future__ import annotations

from dataclasses import dataclass, field
import asyncio
import json
import re


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
        clean = " ".join(str(user_message or "").split())[:500]
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
        music_task = data.get("music_task") if isinstance(data.get("music_task"), dict) else {}
        queue_policy = data.get("queue_policy") if isinstance(data.get("queue_policy"), dict) else {}
        uncertainty = data.get("uncertainty") if isinstance(data.get("uncertainty"), dict) else {}
        dj_response = data.get("dj_response") if isinstance(data.get("dj_response"), dict) else {}
        memory_update = data.get("memory_update") if isinstance(data.get("memory_update"), dict) else {}
        music_task.setdefault("must_not_search_literal_user_sentence", True)
        queue_policy.setdefault("duration_tracks", 1)
        queue_policy.setdefault("continue_direction", data.get("action") in {"set_direction_and_play", "continue_current_mode"})
        uncertainty.setdefault("should_ask_user", data.get("action") == "ask_clarifying_question")
        dj_response.setdefault("speak_now", "我先按我理解到的方向接上。")
        return DJDecision(
            action=data["action"],
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
            music_task={"type": "unclear", "search_goals": [], "must_not_search_literal_user_sentence": True},
            queue_policy={"duration_tracks": 0, "continue_direction": False},
            uncertainty={"level": "high", "should_ask_user": True},
            dj_response={"speak_now": "这个我没接稳，是想听某个歌手，还是这种氛围？"},
            memory_update={"session_preference": [], "possible_long_term_preference": [], "negative_constraints": []},
            raw_text=raw_text,
        )

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
