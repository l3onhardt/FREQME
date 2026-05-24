import json
import re

from backend.adapters.netease import NeteaseAdapter
from backend.adapters.llm_router import LLMRouter
from backend.memory.store import MemoryStore


class ProfileEngine:
    def __init__(self, netease: NeteaseAdapter, llm: LLMRouter, store: MemoryStore):
        self.netease = netease
        self.llm = llm
        self.store = store

    async def analyze(self, uid: int) -> dict:
        playlists = await self.netease.user_playlist(uid)
        records = await self.netease.user_record(uid)
        liked = await self.netease.like_list(uid)

        all_songs = []
        for pl in (playlists or [])[:10]:
            all_songs.extend((pl.get("tracks") or [])[:50])

        song_list = "\n".join(
            f"- {s.get('name', '')} by {s.get('ar', [{}])[0].get('name', '') if s.get('ar') else ''}"
            for s in all_songs[:200]
        )

        week_data = records.get("weekData", []) if records else []
        recent_listens = "\n".join(
            f"- {s.get('song', {}).get('name', '')} by {s.get('song', {}).get('ar', [{}])[0].get('name', '') if s.get('song', {}).get('ar') else ''}"
            for s in week_data[:50]
        )

        prompt = f"""请分析以下用户的音乐数据，生成用户画像。

用户歌单歌曲样本：
{song_list[:3000]}

最近一周听歌记录：
{recent_listens[:2000]}

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

        await self.store.save_profile(str(uid), profile)
        return profile

    async def should_update(self, uid: str) -> bool:
        count = await self.store.session_count(uid)
        return count > 0 and count % 10 == 0
