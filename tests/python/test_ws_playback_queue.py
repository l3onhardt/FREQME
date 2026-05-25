import unittest

from backend.api.ws import _prepare_queue_item


class FakeResolver:
    async def resolve_with_candidates(self, song, uid=None):
        class Result:
            ok = True
            song_id = "42"
            proxy_url = "/api/radio/audio/42"

        return Result()


class FakeCandidateResolver:
    async def resolve_with_candidates(self, song, uid=None):
        class Result:
            ok = True
            song_id = "candidate"
            proxy_url = "/api/radio/audio/candidate"

        return Result()


class WsPlaybackQueueTests(unittest.IsolatedAsyncioTestCase):
    async def test_prepare_queue_item_uses_proxy_url(self):
        song, url = await _prepare_queue_item(FakeResolver(), {"id": "42"}, "u1")

        self.assertEqual(song["id"], "42")
        self.assertEqual(url, "/api/radio/audio/42")

    async def test_prepare_queue_item_keeps_track_id_aligned_with_resolved_audio(self):
        original = {
            "id": "original",
            "name": "Song",
            "ar": [{"name": "Artist"}],
        }

        song, url = await _prepare_queue_item(FakeCandidateResolver(), original, "u1")

        self.assertEqual(song["id"], "candidate")
        self.assertEqual(original["id"], "original")
        self.assertEqual(song["name"], "Song")
        self.assertEqual(url, "/api/radio/audio/candidate")
