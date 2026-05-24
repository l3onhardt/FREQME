import base64
import hashlib
import httpx
from pathlib import Path

from backend.core.config import get_settings

settings = get_settings()

# Style descriptions mapped to MiMo Director Mode user prompts
STYLE_USER_PROMPTS = {
    "深夜": (
        "[角色]一个温柔的深夜电台主播，声音低沉而温暖[场景]凌晨两点，听众独自在房间[指导]"
        "语气要轻柔，像在耳边低语，语速缓慢，带着些许慵懒和关怀，不要太过明亮"
    ),
    "清晨": (
        "[角色]一个清新的晨间电台主播[场景]太阳刚升起，新的一天开始[指导]"
        "声音清爽有朝气，语速适中，带着微笑的感觉，让人感到一天的希望"
    ),
    "午后": (
        "[角色]一个慵懒的午后电台主播[场景]阳光透过窗户洒进来，悠闲的下午[指导]"
        "语气随性慵懒，像朋友闲聊，语速稍慢，带着一点暖意"
    ),
    "日常": (
        "[角色]一个温暖自然的电台主播[场景]普通的日常陪伴[指导]"
        "语气自然轻松，像朋友在身边说话，语速正常，不要夸张也不要太平淡"
    ),
}

# Style tags to prepend in assistant content for extra control
STYLE_TAGS = {
    "深夜": "(温柔)(慵懒)(气声)",
    "清晨": "(活泼)(清亮)",
    "午后": "(慵懒)(温柔)",
    "日常": "(温柔)(自然)",
}


class TTSAdapter:
    def __init__(self):
        self.client = httpx.AsyncClient(timeout=30.0, trust_env=False)
        # Use OpenAI-compatible chat completions endpoint
        self.base_url = f"{settings.mimo_api_base.rstrip('/')}/chat/completions"
        self.api_key = settings.mimo_api_key
        self.model = settings.mimo_tts_model
        self.voice = settings.mimo_tts_voice
        self.cache_dir = Path(settings.data_dir) / "tts_cache"
        self.cache_dir.mkdir(parents=True, exist_ok=True)

    def _hash(
        self,
        text: str,
        style: str,
        user_settings: dict | None = None,
    ) -> str:
        return hashlib.md5(f"{text}|{style}|{self.voice}".encode()).hexdigest()

    async def synthesize(
        self,
        text: str,
        style: str = "日常",
        user_settings: dict | None = None,
    ) -> bytes | None:
        h = self._hash(text, style)

        # Check disk cache
        cache_path = self.cache_dir / f"{h}.wav"
        if cache_path.exists():
            return cache_path.read_bytes()

        # Check SQLite cache (lighter check first)
        from backend.memory.store import MemoryStore
        store = MemoryStore()
        cached = await store.get_tts_cache(h)
        if cached and Path(cached).exists():
            return Path(cached).read_bytes()

        style_user = STYLE_USER_PROMPTS.get(style, STYLE_USER_PROMPTS["日常"])
        style_tag = STYLE_TAGS.get(style, STYLE_TAGS["日常"])

        # Build assistant content with style tag prefix
        assistant_content = f"{style_tag}{text}"

        body = {
            "model": self.model,
            "messages": [
                {"role": "user", "content": style_user},
                {"role": "assistant", "content": assistant_content},
            ],
            "audio": {
                "format": "wav",
                "voice": self.voice,
            },
        }

        # Try MiMo API
        try:
            r = await self.client.post(
                self.base_url,
                headers={
                    "api-key": self.api_key,
                    "Content-Type": "application/json",
                },
                json=body,
                timeout=25.0,
            )
            if r.status_code == 200:
                data = r.json()
                audio_b64 = (
                    data.get("choices", [{}])[0]
                    .get("message", {})
                    .get("audio", {})
                    .get("data", "")
                )
                if audio_b64:
                    audio_bytes = base64.b64decode(audio_b64)
                    cache_path.write_bytes(audio_bytes)
                    await store.cache_tts(h, str(cache_path))
                    return audio_bytes
        except Exception:
            pass

        # Fallback: Edge TTS
        try:
            import subprocess
            import tempfile
            tmp_path = self.cache_dir / f"{h}_edge.wav"
            subprocess.run(
                [
                    "edge-tts", "--voice", "zh-CN-XiaoxiaoNeural",
                    "--text", text, "--write-media", str(tmp_path),
                ],
                timeout=15,
                capture_output=True,
            )
            if tmp_path.exists():
                audio = tmp_path.read_bytes()
                await store.cache_tts(h, str(tmp_path))
                return audio
        except Exception:
            pass

        return None

    async def close(self):
        await self.client.aclose()
