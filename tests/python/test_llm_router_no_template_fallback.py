import unittest

from backend.adapters import llm_router as llm_router_module
from backend.adapters.llm_router import LLMRouter


class FakeStore:
    async def check_token_budget(self):
        return True

    async def add_tokens(self, tokens):
        self.tokens = tokens


class FailingClient:
    async def post(self, *args, **kwargs):
        raise RuntimeError("provider unavailable")

    async def aclose(self):
        pass


class RejectionClient:
    async def post(self, *args, **kwargs):
        class Response:
            status_code = 200

            def json(self):
                return {
                    "choices": [{
                        "message": {
                            "content": "The request was rejected because it was considered high risk",
                        },
                    }],
                    "usage": {"total_tokens": 8},
                }

        return Response()

    async def aclose(self):
        pass


class EmptyMimoThenContentClient:
    def __init__(self):
        self.urls = []
        self.max_tokens = []

    async def post(self, url, *args, **kwargs):
        self.urls.append(url)
        self.max_tokens.append(kwargs["json"]["max_tokens"])

        class Response:
            status_code = 200

            def __init__(self, content, finish_reason, total_tokens):
                self.content = content
                self.finish_reason = finish_reason
                self.total_tokens = total_tokens

            def json(self):
                return {
                    "choices": [{
                        "finish_reason": self.finish_reason,
                        "message": {
                            "content": self.content,
                            "reasoning_content": "thinking",
                        },
                    }],
                    "usage": {"total_tokens": self.total_tokens},
                }

        if len(self.urls) == 1:
            return Response("", "length", 180)
        return Response("有风从窗边过去，我们从这一首开始。", "stop", 42)

    async def aclose(self):
        pass


class TruncatedMimoThenContentClient(EmptyMimoThenContentClient):
    async def post(self, url, *args, **kwargs):
        self.urls.append(url)
        self.max_tokens.append(kwargs["json"]["max_tokens"])

        class Response:
            status_code = 200

            def __init__(self, content, finish_reason, total_tokens):
                self.content = content
                self.finish_reason = finish_reason
                self.total_tokens = total_tokens

            def json(self):
                return {
                    "choices": [{
                        "finish_reason": self.finish_reason,
                        "message": {
                            "content": self.content,
                            "reasoning_content": "thinking",
                        },
                    }],
                    "usage": {"total_tokens": self.total_tokens},
                }

        if len(self.urls) == 1:
            return Response("夜深了，我把灯光调暗，", "length", 180)
        return Response("夜深了，我把灯光调暗一点，我们从这首歌慢慢进去。", "stop", 42)


class TwiceTruncatedMimoThenContentClient(TruncatedMimoThenContentClient):
    async def post(self, url, *args, **kwargs):
        self.urls.append(url)
        self.max_tokens.append(kwargs["json"]["max_tokens"])

        class Response:
            status_code = 200

            def __init__(self, content, finish_reason, total_tokens):
                self.content = content
                self.finish_reason = finish_reason
                self.total_tokens = total_tokens

            def json(self):
                return {
                    "choices": [{
                        "finish_reason": self.finish_reason,
                        "message": {
                            "content": self.content,
                            "reasoning_content": "thinking",
                        },
                    }],
                    "usage": {"total_tokens": self.total_tokens},
                }

        if len(self.urls) < 3:
            return Response("", "length", self.max_tokens[-1])
        return Response("这一组声音先收束在这里，下一首我们慢慢往前走。", "stop", 42)


class LLMRouterNoTemplateFallbackTests(unittest.IsolatedAsyncioTestCase):
    async def test_chat_raises_when_all_providers_fail_instead_of_returning_template(self):
        router = LLMRouter()
        router.store = FakeStore()
        router.client = FailingClient()

        with self.assertRaises(RuntimeError):
            await router.chat("请生成电台串场", max_tokens=80)

    async def test_chat_treats_provider_rejection_text_as_failure(self):
        router = LLMRouter()
        router.store = FakeStore()
        router.client = RejectionClient()

        with self.assertRaises(RuntimeError):
            await router.chat("请生成电台开场", max_tokens=80)

    async def test_chat_retries_mimo_with_more_tokens_when_reasoning_uses_budget(self):
        router = LLMRouter()
        router.store = FakeStore()
        client = EmptyMimoThenContentClient()
        router.client = client

        result = await router.chat("请生成电台开场白", max_tokens=180)

        self.assertEqual(result, "有风从窗边过去，我们从这一首开始。")
        self.assertEqual(len(client.urls), 2)
        self.assertEqual(
            client.urls,
            [f"{llm_router_module.settings.llm_api_base.rstrip('/')}/chat/completions"] * 2,
        )
        self.assertEqual(client.max_tokens[0], 180)
        self.assertGreater(client.max_tokens[1], client.max_tokens[0])

    async def test_chat_retries_mimo_when_content_is_truncated_by_length(self):
        router = LLMRouter()
        router.store = FakeStore()
        client = TruncatedMimoThenContentClient()
        router.client = client

        result = await router.chat("请生成电台开场白", max_tokens=180)

        self.assertEqual(result, "夜深了，我把灯光调暗一点，我们从这首歌慢慢进去。")
        self.assertEqual(len(client.urls), 2)
        self.assertGreater(client.max_tokens[1], client.max_tokens[0])

    async def test_chat_can_retry_mimo_more_than_once_when_reasoning_still_uses_budget(self):
        router = LLMRouter()
        router.store = FakeStore()
        client = TwiceTruncatedMimoThenContentClient()
        router.client = client

        result = await router.chat("请生成电台开场白", max_tokens=180)

        self.assertEqual(result, "这一组声音先收束在这里，下一首我们慢慢往前走。")
        self.assertEqual(len(client.urls), 3)
        self.assertEqual(client.max_tokens, [180, 540, 1200])
