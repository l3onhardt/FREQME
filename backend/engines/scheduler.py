import random
import asyncio
import json
import re
from dataclasses import dataclass, field

from backend.adapters.netease import NeteaseAdapter
from backend.memory.store import MemoryStore
from backend.core.event_bus import EventBus
from backend.engines.radio_brain import RadioBrain


# 兜底歌单 — 网易云歌曲ID，无需登录即可播放
FALLBACK_PLAYLIST = [
    {"id": "186016", "name": "晴天", "ar": [{"name": "周杰伦"}]},
    {"id": "186001", "name": "夜曲", "ar": [{"name": "周杰伦"}]},
    {"id": "108236", "name": "七里香", "ar": [{"name": "周杰伦"}]},
    {"id": "191254", "name": "稻香", "ar": [{"name": "周杰伦"}]},
    {"id": "5252772", "name": "年少有为", "ar": [{"name": "李荣浩"}]},
    {"id": "36892407", "name": "戒烟", "ar": [{"name": "李荣浩"}]},
    {"id": "27867139", "name": "成都", "ar": [{"name": "赵雷"}]},
    {"id": "437856743", "name": "消愁", "ar": [{"name": "毛不易"}]},
    {"id": "523776350", "name": "像我这样的人", "ar": [{"name": "毛不易"}]},
    {"id": "26092806", "name": "平凡之路", "ar": [{"name": "朴树"}]},
    {"id": "385763", "name": "那些花儿", "ar": [{"name": "朴树"}]},
    {"id": "167921", "name": "南山南", "ar": [{"name": "马頔"}]},
    {"id": "29019263", "name": "追光者", "ar": [{"name": "岑宁儿"}]},
    {"id": "504686131", "name": "后来", "ar": [{"name": "刘若英"}]},
    {"id": "212902", "name": "好久不见", "ar": [{"name": "陈奕迅"}]},
    {"id": "28018139", "name": "浮夸", "ar": [{"name": "陈奕迅"}]},
    {"id": "186024", "name": "东风破", "ar": [{"name": "周杰伦"}]},
    {"id": "109198", "name": "搁浅", "ar": [{"name": "周杰伦"}]},
    {"id": "314213", "name": "泡沫", "ar": [{"name": "邓紫棋"}]},
    {"id": "280678", "name": "光年之外", "ar": [{"name": "邓紫棋"}]},
]


@dataclass
class SchedulerSessionState:
    played_song_ids: set[str] = field(default_factory=set)
    artist_names: list[str] = field(default_factory=list)
    pick_count: int = 0
    listening_intent: dict = field(default_factory=dict)
    intent_picks_remaining: int = 0


