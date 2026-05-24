import httpx

from backend.core.config import get_settings
from backend.memory.store import MemoryStore

settings = get_settings()


def _mimo_chat(msgs: list[dict], maxt: int, api_key: str, base_url: str, model: str) -> str:
    """Use MiMo's OpenAI-compatible chat completions for text generation."""
    r = httpx.post(
        f"{base_url.rstrip('/')}/chat/completions",
        headers={"api-key": api_key, "Content-Type": "application/json"},
        json={
            "model": model,
            "messages": msgs,
            "max_tokens": maxt,
        },
        timeout=15.0,
    )
    r.raise_for_status()
    data = r.json()
    return data["choices"][0]["message"]["content"]


PROVIDERS = {
    "mimo": {
        "url": "dynamic",  # use base_url from settings
        "headers": lambda: {
            "api-key": settings.llm_api_key or settings.mimo_api_key,
            "Content-Type": "application/json",
        },
        "body": lambda msgs, maxt: {
            "model": settings.llm_model,
            "max_tokens": maxt,
            "messages": msgs,
        },
        "parse": lambda r: r.json()["choices"][0]["message"]["content"],
        "base_url": lambda: f"{settings.llm_api_base.rstrip('/')}/chat/completions",
    },
    "anthropic": {
        "url": "https://api.anthropic.com/v1/messages",
        "headers": lambda: {
            "x-api-key": settings.llm_api_key,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
        },
        "body": lambda msgs, maxt: {
            "model": settings.llm_model,
            "max_tokens": maxt,
            "messages": msgs,
        },
        "parse": lambda r: r.json()["content"][0]["text"],
    },
    "openai": {
        "url": "https://api.openai.com/v1/chat/completions",
        "headers": lambda: {
            "Authorization": f"Bearer {settings.llm_api_key}",
            "content-type": "application/json",
        },
        "body": lambda msgs, maxt: {
            "model": settings.llm_model,
            "max_tokens": maxt,
            "messages": msgs,
        },
        "parse": lambda r: r.json()["choices"][0]["message"]["content"],
    },
    "gemini": {
        "url": lambda: (
            f"https://generativelanguage.googleapis.com/v1beta/models/"
            f"{settings.llm_model}:generateContent?key={settings.llm_api_key}"
        ),
        "headers": lambda: {"content-type": "application/json"},
        "body": lambda msgs, maxt: {
            "contents": [{"parts": [{"text": m["content"]} for m in msgs]}],
            "generationConfig": {"maxOutputTokens": maxt},
        },
        "parse": lambda r: r.json()["candidates"][0]["content"]["parts"][0]["text"],
    },
}

FALLBACK_TEMPLATES = {
    "开场": "嗨，晚上好。电台已经打开，今天想和你分享一些我找到的音乐。",
    "推荐歌曲": "刚才那首歌让我想起了一些画面。接下来这首，希望你也喜欢。",
    "深夜": "夜深了，声音轻一点，陪你安静地听会儿歌。",
    "通用": "好，我们继续听音乐。",
}


class LLMRouter:
    def __init__(self):
        self.client = httpx.AsyncClient(timeout=30.0, trust_env=False)
        self.store = MemoryStore()
        self.system_prompt = """你是小米memo，一个温暖的音乐电台主播。

规则：
1. 永远不说"我喜欢这首歌"——用画面、回忆、比喻传达感受
2. 永远不说"推荐"——说"分享"、"找到"、"让我想起"
3. 永远不评价用户品味——只共鸣，不判断
4. 每段话30-60秒朗读时长，自然口语化
5. 根据场景调整语气：深夜低缓安静，午后慵懒随性，清晨清爽有朝气"""

    async def chat(self, user_msg: str, max_tokens: int = 300,
                   system: str | None = None) -> str:
        messages = [
            {"role": "system", "content": system or self.system_prompt},
            {"role": "user", "content": user_msg},
        ]

        provider_order = [settings.llm_provider]
        if settings.llm_fallback_provider != settings.llm_provider:
            provider_order.append(settings.llm_fallback_provider)

        budget_ok = await self.store.check_token_budget()

        for provider in provider_order:
            if not budget_ok and provider != settings.llm_fallback_provider:
                continue
            try:
                cfg = PROVIDERS[provider]
                url = cfg["url"]
                if url == "dynamic":
                    url = cfg["base_url"]()
                elif callable(url):
                    url = url()

                r = await self.client.post(
                    url,
                    headers=cfg["headers"](),
                    json=cfg["body"](messages, max_tokens),
                    timeout=15.0,
                )
                if r.status_code == 200:
                    result = cfg["parse"](r)
                    usage = r.json().get("usage", {})
                    tokens = usage.get("total_tokens", max_tokens)
                    await self.store.add_tokens(tokens)
                    return result
            except Exception:
                continue

        # Fallback to templates
        for keyword, template in FALLBACK_TEMPLATES.items():
            if keyword in user_msg:
                return template
        return FALLBACK_TEMPLATES["通用"]

    async def close(self):
        await self.client.aclose()
