import random
from dataclasses import dataclass, field

from backend.adapters.netease import NeteaseAdapter
from backend.memory.store import MemoryStore
from backend.core.event_bus import EventBus


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


class StreamScheduler:
    def __init__(self, netease: NeteaseAdapter, store: MemoryStore, bus: EventBus):
        self.netease = netease
        self.store = store
        self.bus = bus
        self._fallback_queue: list[dict] = []

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
            return selected

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
