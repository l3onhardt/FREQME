from __future__ import annotations

from dataclasses import asdict, dataclass, field
import re


@dataclass
class TasteModel:
    preferred_languages: list[str] = field(default_factory=list)
    avoided_languages: list[str] = field(default_factory=list)
    preferred_styles: list[str] = field(default_factory=list)
    avoided_styles: list[str] = field(default_factory=list)
    comfort_tracks: list[dict] = field(default_factory=list)
    discovery_tracks: list[dict] = field(default_factory=list)
    discovery_directions: list[str] = field(default_factory=list)
    skipped_track_ids: list[str] = field(default_factory=list)
    energy_preference: str = ""
    summary: str = ""
    confidence: float = 0.5

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class ListeningDecision:
    intent_type: str
    raw_text: str
    candidate_strategy: str = "profile_first"
    allow_search: bool = False
    search_raw_text: bool = False
    avoid_languages: list[str] = field(default_factory=list)
    avoid_styles: list[str] = field(default_factory=list)
    prefer_languages: list[str] = field(default_factory=list)
    prefer_styles: list[str] = field(default_factory=list)
    prefer_artists: list[str] = field(default_factory=list)
    semantic_queries: list[str] = field(default_factory=list)
    energy: str = ""
    use_case: str = ""
    duration_tracks: int = 4
    ack_text: str = ""
    search_text: str = ""

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class ContextSnapshot:
    timezone_name: str = ""
    region_hint: str = ""
    weather_hint: str = ""
    current_mode: str = ""
    local_time_block: str = ""

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class SessionTasteState:
    active_decision: dict = field(default_factory=dict)
    avoid_languages: list[str] = field(default_factory=list)
    avoid_styles: list[str] = field(default_factory=list)
    remaining_tracks: int = 0

    def apply_decision(self, decision: ListeningDecision) -> None:
        self.active_decision = decision.to_dict()
        self.avoid_languages = list(decision.avoid_languages)
        self.avoid_styles = list(decision.avoid_styles)
        self.remaining_tracks = max(0, int(decision.duration_tracks or 0))

    def to_dict(self) -> dict:
        return asdict(self)


