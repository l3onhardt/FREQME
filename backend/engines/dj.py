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
        prompt = f"""现在是{scene}，用户刚打开一档私人 AI 音乐电台。

用户画像：{personality}
建议的 DJ 风格：{style}

请生成一段开场白，朗读时长约 12 到 20 秒。
只输出主播要说的话，不要标题、括号、解释或舞台提示。
不要说“欢迎收听”，不要说“根据你的画像”，不要提算法。
语气要像真实电台主播自然开口，有画面感，但不要矫情。"""
        return await self.llm.chat(
            self._with_user_settings_hint(prompt, user_settings),
            max_tokens=180,
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

        prompt = f"""你是小米 memo，一位私人音乐电台主播。现在是{scene}。

当前刚播完：{current_name} - {current_artist}
下一首即将播放：{next_name} - {next_artist}
选曲线索：{selection_reason or '延续刚才的情绪，让两首歌自然接上。'}

用户画像：{', '.join(traits) if traits else '暂无明确画像'}
主播风格：{style}
用户当前状态：{current_mode or '未说明'}
用户备注：{music_notes or '未说明'}

最近电台上下文：
{recent if recent else '刚开始，没有历史上下文。'}

请生成一段 1 到 2 句的串场，朗读时长约 8 到 15 秒。
只输出主播要说的话，不要标题、括号、解释或舞台提示。
必须自然连接“{current_name}”和“{next_name}”，可以点到两首歌的气质变化。
不要说推荐，不要说喜欢，不要说接下来请听，不要暴露算法、用户画像或选曲依据。
语气要像深夜电台里真实的人在接歌：具体、克制、贴近音乐。"""
        return await self.llm.chat(
            self._with_user_settings_hint(prompt, user_settings),
            max_tokens=180,
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
            hints.append(f"听众昵称：{display_name}")
        if current_mode:
            hints.append(f"当前状态：{current_mode}")
        if music_notes:
            hints.append(f"音乐偏好备注：{music_notes}")
        if not hints:
            return prompt
        return f"{prompt}\n\n听众补充信息：{'；'.join(hints)}"
