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

    def _ensure_radio_insights(
        self,
        profile: dict,
        music_notes: str,
        anchor_tracks: list[dict],
        recent_tracks: list[dict],
    ) -> dict:
        insights = profile.get("radio_insights")
        if not isinstance(insights, dict):
            insights = {}

        traits = profile.get("personality", {}).get("traits", [])
        if not isinstance(traits, list):
            traits = []
        trait_text = "、".join(str(item) for item in traits[:3] if item)
        anchor_names = [
            track.get("name", "")
            for track in anchor_tracks[:3]
            if isinstance(track, dict) and track.get("name")
        ]
        recent_names = [
            track.get("name", "")
            for track in recent_tracks[:3]
            if isinstance(track, dict) and track.get("name")
        ]

        fallback_summary = "用户的听歌口味偏向熟悉、有人声温度、能承接情绪的歌曲。"
        if anchor_names:
            fallback_summary = (
                f"用户常回到 {('、'.join(anchor_names))} 这类熟悉旋律，"
                "这些歌更像情绪上的安全地带。"
            )
        if trait_text:
            fallback_summary = f"{fallback_summary} 听感性格可以概括为：{trait_text}。"

        insights.setdefault("taste_summary", fallback_summary)
        insights.setdefault(
            "comfort_zone",
            anchor_names or ["熟悉旋律", "温暖人声", "中低能量情绪歌"],
        )
        insights.setdefault(
            "discovery_direction",
            [
                "保持人声温度，但给编曲或语种一点新鲜感",
                "从熟悉歌手延伸到气质相近的新歌",
            ],
        )
        insights.setdefault(
            "emotional_hooks",
            recent_names or anchor_names or ["安静陪伴", "夜晚放松"],
        )
        insights.setdefault(
            "dj_talking_points",
            [
                "熟悉的旋律对用户来说不只是怀旧，更像把心放稳的方式。",
                "介绍新歌时先讲声音质感和情绪落点，比讲大道理更贴近。",
            ],
        )
        if music_notes and "music_notes_read" not in insights:
            insights["music_notes_read"] = (
                f"用户补充过：{music_notes[:120]}。主播只把它理解为偏好，不要原句复读。"
            )
        profile["radio_insights"] = insights
        return profile

    async def _playlist_tracks(
        self, playlists: list[dict], max_playlists: int = 6
    ) -> list[dict]:
        tracks = []
        for playlist in (playlists or [])[:max_playlists]:
            if not isinstance(playlist, dict):
                continue
            playlist_id = playlist.get("id")
            if not playlist_id:
                continue
            try:
                detail = await self.netease.playlist_detail(playlist_id)
            except Exception:
                continue

            playlist_data = detail.get("playlist", {}) if isinstance(detail, dict) else {}
            if not isinstance(playlist_data, dict):
                continue
            playlist_tracks = playlist_data.get("tracks") or []
            if not isinstance(playlist_tracks, list):
                continue
            tracks.extend(playlist_tracks[:40])
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
  "dj_style_suggestion": "建议的主播风格（一句话）",
  "radio_insights": {{
    "taste_summary": "一句像真人主播会说的听感洞察，不要像标签报告",
    "comfort_zone": ["用户最容易觉得被懂到的熟悉听感"],
    "discovery_direction": ["适合从熟悉区往外扩的方向"],
    "emotional_hooks": ["哪些歌或声音可能对用户有情绪意义"],
    "dj_talking_points": ["主播可以自然引用的具体观察，禁止说根据画像"]
  }}
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

        anchor_tracks = [
            self._compact_track(song, "playlist") for song in valid_playlist_tracks[:40]
        ]
        recent_tracks = [
            self._compact_track(song, "recent") for song in recent_song_items[:30]
        ]
        profile["anchor_tracks"] = anchor_tracks
        profile["recent_tracks"] = recent_tracks
        profile["liked_track_ids"] = [str(song_id) for song_id in (liked or [])[:500]]
        profile = self._ensure_radio_insights(
            profile,
            music_notes,
            anchor_tracks,
            recent_tracks,
        )

        await self.store.save_profile(str(uid), profile)
        return profile

    async def should_update(self, uid: str) -> bool:
        count = await self.store.session_count(uid)
        return count > 0 and count % 10 == 0
