import random

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


class StreamScheduler:
    def __init__(self, netease: NeteaseAdapter, store: MemoryStore, bus: EventBus):
        self.netease = netease
        self.store = store
        self.bus = bus
        self._fallback_queue: list[dict] = []
        self._played_this_session: set[str] = set()

    def _shuffle_fallback(self):
        self._fallback_queue = random.sample(FALLBACK_PLAYLIST, len(FALLBACK_PLAYLIST))

    async def pick_next(
        self,
        current_song_id: str | None = None,
        profile: dict | None = None,
        user_settings: dict | None = None,
    ) -> dict | None:
        recent_db = await self.store.get_recent_tracks(200)
        recent = set(recent_db) | self._played_this_session

        def _good(song: dict) -> bool:
            sid = str(song.get("id"))
            return bool(sid) and sid not in recent

        # 1. Similar songs based on current track
        if current_song_id:
            simi = await self.netease.simi_song(current_song_id)
            for s in (simi or [])[:8]:
                if _good(s):
                    self._played_this_session.add(str(s.get("id")))
                    return s

        # 2. NetEase daily recommendations (shuffle to avoid same first song)
        recommends = await self.netease.recommend_songs()
        if recommends:
            random.shuffle(recommends)
            for s in recommends[:15]:
                if _good(s):
                    self._played_this_session.add(str(s.get("id")))
                    return s

        # 3. Personal FM
        fm = await self.netease.personal_fm()
        for s in (fm or [])[:10]:
            if _good(s):
                self._played_this_session.add(str(s.get("id")))
                return s

        # 4. Fallback playlist (built-in, always available)
        if not self._fallback_queue:
            self._shuffle_fallback()

        while self._fallback_queue:
            s = self._fallback_queue.pop(0)
            if _good(s):
                self._played_this_session.add(str(s.get("id")))
                return s

        # 5. All fallback played, reshuffle and try again
        self._shuffle_fallback()
        for s in self._fallback_queue:
            if _good(s):
                self._played_this_session.add(str(s.get("id")))
                return s

        # 6. Last resort: clear session memory and return first fallback
        self._played_this_session.clear()
        if self._fallback_queue:
            return self._fallback_queue[0]
        return FALLBACK_PLAYLIST[0] if FALLBACK_PLAYLIST else None

    async def get_song_url(self, song: dict) -> str:
        sid = str(song.get("id"))
        url = await self.netease.song_url(sid)
        # If NetEase returns its own fallback URL, it means no real URL found
        # Try the direct outer URL which works for many songs
        if "song/media/outer/url" in url:
            return url
        return url or f"https://music.163.com/song/media/outer/url?id={sid}.mp3"
