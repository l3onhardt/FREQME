import httpx

from backend.core.config import get_settings
from backend.memory.store import MemoryStore

settings = get_settings()

REJECTION_MARKERS = (
    "request was rejected",
    "considered high risk",
    "content policy",
    "safety policy",
)


def _is_provider_rejection(text: str) -> bool:
    lowered = (text or "").strip().lower()
    return any(marker in lowered for marker in REJECTION_MARKERS)


def _mimo_chat(msgs: list[dict], maxt: int, api_key: str, base_url: str, model: str) -> str:
    """Use MiMo's OpenAI-compatible chat completions for text generation."""
    response = httpx.post(
        f"{base_url.rstrip('/')}/chat/completions",
        headers={"api-key": api_key, "Content-Type": "application/json"},
        json={
            "model": model,
            "messages": msgs,
            "max_tokens": maxt,
        },
        timeout=15.0,
    )
    response.raise_for_status()
    data = response.json()
    return data["choices"][0]["message"]["content"]


PROVIDERS = {
    "mimo": {
        "url": "dynamic",
        "headers": lambda: {
            "api-key": settings.llm_api_key or settings.mimo_api_key,
            "Content-Type": "application/json",
        },
        "body": lambda msgs, maxt: {
            "model": settings.llm_model,
            "max_tokens": maxt,
            "messages": msgs,
        },
        "parse": lambda response: response.json()["choices"][0]["message"]["content"],
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
        "parse": lambda response: response.json()["content"][0]["text"],
    },
    "openai": {
        "url": "https://api.openai.com/v1/chat/completions",
        "headers": lambda: {
            "Authorization": f"Bearer {settings.llm_api_key}",
            "content-type": "application/json",
        },
        "body": lambda msgs, maxt: {
            "model": settings.llm_model,
            "messages": msgs,
            "max_tokens": maxt,
        },
        "parse": lambda response: response.json()["choices"][0]["message"]["content"],
    },
    "gemini": {
        "url": lambda: (
            "https://generativelanguage.googleapis.com/v1beta/models/"
            f"{settings.llm_model}:generateContent?key={settings.llm_api_key}"
        ),
        "headers": lambda: {"content-type": "application/json"},
        "body": lambda msgs, maxt: {
            "contents": [{"parts": [{"text": m["content"]} for m in msgs]}],
            "generationConfig": {"maxOutputTokens": maxt},
        },
        "parse": lambda response: response.json()["candidates"][0]["content"]["parts"][0]["text"],
    },
}


class LLMRouter:
    def __init__(self):
        self.client = httpx.AsyncClient(timeout=30.0, trust_env=False)
        self.store = MemoryStore()
        self.system_prompt = """你是小米 memo，一位克制、真诚、有音乐审美的私人电台主播。
规则：
1. 只输出主播会真实说出口的话，不写标题、解释、括号或舞台提示。
2. 不说“推荐”“我喜欢这首歌”“接下来请听”这类机械句。
3. 不评价用户品味，不暴露画像、算法、选曲依据。
4. 用具体画面、声音质感、情绪转折来连接音乐。
5. 语言短一点，像电台，不像广告文案。"""

    async def chat(
        self,
        user_msg: str,
        max_tokens: int = 300,
        system: str | None = None,
    ) -> str:
        messages = [
            {"role": "system", "content": system or self.system_prompt},
            {"role": "user", "content": user_msg},
        ]

        provider_order = [settings.llm_provider]
        if settings.llm_fallback_provider != settings.llm_provider:
            provider_order.append(settings.llm_fallback_provider)

        budget_ok = await self.store.check_token_budget()
        last_error: Exception | None = None

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

                response = await self.client.post(
                    url,
                    headers=cfg["headers"](),
                    json=cfg["body"](messages, max_tokens),
                    timeout=15.0,
                )
                if response.status_code == 200:
                    result = cfg["parse"](response)
                    if not result or _is_provider_rejection(result):
                        last_error = RuntimeError(f"{provider} rejected generation")
                        continue
                    usage = response.json().get("usage", {})
                    tokens = usage.get("total_tokens", max_tokens)
                    await self.store.add_tokens(tokens)
                    return result
                last_error = RuntimeError(f"{provider} returned HTTP {response.status_code}")
            except Exception as error:
                last_error = error
                continue

        raise RuntimeError("all LLM providers failed") from last_error

    async def close(self):
        await self.client.aclose()
