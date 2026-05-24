import base64
import hashlib
from pathlib import Path

import httpx

from backend.core.config import get_settings

settings = get_settings()

VOICE_PRESETS = {
    "warm_female": {
        "config_attr": "mimo_tts_voice_warm_female",
        "director": "温暖、磁性、克制的中文电台女主播音色，声音贴近真实广播节目，亲切但不甜腻。",
    },
    "warm_male": {
        "config_attr": "mimo_tts_voice_warm_male",
        "director": "温和、低暖、沉稳的中文电台男主播音色，有陪伴感，表达自然，不油腻、不表演化。",
    },
    "bright_girl": {
        "config_attr": "mimo_tts_voice_bright_girl",
        "director": "年轻、明亮、干净的中文电台女主播音色，亲近而克制，保持真实主播感，避免角色扮演、刻意卖萌或过度可爱化口吻。",
    },
}

SCENE_GUIDANCE = {
    "深夜": "深夜时段，语速稍慢，留白自然，氛围温暖安静。",
    "清晨": "清晨时段，语气清爽，节奏适中，带一点醒来的轻盈感但不要兴奋。",
    "午后": "午后时段，语气放松，节奏舒展，有一点阳光感但不过分慵懒。",
    "日常": "日常陪伴，语气自然平稳，语速正常，像真实电台主播在顺畅串场。",
}

# Compatibility for scene values persisted or emitted before the UTF-8 cleanup.
LEGACY_SCENE_ALIASES = {
    "娣卞": "深夜",
    "娓呮櫒": "清晨",
    "鍗堝悗": "午后",
    "鏃ゅ父": "日常",
    "鏃ュ父": "日常",
}


class TTSAdapter:
    def __init__(self):
        self.client = httpx.AsyncClient(timeout=30.0, trust_env=False)
        # Use OpenAI-compatible chat completions endpoint
        self.base_url = f"{settings.mimo_api_base.rstrip('/')}/chat/completions"
        self.api_key = settings.mimo_api_key
        self.model = settings.mimo_tts_model
        self.voice = settings.mimo_tts_voice
        self.voice_config = {
            key: getattr(settings, preset["config_attr"], "") or ""
            for key, preset in VOICE_PRESETS.items()
        }
        self.cache_dir = Path(settings.data_dir) / "tts_cache"
        self.cache_dir.mkdir(parents=True, exist_ok=True)

    def _voice_preset_from_settings(
        self,
        user_settings: dict | None = None,
        voice_preset: str | None = None,
    ) -> str:
        candidate = voice_preset
        if not candidate and user_settings:
            candidate = user_settings.get("voice_preset")
        return candidate if candidate in VOICE_PRESETS else "warm_female"

    def _resolve_voice(self, voice_preset: str | None = None) -> str:
        preset_key = self._voice_preset_from_settings(voice_preset=voice_preset)
        configured = self.voice_config.get(preset_key, "")
        return configured or self.voice

    def _normalize_scene(self, scene: str | None = None) -> str:
        if not scene:
            return "日常"
        return LEGACY_SCENE_ALIASES.get(scene, scene)

    def _director_prompt(
        self,
        scene: str = "日常",
        voice_preset: str | None = None,
    ) -> str:
        preset_key = self._voice_preset_from_settings(voice_preset=voice_preset)
        preset = VOICE_PRESETS[preset_key]
        normalized_scene = self._normalize_scene(scene)
        scene_text = SCENE_GUIDANCE.get(normalized_scene, SCENE_GUIDANCE["日常"])
        return (
            f"[角色]{preset['director']}"
            f"[场景]{scene_text}"
            "[指导]像真实电台主播一样说话，磁性、温暖、克制、自然。"
            "只读正文含义，不要加入奇怪语气词、拟声词、括号情绪标签或夸张重音；"
            "不要把语气做成刻意卖萌、舞台表演或广告腔。"
        )

    def build_request_body(
        self,
        text: str,
        scene: str = "日常",
        voice_preset: str | None = None,
        user_settings: dict | None = None,
    ) -> dict:
        preset_key = self._voice_preset_from_settings(user_settings, voice_preset)
        return {
            "model": self.model,
            "messages": [
                {"role": "user", "content": self._director_prompt(scene, preset_key)},
                {"role": "assistant", "content": text},
            ],
            "audio": {
                "format": "wav",
                "voice": self._resolve_voice(preset_key),
            },
        }

    def _hash(
        self,
        text: str,
        style: str,
        voice_preset: str | None = None,
        user_settings: dict | None = None,
    ) -> str:
        preset_key = self._voice_preset_from_settings(user_settings, voice_preset)
        voice = self._resolve_voice(preset_key)
        normalized_style = self._normalize_scene(style)
        return hashlib.md5(
            f"{text}|{normalized_style}|{preset_key}|{voice}".encode()
        ).hexdigest()

    async def synthesize(
        self,
        text: str,
        style: str = "日常",
        voice_preset: str | None = None,
        user_settings: dict | None = None,
    ) -> bytes | None:
        preset_key = self._voice_preset_from_settings(user_settings, voice_preset)
        normalized_style = self._normalize_scene(style)
        h = self._hash(text, normalized_style, voice_preset=preset_key)

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

        body = self.build_request_body(
            text,
            normalized_style,
            voice_preset=preset_key,
            user_settings=user_settings,
        )

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

            subprocess.run(
                [
                    "edge-tts",
                    "--voice",
                    "zh-CN-XiaoxiaoNeural",
                    "--text",
                    text,
                    "--write-media",
                    str(cache_path),
                ],
                timeout=15,
                capture_output=True,
            )
            if cache_path.exists():
                audio = cache_path.read_bytes()
                await store.cache_tts(h, str(cache_path))
                return audio
        except Exception:
            pass

        return None

    async def close(self):
        await self.client.aclose()