class StreamScheduler:
    def __init__(
        self,
        netease: NeteaseAdapter,
        store: MemoryStore,
        bus: EventBus,
        llm=None,
    ):
        self.netease = netease
        self.store = store
        self.bus = bus
        self.llm = llm
        self._fallback_queue: list[dict] = []
        self.radio_brain = RadioBrain()

    def _shuffle_fallback(self):
        self._fallback_queue = random.sample(FALLBACK_PLAYLIST, len(FALLBACK_PLAYLIST))

    def new_session_state(self) -> SchedulerSessionState:
        return SchedulerSessionState()

    def _pool_list(self, value) -> list[dict]:
        return value if isinstance(value, list) else []

    def _song_id(self, song: dict | None) -> str:
        if not isinstance(song, dict):
            return ""
        sid = song.get("id")
        return str(sid).strip() if sid is not None else ""

    def _artist_name(self, song: dict | None) -> str:
        if not isinstance(song, dict):
            return ""

        artist = song.get("artist")
        if isinstance(artist, str) and artist.strip():
            return artist.strip()

        for key in ("ar", "artists"):
            artists = song.get(key)
            if isinstance(artists, list) and artists:
                first = artists[0]
                if isinstance(first, dict):
                    name = first.get("name")
                    if isinstance(name, str):
                        return name.strip()
            elif isinstance(artists, dict):
                name = artists.get("name")
                if isinstance(name, str):
                    return name.strip()

        return ""

    def _profile_track_to_song(self, track: dict | None) -> dict | None:
        if not isinstance(track, dict):
            return None
        sid = self._song_id(track)
        if not sid:
            return None
        name = track.get("name") or track.get("song_name") or ""
        artist = self._artist_name(track)
        song = {
            "id": sid,
            "name": name,
            "ar": [{"name": artist}] if artist else [],
        }
        if track.get("source"):
            song["source"] = track.get("source")
        if track.get("language"):
            song["language"] = track.get("language")
        return song

    def _with_reason(self, song: dict, reason_type: str, text: str) -> dict:
        selected = dict(song)
        selected["selection_reason"] = {
            "type": reason_type,
            "text": text,
        }
        return selected

    def _remember_played(self, song: dict, state: SchedulerSessionState) -> None:
        sid = self._song_id(song)
        if sid:
            state.played_song_ids.add(sid)
        artist = self._artist_name(song)
        if artist:
            state.artist_names.append(artist)
            state.artist_names = state.artist_names[-12:]

    def _recent_artist_names(
        self,
        profile: dict | None = None,
        state: SchedulerSessionState | None = None,
    ) -> set[str]:
        artists = set((state.artist_names if state else [])[-6:])
        if isinstance(profile, dict):
            for track in self._pool_list(profile.get("recent_tracks"))[:10]:
                artist = self._artist_name(track)
                if artist:
                    artists.add(artist)
        return artists

    def _choose_candidate(
        self,
        songs: list[dict],
        recent_ids: set[str],
        recent_artists: set[str],
    ) -> dict | None:
        good_songs = [
            song for song in songs
            if isinstance(song, dict)
            and self._song_id(song)
            and self._song_id(song) not in recent_ids
        ]
        if not good_songs:
            return None

        for song in good_songs:
            artist = self._artist_name(song)
            if not artist or artist not in recent_artists:
                return song
        return good_songs[0]

    async def _choose_candidate_async(
        self,
        songs: list[dict],
        recent_ids: set[str],
        recent_artists: set[str],
        uid: str | None = None,
    ) -> dict | None:
        candidates = []
        for song in songs:
            sid = self._song_id(song)
            if not sid:
                continue
            try:
                failed = await self.store.was_track_recently_failed(sid, uid=uid)
            except Exception:
                failed = False
            if not failed:
                candidates.append(song)
        return self._choose_candidate(candidates, recent_ids, recent_artists)

    def _anchor_due(
        self,
        current_song_id: str | None,
        state: SchedulerSessionState,
    ) -> bool:
        return not current_song_id or state.pick_count % 4 == 0

    def apply_listening_intent(
        self,
        session_state: SchedulerSessionState,
        request_text: str,
        user_settings: dict | None = None,
    ) -> dict:
        clean_text = " ".join(str(request_text or "").strip().split())[:120]
        brain_decision = self._radio_brain_decision(user_settings)
        semantic_queries = self._radio_brain_search_queries(brain_decision)
        if brain_decision.get("intent_type") == "negative_feedback":
            keywords = ""
        elif semantic_queries:
            keywords = semantic_queries[0]
        elif brain_decision and not brain_decision.get("search_raw_text"):
            keywords = ""
        else:
            keywords = self._normalize_request_keywords(clean_text)
        intent = {
            "raw_text": clean_text,
            "keywords": keywords,
            "mood": "",
        }
        if session_state:
            session_state.listening_intent = intent
            session_state.intent_picks_remaining = 4
        if isinstance(user_settings, dict):
            user_settings["listening_intent"] = intent
        return intent

    def _normalize_request_keywords(self, text: str) -> str:
        raw = " ".join(str(text or "").strip().split())[:120]
        lowered = raw.lower()
        terms = []

        def add(term: str) -> None:
            if term and term not in terms:
                terms.append(term)

        if "emo" in lowered:
            add("emo")
            add("伤感")
        if any(token in raw for token in ("不开心", "难过", "低落", "emo", "伤心")):
            add("不开心")
        if any(token in raw for token in ("夜", "深夜", "夜路", "晚上")):
            add("夜晚")
        if any(token in raw for token in ("放空", "发呆", "安静")):
            add("放空")
        if any(token in raw for token in ("开车", "路上", "夜路")):
            add("开车")

        if terms:
            return " ".join(terms)[:120]
        if self._looks_like_specific_song_request(raw):
            return ""
        return raw

    def _looks_like_specific_song_request(self, text: str) -> bool:
        raw = str(text or "").strip()
        if not raw:
            return False
        request_markers = ("我想听", "想听", "放点", "来点", "播放", "点一首")
        specific_markers = ("的", "《", "》", "专辑", "版本")
        if any(marker in raw for marker in request_markers) and any(
            marker in raw for marker in specific_markers
        ):
            return True
        return bool(re.search(r"[A-Za-z].*\s+[-A-Za-z0-9'. ]{2,}", raw))

    def _intent_from_settings(
        self,
        user_settings: dict | None,
        state: SchedulerSessionState,
    ) -> dict:
        if state.listening_intent:
            return state.listening_intent
        if isinstance(user_settings, dict) and isinstance(
            user_settings.get("listening_intent"),
            dict,
        ):
            state.listening_intent = user_settings["listening_intent"]
            if state.intent_picks_remaining <= 0:
                state.intent_picks_remaining = 4
            return state.listening_intent
        return {}

    def _intent_keywords(self, intent: dict) -> str:
        if not isinstance(intent, dict):
            return ""
        keywords = intent.get("keywords") or intent.get("raw_text") or ""
        return self._normalize_request_keywords(str(keywords))

    def _intent_reason_text(self, intent: dict) -> str:
        raw_text = ""
        if isinstance(intent, dict):
            raw_text = str(intent.get("raw_text") or "").strip()
        if raw_text:
            return f"回应你刚刚说“{raw_text}”，先沿着这个方向找一首贴近的歌。"
        return "先沿着你刚刚点的方向找一首贴近的歌。"

    def _radio_brain_decision(self, user_settings: dict | None) -> dict:
        if not isinstance(user_settings, dict):
            return {}
        brain_state = user_settings.get("radio_brain")
        if not isinstance(brain_state, dict):
            return {}
        decision = brain_state.get("decision")
        return decision if isinstance(decision, dict) else {}

    def _profile_brain_candidates(self, profile: dict | None) -> list[dict]:
        if not isinstance(profile, dict):
            return []
        candidates = []
        for source_key, source in (
            ("anchor_tracks", "profile_anchor"),
            ("recent_tracks", "profile_recent"),
        ):
            for track in self._pool_list(profile.get(source_key)):
                song = self._profile_track_to_song(track)
                if not song:
                    continue
                song["source"] = source
                candidates.append(song)
        return candidates

    async def _choose_radio_brain_profile_candidate(
        self,
        profile: dict | None,
        decision: dict,
        recent_ids: set[str],
        recent_artists: set[str],
        uid: str | None = None,
    ) -> dict | None:
        if decision.get("candidate_strategy") != "profile_first":
            return None
        candidates = self._profile_brain_candidates(profile)
        if not candidates:
            return None
        taste = self.radio_brain.distill_taste(profile)
        ranked = self.radio_brain.rank_candidates(candidates, taste, decision)
        ranked = [
            candidate for candidate in ranked
            if self._candidate_satisfies_decision(candidate, decision)
        ]
        if not ranked:
            return None
        return await self._choose_candidate_async(ranked, recent_ids, recent_artists, uid=uid)

    def _radio_brain_reason_text(self, decision: dict) -> str:
        ack = str(decision.get("ack_text") or "").strip()
        if ack:
            return ack
        raw_text = str(decision.get("raw_text") or "").strip()
        if raw_text:
            return f"回应你刚刚说“{raw_text}”，先从你的歌单里换一条更贴近的线。"
        return "先按你的听感反馈，从你的歌单里换一条更贴近的线。"

    def _radio_brain_search_queries(self, decision: dict | None) -> list[str]:
        if not isinstance(decision, dict):
            return []
        queries = decision.get("semantic_queries")
        if isinstance(queries, list):
            cleaned = [
                str(query).strip()
                for query in queries
                if str(query or "").strip()
            ]
            if cleaned:
                return cleaned[:3]
        if decision.get("search_raw_text"):
            search_text = str(
                decision.get("search_text") or decision.get("raw_text") or ""
            ).strip()
            return [search_text] if search_text else []
        return []

    async def _infer_radio_brain_song_picks(
        self,
        profile: dict | None,
        user_settings: dict | None,
        decision: dict,
    ) -> list[dict]:
        if not self.llm or decision.get("intent_type") not in {
            "taste_direction",
            "artist_direction",
        }:
            return []
        artist_clause = ""
        preferred_artists = self._decision_preferred_artists(decision)
        if preferred_artists:
            artist_clause = (
                f"\n用户这次点的是艺人/乐队方向：{', '.join(preferred_artists)}。"
                "你必须优先从这些艺人/乐队自己的作品里构思具体歌曲；"
                "不要把乐队名本身当歌名，也不要给翻唱、合集、歌单或上传者结果。"
            )
        prompt = f"""用户对私人电台说：{decision.get("raw_text") or ""}
电台已经理解的音乐方向：{self._decision_brief(decision)}
{artist_clause}
用户画像：{self._profile_brief(profile)}
时间和场景：{self._settings_brief(user_settings)}

请像一个真的私人电台 DJ，先自己构思接下来适合播放的具体歌曲，而不是输出风格搜索词。
要求：
- 给 3 到 5 首具体歌曲，必须包含歌名和艺人；可以是英文歌、独立 R&B、电子、爵士等，只要贴合用户画像和此刻场景。
- 不要给冥想音频、白噪音、佛经、助眠频率、学习专注音频、歌单名或泛风格词。
- 搜索词必须像“艺人 歌名”，不要写“下午 R&B”“松弛歌单”“Chill 午后”这种风格词。
- 如果用户反感热门口水歌，要避开过度大众化的中文流行。

只返回 JSON，不要解释：
{{
  "picks": [
    {{"title": "歌名", "artist": "艺人", "query": "艺人 歌名", "reason": "为什么适合"}}
  ]
}}"""
        try:
            response = await asyncio.wait_for(
                self.llm.chat(
                    prompt,
                    max_tokens=360,
                    system="你是懂用户画像的私人电台选曲 planner。只输出 JSON。",
                ),
                timeout=5.0,
            )
            data = self._parse_json(response)
        except Exception:
            return []
        picks = data.get("picks") if isinstance(data, dict) else []
        if not isinstance(picks, list):
            return []
        result = []
        for pick in picks[:5]:
            if not isinstance(pick, dict):
                continue
            title = str(pick.get("title") or "").strip()
            artist = str(pick.get("artist") or "").strip()
            query = str(pick.get("query") or "").strip()
            if not query and (artist or title):
                query = f"{artist} {title}".strip()
            if not title or not artist or not query:
                continue
            if self._looks_like_utility_audio_text(query):
                continue
            if (
                decision.get("intent_type") == "artist_direction"
                and not self._artist_pick_plausibly_matches_decision(artist, decision)
            ):
                continue
            result.append({
                "title": title,
                "artist": artist,
                "query": query[:120],
                "reason": str(pick.get("reason") or "").strip(),
            })
        return result

    async def _choose_radio_brain_inferred_song_candidate(
        self,
        profile: dict | None,
        user_settings: dict | None,
        decision: dict,
        recent_ids: set[str],
        recent_artists: set[str],
        uid: str | None = None,
    ) -> dict | None:
        picks = await self._infer_radio_brain_song_picks(profile, user_settings, decision)
        if not picks:
            return None
        for pick in picks:
            try:
                candidates = await self.netease.search(pick["query"], limit=8)
            except Exception:
                candidates = []
            filtered = [
                candidate for candidate in self._pool_list(candidates)[:8]
                if self._candidate_matches_inferred_pick(candidate, pick)
                and not self._looks_like_utility_audio_candidate(candidate)
            ]
            song = await self._choose_candidate_async(
                filtered,
                recent_ids,
                recent_artists,
                uid=uid,
            )
            if song:
                selected = dict(song)
                selected["inferred_pick"] = pick
                return selected
        return None

    async def _choose_radio_brain_search_candidate(
        self,
        profile: dict | None,
        decision: dict,
        recent_ids: set[str],
        recent_artists: set[str],
        uid: str | None = None,
    ) -> dict | None:
        if decision.get("intent_type") not in {"taste_direction", "artist_direction"}:
            return None
        queries = self._radio_brain_search_queries(decision)
        if not queries:
            return None
        taste = self.radio_brain.distill_taste(profile)
        for query in queries:
            try:
                candidates = await self.netease.search(query, limit=8)
            except Exception:
                candidates = []
            candidates = [
                candidate for candidate in self._pool_list(candidates)[:8]
                if not self._looks_like_utility_audio_candidate(candidate)
            ]
            if decision.get("intent_type") == "artist_direction":
                candidates = [
                    candidate for candidate in candidates
                    if self._candidate_matches_preferred_artist(candidate, decision)
                ]
            ranked = self.radio_brain.rank_candidates(
                candidates,
                taste,
                decision,
            )
            song = await self._choose_candidate_async(
                ranked,
                recent_ids,
                recent_artists,
                uid=uid,
            )
            if song:
                return song
        return None

    def _radio_brain_inferred_reason_text(self, decision: dict, song: dict) -> str:
        pick = song.get("inferred_pick") if isinstance(song, dict) else {}
        if isinstance(pick, dict):
            title = str(pick.get("title") or "").strip()
            artist = str(pick.get("artist") or "").strip()
            if title and artist:
                return f"{self._radio_brain_reason_text(decision)} 我先按这个听感具体选 {artist} 的《{title}》。"
        return self._radio_brain_reason_text(decision)

    async def pick_next(
        self,
        current_song_id: str | None = None,
        profile: dict | None = None,
        user_settings: dict | None = None,
        session_state: SchedulerSessionState | None = None,
        uid: str | None = None,
    ) -> dict | None:
        state = session_state or self.new_session_state()
        try:
            recent_db = await self.store.get_recent_tracks(200, uid=uid)
        except Exception:
            recent_db = []
        if not isinstance(recent_db, list):
            recent_db = []
        recent = {str(song_id) for song_id in recent_db if song_id} | state.played_song_ids
        if current_song_id:
            recent.add(str(current_song_id))
        recent_artists = self._recent_artist_names(profile, state)

        def _select(song: dict, reason_type: str, text: str) -> dict:
            selected = self._with_reason(song, reason_type, text)
            self._remember_played(selected, state)
            state.pick_count += 1
            if reason_type == "request_intent" and state.intent_picks_remaining > 0:
                state.intent_picks_remaining -= 1
            return selected

        brain_decision = self._radio_brain_decision(user_settings)
        if brain_decision:
            song = await self._choose_radio_brain_profile_candidate(
                profile,
                brain_decision,
                recent,
                recent_artists,
                uid=uid,
            )
            if song:
                return _select(
                    song,
                    "radio_brain_profile",
                    self._radio_brain_reason_text(brain_decision),
                )
            song = await self._choose_radio_brain_inferred_song_candidate(
                profile,
                user_settings,
                brain_decision,
                recent,
                recent_artists,
                uid=uid,
            )
            if song:
                return _select(
                    song,
                    "radio_brain_inferred_song",
                    self._radio_brain_inferred_reason_text(brain_decision, song),
                )
            song = await self._choose_radio_brain_search_candidate(
                profile,
                brain_decision,
                recent,
                recent_artists,
                uid=uid,
            )
            if song:
                return _select(
                    song,
                    "radio_brain_search",
                    self._radio_brain_reason_text(brain_decision),
                )
            if brain_decision.get("intent_type") == "artist_direction":
                return None

        intent = {} if (
            brain_decision and not brain_decision.get("search_raw_text")
        ) else self._intent_from_settings(user_settings, state)
        intent_keywords = self._intent_keywords(intent)
        if intent_keywords and state.intent_picks_remaining > 0:
            try:
                request_candidates = await self.netease.search(intent_keywords, limit=8)
            except Exception:
                request_candidates = []
            song = await self._choose_candidate_async(
                self._pool_list(request_candidates)[:8],
                recent,
                recent_artists,
                uid=uid,
            )
            if song:
                return _select(
                    song,
                    "request_intent",
                    self._intent_reason_text(intent),
                )

        if self._anchor_due(current_song_id, state) and isinstance(profile, dict):
            anchors = [
                self._profile_track_to_song(track)
                for track in self._pool_list(profile.get("anchor_tracks"))
            ]
            anchor = await self._choose_candidate_async(
                [song for song in anchors if song],
                recent,
                recent_artists,
                uid=uid,
            )
            if anchor:
                name = anchor.get("name") or "这首熟悉的歌"
                return _select(
                    anchor,
                    "familiar_anchor",
                    f"{name} 是一首熟悉的锚点歌，适合先把电台拉回亲近的感觉。",
                )

        # 1. Similar songs based on current track
        if current_song_id:
            try:
                simi = await self.netease.simi_song(current_song_id)
            except Exception:
                simi = []
            song = await self._choose_candidate_async(
                self._pool_list(simi)[:8],
                recent,
                recent_artists,
                uid=uid,
            )
            if song:
                return _select(
                    song,
                    "discovery_similar",
                    "顺着上一首的气质往外走一步，带来一点新鲜感。",
                )

        # 2. NetEase daily recommendations (shuffle to avoid same first song)
        try:
            recommends = await self.netease.recommend_songs()
        except Exception:
            recommends = []
        recommends = self._pool_list(recommends)
        if recommends:
            random.shuffle(recommends)
            song = await self._choose_candidate_async(
                recommends[:15],
                recent,
                recent_artists,
                uid=uid,
            )
            if song:
                return _select(
                    song,
                    "daily_personal",
                    "来自今天的私人日推，和此刻的听感比较贴近。",
                )

        # 3. Personal FM
        try:
            fm = await self.netease.personal_fm()
        except Exception:
            fm = []
        song = await self._choose_candidate_async(
            self._pool_list(fm)[:10],
            recent,
            recent_artists,
            uid=uid,
        )
        if song:
            return _select(
                song,
                "personal_fm",
                "来自私人 FM，像是熟悉口味里的一个新转角。",
            )

        # 4. Fallback playlist (built-in, always available)
        if not self._fallback_queue:
            self._shuffle_fallback()

        song = await self._choose_candidate_async(
            self._fallback_queue,
            recent,
            recent_artists,
            uid=uid,
        )
        if song:
            self._fallback_queue.remove(song)
            return _select(
                song,
                "fallback",
                "个人歌池暂时安静，先用一首稳妥的歌把氛围接住。",
            )

        # 5. All fallback played, reshuffle and try again
        self._shuffle_fallback()
        song = await self._choose_candidate_async(
            self._fallback_queue,
            recent,
            recent_artists,
            uid=uid,
        )
        if song:
            self._fallback_queue.remove(song)
            return _select(
                song,
                "fallback",
                "个人歌池暂时安静，先用一首稳妥的歌把氛围接住。",
            )

        # 6. Last resort: clear session memory and return first fallback
        state.played_song_ids.clear()
        state.artist_names.clear()
        if self._fallback_queue:
            return _select(
                self._fallback_queue[0],
                "fallback",
                "个人歌池暂时安静，先用一首稳妥的歌把氛围接住。",
            )
        return (
            _select(
                FALLBACK_PLAYLIST[0],
                "fallback",
                "个人歌池暂时安静，先用一首稳妥的歌把氛围接住。",
            )
            if FALLBACK_PLAYLIST
            else None
        )

    async def get_song_url(self, song: dict) -> str:
        sid = str(song.get("id"))
        return await self.netease.song_url(sid)

    def _candidate_matches_inferred_pick(self, candidate: dict, pick: dict) -> bool:
        if not isinstance(candidate, dict) or not isinstance(pick, dict):
            return False
        name = self._normalize_match_text(candidate.get("name"))
        artist = self._normalize_match_text(self._artist_name(candidate))
        album = self._normalize_match_text(self._album_name(candidate))
        title = self._normalize_match_text(pick.get("title"))
        pick_artist = self._normalize_match_text(pick.get("artist"))
        if not name or not title:
            return False
        title_match = title in name or name in title or title in album
        artist_match = not pick_artist or pick_artist in artist or artist in pick_artist
        return title_match and artist_match

    def _candidate_satisfies_decision(self, candidate: dict, decision: dict | None) -> bool:
        if not isinstance(decision, dict):
            return True
        if decision.get("intent_type") == "artist_direction":
            return self._candidate_matches_preferred_artist(candidate, decision)
        preferred = [
            str(style).strip()
            for style in decision.get("prefer_styles") or []
            if str(style).strip()
        ]
        if not preferred:
            return True
        style_text = self._normalize_match_text(
            " ".join(
                str(value or "")
                for value in (
                    candidate.get("name"),
                    self._artist_name(candidate),
                    self._album_name(candidate),
                    candidate.get("source"),
                    candidate.get("language"),
                )
            )
        )
        if not style_text:
            return False
        aliases = {
            "深夜": ("night", "midnight", "late", "深夜", "半夜", "凌晨"),
            "下午": ("afternoon", "午后", "下午"),
            "电子": ("electronic", "edm", "电子", "电音"),
            "EDM": ("edm", "electronic", "电子", "电音"),
            "R&B": ("rnb", "r&b", "randb", "rhythmandblues"),
            "emo": ("emo", "midwestemo", "伤感"),
        }
        meaningful = [style for style in preferred if style not in {"松弛"}]
        if not meaningful:
            return True
        for style in meaningful:
            tokens = aliases.get(style, (style,))
            if any(self._normalize_match_text(token) in style_text for token in tokens):
                return True
        return False

    def _decision_preferred_artists(self, decision: dict | None) -> list[str]:
        if not isinstance(decision, dict):
            return []
        artists = decision.get("prefer_artists")
        if not isinstance(artists, list):
            return []
        return [
            str(artist).strip()
            for artist in artists
            if str(artist or "").strip()
        ][:3]

    def _candidate_matches_preferred_artist(
        self,
        candidate: dict,
        decision: dict | None,
    ) -> bool:
        preferred_artists = self._decision_preferred_artists(decision)
        if not preferred_artists:
            return True
        candidate_artist = self._normalize_match_text(self._artist_name(candidate))
        if not candidate_artist:
            return False
        for artist in preferred_artists:
            expected = self._normalize_match_text(artist)
            if expected and (expected in candidate_artist or candidate_artist in expected):
                return True
        return False

    def _artist_pick_plausibly_matches_decision(
        self,
        artist: str,
        decision: dict | None,
    ) -> bool:
        expected_artists = self._decision_preferred_artists(decision)
        if not expected_artists:
            return True
        normalized_artist = self._normalize_match_text(artist)
        if not normalized_artist:
            return False
        for expected_artist in expected_artists:
            expected = self._normalize_match_text(expected_artist)
            if not expected:
                continue
            if expected in normalized_artist or normalized_artist in expected:
                return True
            if self._edit_distance(expected, normalized_artist) <= 2:
                return True
            if self._token_initial_overlap(expected, normalized_artist) >= 2:
                return True
        return False

    def _token_initial_overlap(self, left: str, right: str) -> int:
        left_tokens = [token for token in re.split(r"[\W_]+", left) if token]
        right_tokens = [token for token in re.split(r"[\W_]+", right) if token]
        overlap = 0
        for left_token, right_token in zip(left_tokens, right_tokens):
            if not left_token or not right_token:
                continue
            if left_token[0] == right_token[0]:
                overlap += 1
        return overlap

    def _edit_distance(self, left: str, right: str) -> int:
        if left == right:
            return 0
        if not left:
            return len(right)
        if not right:
            return len(left)
        if abs(len(left) - len(right)) > 2:
            return 3
        previous = list(range(len(right) + 1))
        for i, left_char in enumerate(left, start=1):
            current = [i]
            row_min = i
            for j, right_char in enumerate(right, start=1):
                cost = 0 if left_char == right_char else 1
                value = min(
                    previous[j] + 1,
                    current[j - 1] + 1,
                    previous[j - 1] + cost,
                )
                current.append(value)
                row_min = min(row_min, value)
            if row_min > 2:
                return 3
            previous = current
        return previous[-1]

    def _album_name(self, song: dict | None) -> str:
        if not isinstance(song, dict):
            return ""
        album = song.get("al") or song.get("album")
        if isinstance(album, dict):
            return str(album.get("name") or "").strip()
        if isinstance(album, str):
            return album.strip()
        return ""

    def _looks_like_utility_audio_candidate(self, candidate: dict) -> bool:
        if not isinstance(candidate, dict):
            return True
        text = " ".join(
            str(value or "")
            for value in (
                candidate.get("name"),
                self._artist_name(candidate),
                self._album_name(candidate),
            )
        )
        return self._looks_like_utility_audio_text(text)

    def _looks_like_utility_audio_text(self, text: str) -> bool:
        lowered = str(text or "").lower()
        utility_tokens = (
            "大悲咒",
            "佛经",
            "念经",
            "助眠",
            "睡眠",
            "白噪音",
            "频率",
            "疗愈",
            "冥想",
            "减压",
            "放松大脑",
            "分泌愉悦激素",
            "alpha wave",
            "binaural",
            "study music",
            "healing",
            "meditation",
        )
        return any(token in lowered or token in text for token in utility_tokens)

    def _decision_brief(self, decision: dict) -> str:
        if not isinstance(decision, dict):
            return "暂无"
        parts = []
        if decision.get("prefer_styles"):
            parts.append(f"偏好风格：{decision.get('prefer_styles')}")
        if decision.get("energy"):
            parts.append(f"能量：{decision.get('energy')}")
        if decision.get("use_case"):
            parts.append(f"场景：{decision.get('use_case')}")
        if decision.get("avoid_styles"):
            parts.append(f"避开：{decision.get('avoid_styles')}")
        return "；".join(parts) if parts else "暂无"

    def _profile_brief(self, profile: dict | None) -> str:
        if not isinstance(profile, dict):
            return "暂无"
        insights = profile.get("radio_insights")
        music_dna = profile.get("music_dna")
        parts = []
        if isinstance(insights, dict):
            for key in ("taste_summary", "comfort_zone", "discovery_direction"):
                value = insights.get(key)
                if isinstance(value, list):
                    parts.extend(str(item).strip() for item in value[:3] if str(item).strip())
                elif isinstance(value, str) and value.strip():
                    parts.append(value.strip())
        if isinstance(music_dna, dict):
            genres = music_dna.get("genres")
            if isinstance(genres, dict):
                parts.append(f"常听风格：{list(genres.keys())[:6]}")
        for track in self._pool_list(profile.get("anchor_tracks"))[:5]:
            name = track.get("name") or track.get("song_name")
            artist = self._artist_name(track)
            if name:
                parts.append(f"锚点：{artist} {name}".strip())
        return "；".join(parts[:10]) if parts else "暂无"

    def _settings_brief(self, user_settings: dict | None) -> str:
        if not isinstance(user_settings, dict):
            return "暂无"
        parts = []
        for key, label in (
            ("local_time_block", "时间段"),
            ("weather_hint", "天气"),
            ("region_hint", "地区"),
            ("current_mode", "状态"),
        ):
            value = str(user_settings.get(key) or "").strip()
            if value:
                parts.append(f"{label}：{value}")
        return "；".join(parts) if parts else "暂无"

    def _parse_json(self, text: str) -> dict:
        raw = str(text or "").strip()
        if raw.startswith("```"):
            raw = re.sub(r"^```(?:json)?", "", raw, flags=re.IGNORECASE).strip()
            raw = re.sub(r"```$", "", raw).strip()
        match = re.search(r"\{.*\}", raw, flags=re.DOTALL)
        if not match:
            return {}
        try:
            return json.loads(match.group(0))
        except json.JSONDecodeError:
            return {}

    def _normalize_match_text(self, value) -> str:
        text = str(value or "").casefold()
        return re.sub(r"[\W_]+", "", text, flags=re.UNICODE)
