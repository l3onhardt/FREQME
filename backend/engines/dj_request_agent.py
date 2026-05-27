from __future__ import annotations

from dataclasses import dataclass, field
import asyncio
import inspect
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
                self._chat_json(
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
        decision = self._decision_from_data(clean, data)
        if decision.action == "ask_clarifying_question":
            fallback = self._fallback_decision_for_clear_request(clean, context_pack or {})
            if fallback:
                return fallback
        return decision

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

    def _fallback_decision_for_clear_request(self, raw_text: str, context_pack: dict) -> DJDecision | None:
        entity = self._extract_clear_entity_request(raw_text)
        if entity:
            performer_work = self._split_performer_work_entity(entity)
            if performer_work:
                return self._artist_work_direction_decision(raw_text, *performer_work)
            return self._entity_direction_decision(raw_text, entity)

        entity = self._extract_bare_entity_request(raw_text)
        if entity:
            performer_work = self._split_performer_work_entity(entity)
            if performer_work:
                return self._artist_work_direction_decision(raw_text, *performer_work)
            return self._entity_direction_decision(raw_text, entity)

        scene = self._extract_scene_direction(raw_text, context_pack)
        if scene:
            return self._scene_direction_decision(raw_text, scene)

        return None

    def _entity_direction_decision(self, raw_text: str, entity: str) -> DJDecision:
        return DJDecision(
            action="set_direction_and_play",
            understood_intent=f"User wants music around {entity}.",
            music_task={
                "type": "artist_direction",
                "primary_entities": [{"role": "music_entity", "name": entity}],
                "work_hint": "",
                "style_hint": entity,
                "search_goals": [entity],
                "must_not_search_literal_user_sentence": True,
            },
            queue_policy={"duration_tracks": 4, "continue_direction": True, "avoid_repetition": True},
            uncertainty={
                "level": "medium",
                "reason": "LLM unavailable; clear music entity request structured locally.",
                "should_ask_user": False,
            },
            dj_response={"speak_now": f"懂了，我先按 {entity} 这个方向接上。", "tone": "warm_confident"},
            memory_update={
                "session_preference": [entity],
                "possible_long_term_preference": [],
                "negative_constraints": [],
            },
            raw_text=raw_text,
        )

    def _artist_work_direction_decision(self, raw_text: str, performer: str, work: str) -> DJDecision:
        search_goal = " ".join(part for part in (performer, work) if part).strip()
        return DJDecision(
            action="set_direction_and_play",
            understood_intent=f"User wants {work} associated with {performer}.",
            music_task={
                "type": "artist_work_direction",
                "primary_entities": [
                    {"role": "performer", "name": performer},
                    {"role": "work", "name": work},
                ],
                "work_hint": work,
                "style_hint": search_goal,
                "search_goals": [search_goal] if search_goal else [],
                "must_not_search_literal_user_sentence": True,
            },
            queue_policy={"duration_tracks": 5, "continue_direction": True, "avoid_repetition": True},
            uncertainty={
                "level": "medium",
                "reason": "LLM unavailable; performer/work request structured locally.",
                "should_ask_user": False,
            },
            dj_response={"speak_now": f"懂了，我先按 {performer} 和 {work} 这条线接上。", "tone": "warm_confident"},
            memory_update={
                "session_preference": [search_goal] if search_goal else [],
                "possible_long_term_preference": [],
                "negative_constraints": [],
            },
            raw_text=raw_text,
        )

    def _scene_direction_decision(self, raw_text: str, scene: dict) -> DJDecision:
        label = scene["label"]
        search_goals = scene["search_goals"]
        constraints = scene.get("constraints", [])
        preference = [label] + constraints
        return DJDecision(
            action="set_direction_and_play",
            understood_intent=f"User wants {label}.",
            music_task={
                "type": "scene_genre_direction",
                "primary_entities": [{"role": "scene", "name": label}],
                "work_hint": "",
                "style_hint": "，".join(preference),
                "search_goals": search_goals,
                "must_not_search_literal_user_sentence": True,
            },
            queue_policy={"duration_tracks": 5, "continue_direction": True, "avoid_repetition": True},
            uncertainty={
                "level": "medium",
                "reason": "LLM unavailable; clear scene request structured locally.",
                "should_ask_user": False,
            },
            dj_response={"speak_now": f"懂了，我把声音往{label}的方向收一收。", "tone": "warm_confident"},
            memory_update={
                "session_preference": preference,
                "possible_long_term_preference": [],
                "negative_constraints": constraints,
            },
            raw_text=raw_text,
        )

    def _clean_user_message(self, user_message: str) -> str:
        clean = " ".join(str(user_message or "").split())[:500]
        if not clean:
            return ""
        return self._strip_accidental_latin_prefix(clean)

    def _extract_clear_entity_request(self, text: str) -> str:
        clean = str(text or "").strip()
        if not clean:
            return ""
        patterns = (
            r"^(?:我(?:想|要)?听|想听|来点|放点|播点|播放|点首|点一首|给我(?:来点|放点|播点|播放)?)(?P<body>.+)$",
            r"^(?:能不能|不能|可以)(?:给我)?(?:来点|放点|播点|播放|听)?(?P<body>.+)$",
            r"^(?:can you|could you|would you|please|play|put on|i want|i'd like|give me)\s+(?P<body>.+)$",
        )
        body = ""
        for pattern in patterns:
            match = re.match(pattern, clean, re.I)
            if match:
                body = match.group("body")
                break
        if not body:
            return ""
        entity = self._clean_entity_body(body)
        if not self._looks_like_music_entity(entity):
            return ""
        return entity

    def _extract_bare_entity_request(self, text: str) -> str:
        clean = str(text or "").strip()
        if not clean:
            return ""
        if self._starts_with_request_marker(clean) or self._contains_scene_or_constraint(clean):
            return ""
        if len(clean) > 80:
            return ""
        if re.search(r"[?？。！，,;；]", clean):
            return ""
        if re.fullmatch(r"[\u4e00-\u9fffA-Za-z0-9 .'+&-]+", clean) is None:
            return ""
        if re.fullmatch(r"[\u4e00-\u9fff]+", clean) and len(clean) < 2:
            return ""
        if re.fullmatch(r"[A-Za-z0-9 .'+&-]+", clean) and len(clean.replace(" ", "")) < 3:
            return ""
        if re.search(r"^(这个|那个|刚才|之前|现在|随便|都行|不要|不是)$", clean):
            return ""
        return clean

    def _clean_entity_body(self, body: str) -> str:
        entity = str(body or "").strip()
        entity = re.sub(r"[，。！？?!、]+$", "", entity).strip()
        entity = re.sub(r"(?:的歌|的曲子|的作品|的音乐|歌|曲子|作品|音乐)$", "", entity).strip()
        entity = re.sub(r"(?:可以吗|行吗|好吗|好不好|吗|么|呢|吧)$", "", entity).strip()
        entity = re.sub(r"的$", "", entity).strip()
        entity = re.sub(r"^(?:一点|一些|几个|几首|首)\s*", "", entity).strip()
        return entity[:80]

    def _looks_like_music_entity(self, entity: str) -> bool:
        if not entity or len(entity) > 80:
            return False
        if self._contains_scene_or_constraint(entity):
            return False
        if re.search(r"[\u4e00-\u9fffA-Za-z0-9]", entity) is None:
            return False
        if re.search(r"(这个|那个|刚才|之前|现在|随便|东西)$", entity):
            return False
        return True

    def _split_performer_work_entity(self, entity: str) -> tuple[str, str] | None:
        clean = str(entity or "").strip()
        if not clean or "的" not in clean:
            return None
        performer, work = [part.strip() for part in clean.split("的", 1)]
        if not performer or not work:
            return None
        if len(performer) > 40 or len(work) > 50:
            return None
        if self._contains_scene_or_constraint(performer) or self._contains_scene_or_constraint(work):
            return None
        if re.search(r"[听放播来点给要想能不能可以]", performer) or re.search(r"[听放播来点给要想能不能可以]", work):
            return None
        return performer, work

    def _extract_scene_direction(self, text: str, context_pack: dict) -> dict | None:
        clean = str(text or "").strip()
        if not clean or not self._starts_with_request_marker(clean):
            return None
        if not self._contains_scene_or_constraint(clean):
            return None

        labels = []
        constraints = []
        if any(token in clean for token in ("晚上", "夜晚", "深夜", "睡前")):
            labels.append("晚上听")
        if any(token in clean.lower() for token in ("night", "late night", "bedtime")):
            labels.append("晚上听")
        if any(token in clean for token in ("下午", "午后")):
            labels.append("下午听")
        if any(token in clean.lower() for token in ("afternoon",)):
            labels.append("下午听")
        if any(token in clean.lower() for token in ("rnb", "r&b")):
            labels.append("R&B")
        if any(token in clean.lower() for token in ("jazz", "爵士")):
            labels.append("爵士")
        if any(token in clean.lower() for token in ("trip hop", "triphop")):
            labels.append("trip hop")
        if any(token in clean for token in ("别这么炸", "不要这么炸", "别太炸", "别炸", "不炸")):
            constraints.append("安静一点")
        if any(token in clean for token in ("安静", "轻一点", "柔一点", "慢一点", "放松")):
            constraints.append("安静放松")
        if any(token in clean for token in ("困", "累", "睡前")):
            constraints.append("低刺激")
        if any(token in clean.lower() for token in ("low-key", "low key", "not too loud", "quiet", "mellow", "soft")):
            constraints.append("低刺激")

        label = "、".join(self._dedupe(labels + constraints)) or "当前氛围"
        search_goals = self._scene_track_search_goals(
            {
                "type": "scene_genre_direction",
                "primary_entities": [{"role": "scene", "name": label}],
                "style_hint": " ".join(self._dedupe([clean, label] + constraints)),
                "search_goals": [],
            },
            [],
        )
        return {"label": label, "search_goals": search_goals, "constraints": self._dedupe(constraints)}

    def _contains_scene_or_constraint(self, text: str) -> bool:
        lowered = str(text or "").lower()
        tokens = (
            "晚上",
            "夜晚",
            "深夜",
            "睡前",
            "下午",
            "午后",
            "氛围",
            "风格",
            "心情",
            "场景",
            "安静",
            "放松",
            "轻一点",
            "柔一点",
            "慢一点",
            "别这么炸",
            "不要这么炸",
            "别太炸",
            "别炸",
            "不炸",
            "困",
            "累",
            "rnb",
            "r&b",
            "jazz",
            "爵士",
            "trip hop",
            "triphop",
            "night",
            "late night",
            "bedtime",
            "afternoon",
            "low-key",
            "low key",
            "not too loud",
            "quiet",
            "mellow",
            "soft",
        )
        return any(token in lowered for token in tokens)

    def _dedupe(self, values: list[str]) -> list[str]:
        result = []
        for value in values:
            item = str(value or "").strip()
            if item and item not in result:
                result.append(item)
        return result

    def _strip_accidental_latin_prefix(self, text: str) -> str:
        match = re.match(r"^[A-Za-z]\s*(?=[\u4e00-\u9fff])", text)
        if not match:
            return text
        candidate = text[match.end():].strip()
        if not self._starts_with_request_marker(candidate):
            return text
        return candidate

    def _starts_with_request_marker(self, text: str) -> bool:
        value = str(text or "")
        lowered = value.lower().strip()
        return value.startswith(
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
        ) or lowered.startswith(
            (
                "play",
                "put on",
                "give me",
                "can you",
                "could you",
                "would you",
                "please",
                "i want",
                "i'd like",
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
        task_type = str(source.get("type") or "")
        search_goals = self._normalize_search_goals(source.get("search_goals"))
        if task_type == "scene_genre_direction":
            search_goals = self._scene_track_search_goals(source, search_goals)
        return {
            "type": task_type,
            "primary_entities": self._normalize_primary_entities(source.get("primary_entities")),
            "work_hint": str(source.get("work_hint") or ""),
            "style_hint": str(source.get("style_hint") or ""),
            "search_goals": search_goals,
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

    def _scene_track_search_goals(self, source: dict, goals: list[str]) -> list[str]:
        text = self._scene_task_text(source, goals)
        concrete = [goal for goal in goals if not self._looks_like_scene_bucket_query(goal)]
        seeds = []
        lowered = text.lower()
        if "rnb" in lowered or "r&b" in lowered:
            seeds.extend(["SZA Good Days", "Daniel Caesar Best Part", "H.E.R. Focus"])
        if "trip hop" in lowered or "triphop" in lowered:
            seeds.extend(["Portishead Roads", "Massive Attack Teardrop", "Morcheeba The Sea"])
        if any(token in text for token in ("晚上", "夜晚", "深夜", "睡前", "安静", "舒缓", "放松", "非炸", "不炸", "别这么炸")):
            seeds.extend([
                "Joji Slow Dancing in the Dark",
                "Cigarettes After Sex Apocalypse",
                "Frank Ocean Pink + White",
                "Sufjan Stevens Mystery of Love",
            ])
        if any(token in text for token in ("下午", "午后")) and not seeds:
            seeds.extend(["SZA Good Days", "Raveena Honey", "Daniel Caesar Japanese Denim"])
        if seeds:
            concrete = [
                goal for goal in concrete
                if not self._looks_like_scene_descriptor_query(goal)
            ]
        return self._dedupe(concrete + seeds)[:8]

    def _scene_task_text(self, source: dict, goals: list[str]) -> str:
        parts = [str(source.get("style_hint") or ""), str(source.get("work_hint") or "")]
        parts.extend(goals)
        for entity in source.get("primary_entities") or []:
            if isinstance(entity, dict):
                parts.extend(str(value) for value in entity.values())
        return " ".join(parts)

    def _looks_like_scene_bucket_query(self, query: str) -> bool:
        text = str(query or "").strip().lower()
        if not text:
            return True
        bucket_tokens = ("歌单", "歌曲", "音乐", "playlist", "mix", "合集", "助眠", "白噪", "学习")
        scene_tokens = ("晚上", "夜晚", "深夜", "睡前", "安静", "舒缓", "放松", "氛围", "mellow", "chill")
        has_bucket = any(token in text for token in bucket_tokens)
        has_scene = any(token in text for token in scene_tokens)
        has_specific_artistish = bool(re.search(r"[A-Za-z].+\s+[A-Za-z]", text)) and not has_bucket
        return has_bucket and has_scene and not has_specific_artistish

    def _looks_like_scene_descriptor_query(self, query: str) -> bool:
        text = str(query or "").strip().lower()
        if not text:
            return True
        scene_tokens = ("晚上", "夜晚", "深夜", "睡前", "安静", "舒缓", "放松", "氛围", "mellow", "chill", "不炸")
        token_count = len(re.findall(r"[A-Za-z0-9+&]+|[\u4e00-\u9fff]{1,4}", text))
        has_scene = sum(1 for token in scene_tokens if token in text) >= 2
        has_specific_ascii = bool(re.search(r"[A-Za-z][A-Za-z0-9'.+&-]*\s+[A-Za-z][A-Za-z0-9'.+&-]*", text))
        return has_scene and token_count <= 8 and not has_specific_ascii

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
