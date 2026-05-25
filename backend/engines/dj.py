from datetime import datetime, timedelta, timezone

from backend.adapters.llm_router import LLMRouter
from backend.memory.compressor import ContextCompressor
from backend.memory.store import MemoryStore


def should_generate_segue(track_index: int) -> bool:
    return track_index > 0 and track_index % 2 == 0


class DJEngine:
    def __init__(self, llm: LLMRouter, store: MemoryStore):
        self.llm = llm
        self.store = store

    def detect_scene(self, utc_offset: int = 480) -> str:
        try:
            tz = timezone(timedelta(minutes=utc_offset))
        except Exception:
            tz = timezone(timedelta(hours=8))
        local = datetime.now(tz)
        h = local.hour
        if 5 <= h < 9:
            return "清晨"
        if 12 <= h < 17:
            return "午后"
        if 22 <= h or h < 5:
            return "深夜"
        return "日常"

    async def generate_intro(
        self,
        profile: dict,
        scene: str,
        user_settings: dict | None = None,
    ) -> str:
        style = profile.get("dj_style_suggestion", "温暖自然")
        personality = profile.get("personality", {})
        prompt = f"""现在是{scene}。用户正在听电台。
用户画像：{personality}
建议的 DJ 风格：{style}

请生成一段电台开场白，约 20 秒朗读时长，介绍今晚的主题。
不要用“欢迎收听”之类的开场白，直接自然开始。
像朋友见面一样随意自然。"""
        return await self.llm.chat(
            self._with_user_settings_hint(prompt, user_settings),
            max_tokens=200,
        )

    async def generate_segue(
        self,
        profile: dict,
        scene: str,
        current_song: dict,
        next_song: dict,
        context: ContextCompressor,
        user_settings: dict | None = None,
    ) -> str:
        current_name = current_song.get("name", "这首歌")
        current_artist = self._artist_name(current_song)
        next_name = next_song.get("name", "下一首歌")
        next_artist = self._artist_name(next_song)
        selection_reason = (
            (next_song.get("selection_reason") or {}).get("text", "")
            if isinstance(next_song.get("selection_reason"), dict)
            else ""
        )

        recent = context.to_prompt_text()
        style = profile.get("dj_style_suggestion", "温暖自然")
        traits = profile.get("personality", {}).get("traits", [])
        current_mode = (user_settings or {}).get("current_mode", "").strip()
        music_notes = (user_settings or {}).get("music_notes", "").strip()[:200]

        prompt = f"""你是小米 memo，电台主播。现在是{scene}。

当前刚播完：{current_name} - {current_artist}
接下来要播：{next_name} - {next_artist}
选曲依据：{selection_reason or '延续当下氛围，让歌曲自然接上。'}

用户画像：{', '.join(traits) if traits else '普通人'}
你的风格：{style}
用户 mode：{current_mode or '未说明'}
用户 notes：{music_notes or '未说明'}

最近对话：
{recent if recent else '（刚开始）'}

请生成一段 20 秒到 60 秒朗读时长的串场语，从当前歌曲自然过渡到下一首。
用场景、感受、画面来连接两首歌，不要说“推荐”“喜欢”“接下来请听”。
不要暴露“我分析了你”或算法依据，把选曲依据化成自然电台主播会说的感受。
像朋友分享一个发现一样自然。"""
        return await self.llm.chat(
            self._with_user_settings_hint(prompt, user_settings),
            max_tokens=300,
        )

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

    def _with_user_settings_hint(
        self,
        prompt: str,
        user_settings: dict | None = None,
    ) -> str:
        display_name = (user_settings or {}).get("display_name", "").strip()
        music_notes = (user_settings or {}).get("music_notes", "").strip()[:200]
        current_mode = (user_settings or {}).get("current_mode", "").strip()
        hints = []
        if display_name:
            hints.append(f"display name: {display_name}")
        if current_mode:
            hints.append(f"current mode: {current_mode}")
        if music_notes:
            hints.append(f"music notes: {music_notes}")
        if not hints:
            return prompt
        return f"{prompt}\n\nListener settings: {'; '.join(hints)}"
