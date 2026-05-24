from datetime import datetime, timezone, timedelta

from backend.adapters.llm_router import LLMRouter
from backend.memory.store import MemoryStore
from backend.memory.compressor import ContextCompressor


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
        elif 12 <= h < 17:
            return "午后"
        elif 22 <= h or h < 5:
            return "深夜"
        return "日常"

    async def generate_intro(self, profile: dict, scene: str) -> str:
        style = profile.get("dj_style_suggestion", "温暖自然")
        personality = profile.get("personality", {})
        prompt = f"""现在是{scene}。用户在听电台。
用户画像：{personality}
建议的DJ风格：{style}

请生成一段电台开场白（30秒朗读时长），介绍今晚的主题。
不要用"欢迎收听"之类的开场白，直接自然开始。
像朋友见面一样随意自然。"""
        return await self.llm.chat(prompt, max_tokens=200)

    async def generate_segue(
        self,
        profile: dict,
        scene: str,
        current_song: dict,
        next_song: dict,
        context: ContextCompressor,
    ) -> str:
        current_name = current_song.get("name", "这首歌")
        current_artist = (
            current_song.get("ar", [{}])[0].get("name", "")
            if current_song.get("ar")
            else ""
        )
        next_name = next_song.get("name", "下一首歌")
        next_artist = (
            next_song.get("ar", [{}])[0].get("name", "")
            if next_song.get("ar")
            else ""
        )

        recent = context.to_prompt_text()
        style = profile.get("dj_style_suggestion", "温暖自然")
        traits = profile.get("personality", {}).get("traits", [])

        prompt = f"""你是小米memo，电台主播。现在是{scene}。

当前刚播完：{current_name} - {current_artist}
接下来要播：{next_name} - {next_artist}

用户画像：{', '.join(traits) if traits else '普通人'}
你的风格：{style}

最近对话：
{recent if recent else '（刚开始）'}

请生成一段30秒到60秒朗读时长的串场语，从当前歌曲自然过渡到下一首。
用场景、感受、画面来连接两首歌，不要说"推荐"、"喜欢"、"接下来请听"。
像朋友分享一个发现一样自然。"""
        return await self.llm.chat(prompt, max_tokens=300)
