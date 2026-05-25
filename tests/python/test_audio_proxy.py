import unittest

from backend.api import radio


class FakeResolver:
    async def resolve_with_candidates(self, song, uid=None):
        class Result:
            ok = True
            url = "https://example.test/audio.mp3"
            content_type = "audio/mpeg"
            reason = ""

        return Result()


class AudioProxyTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.original_resolver = getattr(radio, "audio_resolver", None)
        radio.audio_resolver = FakeResolver()
        self.addCleanup(lambda: setattr(radio, "audio_resolver", self.original_resolver))

    async def test_track_proxy_returns_error_when_fetch_fails(self):
        response = await radio.get_audio_proxy("42")

        self.assertEqual(response.status_code, 502)
