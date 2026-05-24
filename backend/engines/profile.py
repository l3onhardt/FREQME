import json
import re

from backend.adapters.llm_router import LLMRouter
from backend.adapters.netease import NeteaseAdapter
from backend.memory.store import MemoryStore


class ProfileEngine:
    def __init__(self, netease: NeteaseAdapter, llm: LLMRouter, store: MemoryStore):
        self.netease = netease
        self.llm = llm
        self.store = store

    async def _best_effort(self, awaitable, default):
        try:
            return await awaitable
        except Exception:
            return default

    def _has_track_id(self, song) -> bool:
        return isinstance(song, dict) and bool(song.get("id"))

    def _compact_track(self, song: dict, source: str = "") -> dict:
        if not isinstance(song, dict):
            song = {}

        artists = song.get("ar") or song.get("artists") or []
        if isinstance(artists, dict):
            artists = [artists]
        if not isinstance(artists, list):
            artists = []

        first_artist = artists[0] if artists else {}
        artist = first_artist.get("name", "") if isinstance(first_artist, dict) else ""
        return {
            "id": str(song.get("id", "")),
            "name": song.get("name", "") or "",
            "artist": artist or "",
            "source": source,
        }

    async def _playlist_tracks(
        self, playlists: list[dict], max_playlists: int = 6
    ) -> list[dict]:
        tracks = []
        for playlist in (playlists or [])[:max_playlists]:
            playlist_id = playlist.get("id")
            if not playlist_id:
                continue
            try:
                detail = await self.netease.playlist_detail(playlist_id)
            except Exception:
                continue

            playlist_data = detail.get("playlist", {}) if isinstance(detail, dict) else {}
            tracks.extend((playlist_data.get("tracks") or [])[:40])
        return tracks

    async def analyze(self, uid: int) -> dict:
        playlists = await self._best_effort(self.netease.user_playlist(uid), [])
        if not isinstance(playlists, list):
            playlists = []
        playlist_tracks = await self._playlist_tracks(playlists)
        records = await self._best_effort(self.netease.user_record(uid), {})
        if not isinstance(records, dict):
            records = {}
        liked = await self._best_effort(self.netease.like_list(uid), [])
        if not isinstance(liked, list):
            liked = []
        user_settings = await self._best_effort(self.store.get_user_settings(str(uid)), {})
        if not isinstance(user_settings, dict):
            user_settings = {}
        music_notes = (user_settings.get("music_notes") or "").strip()[:500]
        valid_playlist_tracks = [song for song in playlist_tracks if self._has_track_id(song)]

        song_list = "\n".join(
            f"- {track['name']} by {track['artist']}"
            for track in (
                self._compact_track(song, "playlist")
                for song in valid_playlist_tracks[:200]
            )
        )

        week_data = records.get("weekData", []) if records else []
        if not isinstance(week_data, list):
            week_data = []
        recent_song_items = [
            item.get("song", {})
            for item in week_data[:50]
            if isinstance(item, dict) and self._has_track_id(item.get("song"))
        ]
        recent_listens = "\n".join(
            f"- {track['name']} by {track['artist']}"
            for track in (
                self._compact_track(song, "recent") for song in recent_song_items
            )
        )

        prompt = f"""请分析以下用户的音乐数据，生成用户画像。

用户歌单歌曲样本：
{song_list[:3000]}

最近一周听歌记录：
{recent_listens[:2000]}

用户补充 notes：
{music_notes}

请返回JSON格式（不要包含其他内容）：
{{
  "music_dna": {{
    "genres": {{"风格1": 0.0-1.0的权重}},
    "era_bias": "年代倾向",
    "energy_level": "高/中/低",
    "language_bias": {{"语种": 权重}},
    "vocal_preference": "声音偏好"
  }},
  "personality": {{
    "mbti_guess": "推测MBTI",
    "traits": ["性格特征"],
    "emotional_resonance": "情感共鸣关键词"
  }},
  "listening_pattern": {{
    "peak_hours": ["高峰期"],
    "avg_session_guess": "估计平均时长分钟数"
  }},
  "dj_style_suggestion": "建议的主播风格（一句话）"
}}"""

        response = await self.llm.chat(prompt, max_tokens=800)
        try:
            match = re.search(r"\{.*\}", response, re.DOTALL)
            profile = json.loads(match.group()) if match else None
        except (json.JSONDecodeError, AttributeError):
            profile = None

        if profile is None:
            profile = {
                "music_dna": {
                    "genres": {},
                    "era_bias": "未知",
                    "energy_level": "中",
                    "language_bias": {},
                    "vocal_preference": "未知",
                },
                "personality": {
                    "mbti_guess": "未知",
                    "traits": [],
                    "emotional_resonance": "音乐",
                },
                "listening_pattern": {
                    "peak_hours": [],
                    "avg_session_guess": "未知",
                },
                "dj_style_suggestion": "自然温暖",
            }

        profile["anchor_tracks"] = [
            self._compact_track(song, "playlist") for song in valid_playlist_tracks[:40]
        ]
        profile["recent_tracks"] = [
            self._compact_track(song, "recent") for song in recent_song_items[:30]
        ]
        profile["liked_track_ids"] = [str(song_id) for song_id in (liked or [])[:500]]

        await self.store.save_profile(str(uid), profile)
        return profile

    async def should_update(self, uid: str) -> bool:
        count = await self.store.session_count(uid)
        return count > 0 and count % 10 == 0
