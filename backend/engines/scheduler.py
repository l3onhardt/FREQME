import random
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
    def __init__(self, netease: NeteaseAdapter, store: MemoryStore, bus: EventBus):
        self.netease = netease
        self.store = store
        self.bus = bus
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
        return await self._choose_candidate_async(ranked, recent_ids, recent_artists, uid=uid)

    def _radio_brain_reason_text(self, decision: dict) -> str:
        ack = str(decision.get("ack_text") or "").strip()
        if ack:
            return ack
        raw_text = str(decision.get("raw_text") or "").strip()
        if raw_text:
            return f"回应你刚刚说“{raw_text}”，先从你的歌单里换一条更贴近的线。"
        return "先按你的听感反馈，从你的歌单里换一条更贴近的线。"

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

        intent = self._intent_from_settings(user_settings, state)
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