class RadioBrain:
    def interpret_user_text(
        self,
        text: str,
        profile: dict | None = None,
        user_settings: dict | None = None,
    ) -> ListeningDecision:
        clean_text = " ".join(str(text or "").split())[:120]
        if not clean_text:
            return ListeningDecision(intent_type="empty", raw_text="")

        if self._is_result_rejection(clean_text):
            return ListeningDecision(
                intent_type="negative_feedback",
                raw_text=clean_text,
                candidate_strategy="profile_first",
                allow_search=False,
                duration_tracks=4,
                ack_text="懂了，不是这些。我先把这批结果避开，重新按你的歌单和最近听感找。",
            )

        if self._is_negative_feedback(clean_text):
            avoid_languages = self._avoid_languages_from_text(clean_text)
            avoid_styles = self._avoid_styles_from_text(clean_text)
            if avoid_languages and "华语流行" not in avoid_styles:
                avoid_styles.append("华语流行")
            ack = self._negative_ack(clean_text, avoid_languages, avoid_styles)
            return ListeningDecision(
                intent_type="negative_feedback",
                raw_text=clean_text,
                candidate_strategy="profile_first",
                allow_search=False,
                avoid_languages=avoid_languages,
                avoid_styles=avoid_styles,
                duration_tracks=5,
                ack_text=ack,
            )

        if self._is_object_correction(clean_text):
            return ListeningDecision(
                intent_type="specific_song",
                raw_text=clean_text,
                candidate_strategy="specific_search",
                allow_search=True,
                search_raw_text=True,
                duration_tracks=0,
                search_text=clean_text,
                ack_text="我先按你纠正的作品或人名确认版本，不按泛风格乱接。",
            )

        artist_target = self._artist_direction_target(clean_text)
        if artist_target:
            return ListeningDecision(
                intent_type="artist_direction",
                raw_text=clean_text,
                candidate_strategy="profile_first",
                allow_search=True,
                search_raw_text=False,
                prefer_artists=[artist_target],
                semantic_queries=[artist_target],
                duration_tracks=4,
                ack_text=(
                    f"收到，我按 {artist_target} 这条线接。"
                    "我会先结合你的歌单和最近听感挑具体歌，不直接乱塞搜索结果。"
                ),
            )

        if self._looks_like_english_artist_fragment(clean_text):
            artist_target = self._display_artist_name(clean_text)
            return ListeningDecision(
                intent_type="artist_direction",
                raw_text=clean_text,
                candidate_strategy="profile_first",
                allow_search=True,
                search_raw_text=False,
                prefer_artists=[artist_target],
                semantic_queries=[],
                duration_tracks=4,
                ack_text=(
                    "收到，我按你给的艺人/乐队线索自己校正，"
                    "再结合你的歌单和最近听感挑具体歌，不让你重新组织语言。"
                ),
            )

        if self._looks_like_bare_music_object(clean_text):
            return ListeningDecision(
                intent_type="specific_song",
                raw_text=clean_text,
                candidate_strategy="specific_search",
                allow_search=True,
                search_raw_text=True,
                duration_tracks=0,
                search_text=clean_text,
                ack_text="我先按具体歌名、作品或人名确认版本。",
            )

        if self._looks_like_specific_song_request(clean_text):
            return ListeningDecision(
                intent_type="specific_song",
                raw_text=clean_text,
                candidate_strategy="specific_search",
                allow_search=True,
                search_raw_text=True,
                duration_tracks=0,
                search_text=clean_text,
            )

        prefer_styles = self._prefer_styles_from_text(clean_text)
        energy = self._energy_from_text(clean_text, prefer_styles)
        use_case = self._use_case_from_text(clean_text, prefer_styles, energy)
        semantic_queries = self._semantic_queries_from_plan(
            clean_text,
            prefer_styles,
            energy,
            use_case,
            self.context_from_settings(user_settings),
        )
        return ListeningDecision(
            intent_type="taste_direction",
            raw_text=clean_text,
            candidate_strategy="profile_first",
            allow_search=False,
            search_raw_text=False,
            prefer_styles=prefer_styles,
            semantic_queries=semantic_queries,
            energy=energy,
            use_case=use_case,
            duration_tracks=4,
            ack_text=self._taste_direction_ack(clean_text, prefer_styles, energy, use_case),
        )

    def distill_taste(self, profile: dict | None) -> TasteModel:
        if not isinstance(profile, dict):
            return TasteModel()

        music_dna = profile.get("music_dna") if isinstance(profile.get("music_dna"), dict) else {}
        language_bias = (
            music_dna.get("language_bias")
            if isinstance(music_dna.get("language_bias"), dict)
            else {}
        )
        genres = music_dna.get("genres") if isinstance(music_dna.get("genres"), dict) else {}
        insights = (
            profile.get("radio_insights")
            if isinstance(profile.get("radio_insights"), dict)
            else {}
        )
        summary = str(insights.get("taste_summary") or "").strip()
        discovery_directions = self._string_list(insights.get("discovery_direction"))
        avoided_styles = []
        for item in [summary, *discovery_directions, *self._string_list(insights.get("comfort_zone"))]:
            if any(token in item for token in ("不要", "避开", "不喜欢", "口水", "热门华语")):
                avoided_styles.append(item)
        learned = self._learned_preferences(profile)

        return TasteModel(
            preferred_languages=[
                lang for lang, weight in language_bias.items()
                if self._number(weight) >= 0.35
            ],
            avoided_languages=self._dedupe(self._string_list(learned.get("avoid_languages"))),
            preferred_styles=[
                style for style, weight in genres.items()
                if self._number(weight) >= 0.35
            ],
            avoided_styles=self._dedupe(
                [*avoided_styles, *self._string_list(learned.get("avoid_styles"))]
            ),
            comfort_tracks=self._profile_tracks(profile.get("anchor_tracks")),
            discovery_tracks=self._profile_tracks(profile.get("recent_tracks")),
            discovery_directions=discovery_directions,
            skipped_track_ids=self._dedupe(
                self._string_list(learned.get("skipped_track_ids"))
            ),
            energy_preference=str(music_dna.get("energy_level") or ""),
            summary=summary,
            confidence=0.75 if profile else 0.2,
        )

    def context_from_settings(self, user_settings: dict | None) -> ContextSnapshot:
        if not isinstance(user_settings, dict):
            return ContextSnapshot()
        return ContextSnapshot(
            timezone_name=str(user_settings.get("timezone_name") or ""),
            region_hint=str(user_settings.get("region_hint") or ""),
            weather_hint=str(
                user_settings.get("weather_hint")
                or user_settings.get("weather")
                or ""
            ),
            current_mode=str(user_settings.get("current_mode") or ""),
            local_time_block=str(user_settings.get("local_time_block") or ""),
        )

    def apply_learning_signal(self, profile: dict | None, signal: dict | None) -> dict:
        updated = dict(profile) if isinstance(profile, dict) else {}
        if not isinstance(signal, dict):
            return updated

        brain_state = dict(updated.get("radio_brain") or {})
        learned = dict(brain_state.get("learned_preferences") or {})
        event_type = str(signal.get("event_type") or "").strip()

        if event_type in {"negative_feedback", "profile_correction"}:
            decision = signal.get("decision") if isinstance(signal.get("decision"), dict) else {}
            learned["avoid_languages"] = self._dedupe(
                [
                    *self._string_list(learned.get("avoid_languages")),
                    *self._string_list(decision.get("avoid_languages")),
                ]
            )
            learned["avoid_styles"] = self._dedupe(
                [
                    *self._string_list(learned.get("avoid_styles")),
                    *self._string_list(decision.get("avoid_styles")),
                ]
            )
            learned["negative_feedback_count"] = int(
                self._number(learned.get("negative_feedback_count"))
            ) + 1
            learned["last_feedback"] = str(decision.get("raw_text") or signal.get("raw_text") or "")

        if event_type == "skipped":
            learned["skip_count"] = int(self._number(learned.get("skip_count"))) + 1
            song = signal.get("song") if isinstance(signal.get("song"), dict) else {}
            song_id = str(song.get("id") or signal.get("song_id") or "").strip()
            if song_id:
                skipped = self._string_list(learned.get("skipped_track_ids"))
                learned["skipped_track_ids"] = self._dedupe([song_id, *skipped])[:20]

        brain_state["learned_preferences"] = learned
        updated["radio_brain"] = brain_state
        return updated

    def rank_candidates(
        self,
        candidates: list[dict],
        taste: TasteModel | dict | None,
        decision: ListeningDecision | dict | None,
    ) -> list[dict]:
        candidate_list = [candidate for candidate in candidates or [] if isinstance(candidate, dict)]
        if not candidate_list:
            return []

        taste_model = taste if isinstance(taste, TasteModel) else TasteModel(**taste) if isinstance(taste, dict) else TasteModel()
        listening_decision = (
            decision
            if isinstance(decision, ListeningDecision)
            else ListeningDecision(**decision)
            if isinstance(decision, dict)
            else ListeningDecision(intent_type="taste_direction", raw_text="")
        )
        if not listening_decision.avoid_languages and taste_model.avoided_languages:
            listening_decision.avoid_languages = list(taste_model.avoided_languages)
        if not listening_decision.avoid_styles and taste_model.avoided_styles:
            listening_decision.avoid_styles = list(taste_model.avoided_styles)
        scored = [
            (self._candidate_score(candidate, taste_model, listening_decision), index, candidate)
            for index, candidate in enumerate(candidate_list)
        ]
        allowed = [item for item in scored if item[0] > -1000]
        if not allowed:
            allowed = scored
        allowed.sort(key=lambda item: (-item[0], item[1]))
        return [candidate for _, _, candidate in allowed]

    def profile_candidates(self, profile: dict | None) -> list[dict]:
        taste = self.distill_taste(profile)
        candidates = []
        for source, tracks in (
            ("profile_anchor", taste.comfort_tracks),
            ("profile_recent", taste.discovery_tracks),
        ):
            for track in tracks:
                song = self._track_to_song(track, source)
                if song:
                    candidates.append(song)
        return candidates

    def _candidate_score(
        self,
        candidate: dict,
        taste: TasteModel,
        decision: ListeningDecision,
    ) -> float:
        language = self._candidate_language(candidate)
        style_text = self._candidate_style_text(candidate)
        if language and language in decision.avoid_languages:
            return -2000
        if any(style and style in style_text for style in decision.avoid_styles):
            return -1800

        score = 0.0
        if str(candidate.get("id") or "").strip() in taste.skipped_track_ids:
            score -= 20
        source = str(candidate.get("source") or "")
        if source in {"playlist", "recent", "profile_anchor", "profile_recent"}:
            score += 8
        if language and language in taste.preferred_languages:
            score += 4
        if any(style and style.lower() in style_text.lower() for style in taste.preferred_styles):
            score += 3
        if language and language in decision.prefer_languages:
            score += 5
        if any(style and style in style_text for style in decision.prefer_styles):
            score += 5
        return score

    def _is_negative_feedback(self, text: str) -> bool:
        lowered = text.lower()
        negative_markers = (
            "不要",
            "别放",
            "不想听",
            "受不了",
            "听腻",
            "太流行",
            "太口水",
            "口水歌",
            "换一个",
            "换首",
        )
        return any(marker in lowered or marker in text for marker in negative_markers)

    def _is_result_rejection(self, text: str) -> bool:
        compact = re.sub(r"[\s，,。.!！?？、]+", "", str(text or ""))
        if not compact:
            return False
        rejection_markers = (
            "不是",
            "不对",
            "不是这些",
            "不是这类",
            "不是这种",
            "不听这个",
            "不想听这个",
            "这不是",
            "这些不对",
        )
        if compact in {"不是", "不对", "不是不是这些", "不是这些", "不是这个", "不是这种"}:
            return True
        return any(marker in compact for marker in rejection_markers) and not any(
            marker in compact
            for marker in ("我说的是", "说的是", "应该是")
        )

    def _avoid_languages_from_text(self, text: str) -> list[str]:
        languages = []
        if any(token in text for token in ("中文", "华语", "国语", "普通话")):
            languages.append("中文")
        if "英文" in text:
            languages.append("英文")
        if "日文" in text:
            languages.append("日文")
        return languages

    def _avoid_styles_from_text(self, text: str) -> list[str]:
        styles = []
        if any(token in text for token in ("中文", "华语", "国语", "普通话")):
            styles.extend(["华语流行", "热门流行", "口水歌"])
        if any(token in text for token in ("口水", "流行到想吐", "太流行", "烂大街")):
            styles.extend(["热门流行", "口水歌"])
        return self._dedupe(styles)

    def _prefer_styles_from_text(self, text: str) -> list[str]:
        lowered = text.lower()
        styles = []
        if any(token in lowered for token in ("rnb", "r&b", "r＆b", "rhythm and blues")):
            styles.append("R&B")
        if any(token in lowered for token in ("edm", "electronic dance music")):
            styles.append("EDM")
            styles.append("电子")
        if any(token in text for token in ("电音", "电子乐", "电子音乐", "蹦迪", "炸场")):
            styles.append("电子")
            styles.append("EDM")
        if any(token in text for token in ("舞曲", "浩室", "house", "techno")):
            styles.append("舞曲")
        if any(token in text for token in ("下午", "午后")):
            styles.append("下午")
        if any(token in text for token in ("半夜", "凌晨", "深夜", "夜里", "夜晚")):
            styles.append("深夜")
        if any(token in text for token in ("丝滑", "松弛", "慵懒")):
            styles.append("松弛")
        for token in (
            "古典",
            "摇滚",
            "爵士",
            "电子",
            "民谣",
            "后摇",
            "emo",
            "安静",
            "放空",
            "深夜",
        ):
            if token in text:
                styles.append(token)
        return self._dedupe(styles)

    def _energy_from_text(self, text: str, prefer_styles: list[str]) -> str:
        if any(token in text for token in ("炸场", "蹦迪", "嗨", "燃", "高能", "提神")):
            return "high"
        if any(token in text for token in ("睡前", "安静", "放空", "低落", "松弛", "半夜", "凌晨", "深夜")):
            return "low"
        if any(style in prefer_styles for style in ("R&B", "下午", "舞曲", "电子", "EDM")):
            return "medium"
        return ""

    def _use_case_from_text(
        self,
        text: str,
        prefer_styles: list[str],
        energy: str,
    ) -> str:
        if energy == "high" and any(style in prefer_styles for style in ("电子", "EDM", "舞曲")):
            return "lift_energy"
        if "下午" in prefer_styles:
            return "afternoon_flow"
        if "emo" in prefer_styles and "深夜" in prefer_styles:
            return "late_night_emo"
        if any(token in text for token in ("开车", "路上", "夜路")):
            return "drive"
        if any(token in text for token in ("工作", "学习", "写代码")):
            return "focus"
        return ""

    def _semantic_queries_from_plan(
        self,
        text: str,
        prefer_styles: list[str],
        energy: str,
        use_case: str,
        context: ContextSnapshot,
    ) -> list[str]:
        queries = []
        if any(style in prefer_styles for style in ("电子", "EDM", "舞曲")):
            if energy == "high" or use_case == "lift_energy":
                queries.extend(["电子 舞曲 高能", "EDM house electronic", "高能 电音"])
            else:
                queries.extend(["电子 音乐", "EDM electronic", "电子 舞曲"])
        if "R&B" in prefer_styles:
            if "下午" in prefer_styles or context.local_time_block == "afternoon":
                queries.extend(["R&B 午后 松弛", "smooth R&B groove"])
            else:
                queries.extend(["R&B groove", "smooth R&B"])
        if "emo" in prefer_styles:
            if "深夜" in prefer_styles or context.local_time_block in {"night", "late_night"}:
                queries.extend(["emo 深夜", "sad indie emo night", "midwest emo"])
            else:
                queries.extend(["emo 伤感", "indie emo"])
        if "下午" in prefer_styles and "R&B" not in prefer_styles:
            queries.append("午后 松弛")
        if "放空" in prefer_styles:
            queries.append("放空 安静")
        if "深夜" in prefer_styles:
            queries.append("深夜 氛围")
        return self._dedupe(queries)

    def _taste_direction_ack(
        self,
        text: str,
        prefer_styles: list[str],
        energy: str = "",
        use_case: str = "",
    ) -> str:
        if use_case == "lift_energy" and any(style in prefer_styles for style in ("电子", "EDM", "舞曲")):
            return "收到，我把能量抬起来，往高能电子和舞曲方向接，但会按你的口味避开太土太吵的。"
        if use_case == "late_night_emo":
            return "收到，半夜这段我往低能量 emo 接，别太炸，情绪要准一点。"
        if "R&B" in prefer_styles and "下午" in prefer_styles:
            return "收到，下午这段我往松弛一点的 R&B 走，别太炸， groove 稳一点。"
        if "R&B" in prefer_styles:
            return "收到，我往 R&B 这条线接，选顺一点、有律动但不吵的。"
        if "下午" in prefer_styles:
            return "收到，下午这段我把节奏放松一点，找不抢注意力但有光泽的歌。"
        return f"好，我从你的歌单和最近听感里往“{text}”这个方向接。"

    def _negative_ack(
        self,
        text: str,
        avoid_languages: list[str],
        avoid_styles: list[str],
    ) -> str:
        if avoid_languages:
            lang_text = "、".join(avoid_languages)
            return f"懂了，这批{lang_text}方向先避开。我从你的歌单和最近听感里往没那么口水、更贴近你的方向接。"
        if avoid_styles:
            style_text = "、".join(avoid_styles[:2])
            return f"懂了，{style_text}这个方向先避开。我从你的歌单和最近听感里换一条更贴近你的线。"
        return "懂了，这个方向先避开。我从你的歌单和最近听感里换一条更贴近你的线。"

    def _is_object_correction(self, text: str) -> bool:
        if not any(marker in text for marker in ("我说的是", "说的是", "不是这个", "不是这首", "应该是", "是")):
            return False
        if any(marker in text for marker in ("这种", "这类", "风格", "感觉", "氛围", "情绪")):
            return False
        target = text
        for marker in ("我说的是", "说的是", "不是这个", "不是这首", "应该是"):
            if marker in target:
                target = target.rsplit(marker, 1)[-1]
        target = target.strip(" ，,。.!！?？")
        return 2 <= len(target) <= 40 and any(ch.isalnum() or "\u4e00" <= ch <= "\u9fff" for ch in target)

    def _looks_like_bare_music_object(self, text: str) -> bool:
        raw = str(text or "").strip(" ，,。.!！?？")
        if not raw:
            return False
        lowered = raw.lower()
        if any(marker in raw for marker in ("来点", "放点", "想听", "我想听", "播放", "点一首")):
            return False
        if self._looks_like_style_direction_target(raw):
            return False
        if any(token in lowered or token in raw for token in ("下午", "午后", "炸场", "电音", "rnb", "r&b", "edm", "emo")):
            return False
        if len(raw) > 28:
            return False
        return bool(re.search(r"[A-Za-z\u4e00-\u9fff]{2,}", raw))

    def _artist_direction_target(self, text: str) -> str:
        raw = str(text or "").strip(" ，,。.!！?？")
        if not raw:
            return ""
        target = raw
        for marker in ("我想听", "想听", "播放", "点一首", "点歌", "放点", "来点", "整点", "给我来点"):
            if marker in target:
                target = target.rsplit(marker, 1)[-1].strip()
                break
        target = target.strip(" ，,。.!！?？")
        match = re.match(
            r"^(?P<artist>[A-Za-z0-9\u4e00-\u9fff][A-Za-z0-9\u4e00-\u9fff '&./\-·]{1,48}?)\s*"
            r"(?:的(?:歌|音乐|曲子|作品)?|那种|这种|那类|这类)$",
            target,
            flags=re.IGNORECASE,
        )
        if not match:
            return ""
        artist = " ".join(match.group("artist").split()).strip(" 的")
        if not artist:
            return ""
        lowered = artist.lower()
        if artist in {"中文", "华语", "国语", "英文", "日文", "韩文", "粤语", "歌", "音乐"}:
            return ""
        if lowered in {"rnb", "r&b", "edm", "emo"}:
            return ""
        if self._looks_like_style_direction_target(artist):
            return ""
        if len(artist) > 40:
            return ""
        if not any(ch.isalnum() or "\u4e00" <= ch <= "\u9fff" for ch in artist):
            return ""
        return self._display_artist_name(artist)

    def _looks_like_english_artist_fragment(self, text: str) -> bool:
        raw = str(text or "").strip(" ，,。.!！?？")
        if not raw or not raw.isascii():
            return False
        lowered = raw.lower()
        if self._looks_like_style_direction_target(raw):
            return False
        if any(marker in lowered for marker in ("play ", "listen ", "song", "album", " by ")):
            return False
        if any(char.isdigit() for char in raw):
            return False
        words = [word for word in re.split(r"[\s/&+.-]+", raw) if word]
        if not 2 <= len(words) <= 4:
            return False
        if not all(2 <= len(word) <= 18 and word.isalpha() for word in words):
            return False
        title_case_words = sum(1 for word in words if word[:1].isupper())
        all_lower = all(word.islower() for word in words)
        return all_lower or title_case_words >= 2

    def _display_artist_name(self, artist: str) -> str:
        cleaned = " ".join(str(artist or "").split())
        if not cleaned or not cleaned.isascii():
            return cleaned
        if not any(ch.islower() for ch in cleaned):
            return cleaned
        return " ".join(
            part[:1].upper() + part[1:]
            if part and not part.isupper()
            else part
            for part in cleaned.split(" ")
        )

    def _looks_like_specific_song_request(self, text: str) -> bool:
        raw = str(text or "").strip()
        if not raw:
            return False
        target = raw
        explicit = False
        for marker in ("我想听", "想听", "播放", "点一首", "点歌", "放点", "来点"):
            if marker in target:
                target = target.rsplit(marker, 1)[-1].strip()
                explicit = True
        target = target.strip(" ，,。.!！?？")
        if explicit and self._looks_like_style_direction_target(target):
            return False
        if any(marker in raw for marker in ("《", "》", "专辑", "版本", " by ")):
            return True
        if not explicit and self._looks_like_english_artist_fragment(raw):
            return False
        if explicit and "的歌" not in target and "的音乐" not in target:
            return 1 <= len(target) <= 18 and any(ch.isalnum() for ch in target)
        return bool(re.search(r"[A-Za-z].*\s+[-A-Za-z0-9'. ]{2,}", raw))

    def _looks_like_style_direction_target(self, target: str) -> bool:
        lowered = target.lower()
        if not target:
            return False
        if target.startswith(("点", "些", "一点", "一些")):
            return True
        if any(
            phrase in target
            for phrase in (
                "的歌",
                "的音乐",
                "的曲子",
                "这类歌",
                "这种歌",
                "这类音乐",
                "这种音乐",
                "歌单",
            )
        ):
            return True
        return any(
            token in lowered or token in target
            for token in (
                "rnb",
                "r&b",
                "edm",
                "电音",
                "电子",
                "电子乐",
                "电子音乐",
                "炸场",
                "蹦迪",
                "下午",
                "午后",
                "松弛",
                "放空",
                "emo",
                "古典",
                "摇滚",
                "爵士",
                "民谣",
                "后摇",
            )
        )

    def _candidate_language(self, candidate: dict) -> str:
        explicit = str(candidate.get("language") or "").strip()
        if explicit:
            return explicit
        text = self._candidate_style_text(candidate)
        if re.search(r"[\u4e00-\u9fff]", text):
            return "中文"
        if re.search(r"[A-Za-z]", text):
            return "英文"
        return ""

    def _candidate_style_text(self, candidate: dict) -> str:
        artist = self._artist_name(candidate)
        album = candidate.get("al") or candidate.get("album") or ""
        if isinstance(album, dict):
            album = album.get("name") or ""
        reason = candidate.get("selection_reason") or {}
        reason_text = reason.get("text", "") if isinstance(reason, dict) else str(reason)
        return " ".join(
            str(value or "")
            for value in (
                candidate.get("name"),
                artist,
                album,
                candidate.get("source"),
                reason_text,
                candidate.get("language"),
            )
        )

    def _track_to_song(self, track: dict, source: str) -> dict | None:
        sid = str(track.get("id") or "").strip()
        if not sid:
            return None
        artist = str(track.get("artist") or "").strip()
        song = {
            "id": sid,
            "name": str(track.get("name") or track.get("song_name") or "").strip(),
            "artist": artist,
            "ar": [{"name": artist}] if artist else [],
            "source": source,
        }
        if track.get("language"):
            song["language"] = track.get("language")
        return song

    def _profile_tracks(self, value) -> list[dict]:
        return [item for item in value or [] if isinstance(item, dict)]

    def _learned_preferences(self, profile: dict) -> dict:
        brain_state = profile.get("radio_brain")
        if not isinstance(brain_state, dict):
            return {}
        learned = brain_state.get("learned_preferences")
        return learned if isinstance(learned, dict) else {}

    def _string_list(self, value) -> list[str]:
        if isinstance(value, list):
            return [str(item).strip() for item in value if str(item).strip()]
        if isinstance(value, str) and value.strip():
            return [value.strip()]
        return []

    def _artist_name(self, song: dict) -> str:
        artist = song.get("artist")
        if isinstance(artist, str) and artist.strip():
            return artist.strip()
        for key in ("ar", "artists"):
            artists = song.get(key)
            if isinstance(artists, list) and artists:
                names = [
                    str(item.get("name") or "").strip()
                    for item in artists
                    if isinstance(item, dict) and item.get("name")
                ]
                if names:
                    return " / ".join(names[:3])
        return ""

    def _number(self, value) -> float:
        try:
            return float(value)
        except Exception:
            return 0.0

    def _dedupe(self, values: list[str]) -> list[str]:
        result = []
        for value in values:
            if value and value not in result:
                result.append(value)
        return result
