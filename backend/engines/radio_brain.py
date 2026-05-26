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
    avoid_languages: list[str] = field(default_factory=list)
    avoid_styles: list[str] = field(default_factory=list)
    prefer_languages: list[str] = field(default_factory=list)
    prefer_styles: list[str] = field(default_factory=list)
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

        if self._looks_like_specific_song_request(clean_text):
            return ListeningDecision(
                intent_type="specific_song",
                raw_text=clean_text,
                candidate_strategy="specific_search",
                allow_search=True,
                duration_tracks=0,
                search_text=clean_text,
            )

        prefer_styles = self._prefer_styles_from_text(clean_text)
        return ListeningDecision(
            intent_type="taste_direction",
            raw_text=clean_text,
            candidate_strategy="profile_first",
            allow_search=False,
            prefer_styles=prefer_styles,
            duration_tracks=4,
            ack_text=f"好，我从你的歌单和最近听感里往“{clean_text}”这个方向接。",
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

        return TasteModel(
            preferred_languages=[
                lang for lang, weight in language_bias.items()
                if self._number(weight) >= 0.35
            ],
            preferred_styles=[
                style for style, weight in genres.items()
                if self._number(weight) >= 0.35
            ],
            avoided_styles=avoided_styles,
            comfort_tracks=self._profile_tracks(profile.get("anchor_tracks")),
            discovery_tracks=self._profile_tracks(profile.get("recent_tracks")),
            discovery_directions=discovery_directions,
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
        styles = []
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
        return styles

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

    def _looks_like_specific_song_request(self, text: str) -> bool:
        raw = str(text or "").strip()
        if not raw:
            return False
        target = raw
        explicit = False
        for marker in ("我想听", "想听", "播放", "点一首", "点歌"):
            if marker in target:
                target = target.rsplit(marker, 1)[-1].strip()
                explicit = True
        if any(marker in raw for marker in ("《", "》", "专辑", "版本", " by ")):
            return True
        if explicit and "的歌" not in target and "的音乐" not in target:
            return 1 <= len(target) <= 18 and any(ch.isalnum() for ch in target)
        return bool(re.search(r"[A-Za-z].*\s+[-A-Za-z0-9'. ]{2,}", raw))

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
