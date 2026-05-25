import unittest
from unittest.mock import patch

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

    async def test_track_proxy_forwards_range_header_to_upstream(self):
        captured = {}

        class FakeUpstream:
            status_code = 206
            headers = {
                "content-type": "audio/mpeg",
                "content-range": "bytes 10-19/100",
                "content-length": "10",
            }

            async def aiter_bytes(self):
                yield b"0123456789"

            async def aclose(self):
                pass

        class FakeClient:
            async def send(self, request, stream=False):
                captured["range"] = request.headers.get("range")
                captured["stream"] = stream
                return FakeUpstream()

            def build_request(self, method, url, headers=None):
                class Request:
                    pass

                request = Request()
                request.method = method
                request.url = url
                request.headers = headers or {}
                return request

            async def aclose(self):
                pass

        with patch.object(radio.httpx, "AsyncClient", return_value=FakeClient()):
            response = await radio.get_audio_proxy(
                "42",
                range_header="bytes=10-19",
            )

        self.assertEqual(captured["range"], "bytes=10-19")
        self.assertTrue(captured["stream"])
        self.assertEqual(response.status_code, 206)
        self.assertEqual(response.headers["content-range"], "bytes 10-19/100")
