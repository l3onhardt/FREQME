import unittest

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
