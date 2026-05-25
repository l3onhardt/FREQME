import unittest

from backend.adapters.llm_router import LLMRouter


class FakeStore:
    async def check_token_budget(self):
        return True


class FailingClient:
    async def post(self, *args, **kwargs):
        raise RuntimeError("provider unavailable")

    async def aclose(self):
        pass


class LLMRouterNoTemplateFallbackTests(unittest.IsolatedAsyncioTestCase):
    async def test_chat_raises_when_all_providers_fail_instead_of_returning_template(self):
        router = LLMRouter()
        router.store = FakeStore()
        router.client = FailingClient()

        with self.assertRaises(RuntimeError):
            await router.chat("请生成电台串场", max_tokens=80)
