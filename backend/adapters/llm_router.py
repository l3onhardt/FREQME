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


def _mimo_retry_tokens(max_tokens: int) -> int:
    return min(max(max_tokens * 3, max_tokens + 360), 1200)


def _should_retry_mimo_response(response) -> bool:
    try:
        data = response.json()
    except Exception:
        return False
    choice = (data.get("choices") or [{}])[0]
    usage = data.get("usage") or {}
    details = usage.get("completion_tokens_details") or {}
    content = ((choice.get("message") or {}).get("content") or "").strip()
    if choice.get("finish_reason") == "length":
        return True
    return not content and details.get("reasoning_tokens", 0) > 0


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


def _settings_for_provider(provider: str, is_fallback: bool) -> dict:
    model = settings.llm_fallback_model if is_fallback else settings.llm_model
    api_key = settings.llm_fallback_api_key if is_fallback else settings.llm_api_key
    if provider == "mimo" and not api_key:
        api_key = settings.mimo_api_key
    return {
        "model": model,
        "api_key": api_key,
        "base_url": settings.llm_api_base,
    }


PROVIDERS = {
    "mimo": {
        "url": "dynamic",
        "headers": lambda cfg: {
            "api-key": cfg["api_key"],
            "Content-Type": "application/json",
        },
        "body": lambda msgs, maxt, cfg, response_format: {
            "model": cfg["model"],
            "max_tokens": maxt,
            "messages": msgs,
            **({"response_format": response_format} if response_format else {}),
        },
        "parse": lambda response: response.json()["choices"][0]["message"]["content"],
        "base_url": lambda cfg: f"{cfg['base_url'].rstrip('/')}/chat/completions",
    },
    "anthropic": {
        "url": "https://api.anthropic.com/v1/messages",
        "headers": lambda cfg: {
            "x-api-key": cfg["api_key"],
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
        },
        "body": lambda msgs, maxt, cfg, response_format: {
            "model": cfg["model"],
            "max_tokens": maxt,
            "messages": msgs,
        },
        "parse": lambda response: response.json()["content"][0]["text"],
    },
    "openai": {
        "url": "https://api.openai.com/v1/chat/completions",
        "headers": lambda cfg: {
            "Authorization": f"Bearer {cfg['api_key']}",
            "content-type": "application/json",
        },
        "body": lambda msgs, maxt, cfg, response_format: {
            "model": cfg["model"],
            "messages": msgs,
            "max_tokens": maxt,
            **({"response_format": response_format} if response_format else {}),
        },
        "parse": lambda response: response.json()["choices"][0]["message"]["content"],
    },
    "gemini": {
        "url": lambda cfg: (
            "https://generativelanguage.googleapis.com/v1beta/models/"
            f"{cfg['model']}:generateContent?key={cfg['api_key']}"
        ),
        "headers": lambda cfg: {"content-type": "application/json"},
        "body": lambda msgs, maxt, cfg, response_format: {
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
        self.system_prompt = """你是 FREQME，一位克制、真诚、有音乐审美的私人电台主播。
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
        response_format: dict | None = None,
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
                provider_settings = _settings_for_provider(
                    provider,
                    is_fallback=provider == settings.llm_fallback_provider
                    and provider != settings.llm_provider,
                )
                url = cfg["url"]
                if url == "dynamic":
                    url = cfg["base_url"](provider_settings)
                elif callable(url):
                    url = url(provider_settings)

                request_tokens = max_tokens
                response = None
                for attempt in range(3):
                    response = await self.client.post(
                        url,
                        headers=cfg["headers"](provider_settings),
                        json=cfg["body"](messages, request_tokens, provider_settings, response_format),
                        timeout=25.0 if attempt else 15.0,
                    )
                    if (
                        provider != "mimo"
                        or response.status_code != 200
                        or not _should_retry_mimo_response(response)
                    ):
                        break
                    next_tokens = _mimo_retry_tokens(request_tokens)
                    if next_tokens <= request_tokens:
                        break
                    request_tokens = next_tokens
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
