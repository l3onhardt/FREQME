import unittest

from backend.api.ws import _prepare_queue_item


class FakeResolver:
    async def resolve_with_candidates(self, song, uid=None):
        class Result:
            ok = True
            proxy_url = "/api/radio/audio/42"

        return Result()


class WsPlaybackQueueTests(unittest.IsolatedAsyncioTestCase):
    async def test_prepare_queue_item_uses_proxy_url(self):
        song, url = await _prepare_queue_item(FakeResolver(), {"id": "42"}, "u1")

        self.assertEqual(song["id"], "42")
        self.assertEqual(url, "/api/radio/audio/42")
