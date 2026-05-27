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


class RefreshingResolver:
    def __init__(self):
        self.calls = []
        self.store = None

    async def resolve_with_candidates(self, song, uid=None, force_refresh=False):
        self.calls.append({
            "song": song,
            "uid": uid,
            "force_refresh": force_refresh,
        })

        class Result:
            ok = True
            content_type = "audio/mpeg"
            reason = ""

            def __init__(self, url):
                self.url = url

        return Result(
            "https://example.test/fresh.mp3"
            if force_refresh
            else "https://example.test/expired.mp3"
        )


class RecordingStore:
    def __init__(self):
        self.events = []

    async def log_playback_event(self, event_type, song_id=None, uid=None, reason=""):
        self.events.append({
            "event_type": event_type,
            "song_id": song_id,
            "uid": uid,
            "reason": reason,
        })


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

    async def test_track_proxy_refreshes_resolution_once_when_cached_url_is_forbidden(self):
        resolver = RefreshingResolver()
        radio.audio_resolver = resolver
        requested_urls = []

        class FakeUpstream:
            def __init__(self, status_code):
                self.status_code = status_code
                self.headers = {"content-type": "audio/mpeg"}
                self.closed = False

            async def aiter_bytes(self):
                yield b"fresh audio"

            async def aclose(self):
                self.closed = True

        class FakeClient:
            def build_request(self, method, url, headers=None):
                class Request:
                    pass

                request = Request()
                request.method = method
                request.url = url
                request.headers = headers or {}
                return request

            async def send(self, request, stream=False):
                requested_urls.append(str(request.url))
                if str(request.url).endswith("expired.mp3"):
                    return FakeUpstream(403)
                return FakeUpstream(206)

            async def aclose(self):
                pass

        with patch.object(radio.httpx, "AsyncClient", return_value=FakeClient()):
            response = await radio.get_audio_proxy(
                "42",
                range_header="bytes=0-1023",
            )

        self.assertEqual(response.status_code, 206)
        self.assertEqual(
            [call["force_refresh"] for call in resolver.calls],
            [False, True],
        )
        self.assertEqual(
            requested_urls,
            [
                "https://example.test/expired.mp3",
                "https://example.test/fresh.mp3",
            ],
        )

    async def test_track_proxy_records_playback_failure_when_refreshed_url_still_fails(self):
        resolver = RefreshingResolver()
        resolver.store = RecordingStore()
        radio.audio_resolver = resolver

        class FakeUpstream:
            status_code = 403
            headers = {"content-type": "audio/mpeg"}

            async def aiter_bytes(self):
                yield b""

            async def aclose(self):
                pass

        class FakeClient:
            def build_request(self, method, url, headers=None):
                class Request:
                    pass

                request = Request()
                request.method = method
                request.url = url
                request.headers = headers or {}
                return request

            async def send(self, request, stream=False):
                return FakeUpstream()

            async def aclose(self):
                pass

        with patch.object(radio.httpx, "AsyncClient", return_value=FakeClient()):
            response = await radio.get_audio_proxy("42")

        self.assertEqual(response.status_code, 502)
        self.assertEqual(
            resolver.store.events,
            [{
                "event_type": "playback_failed",
                "song_id": "42",
                "uid": None,
                "reason": '{"error":"upstream 403"}',
            }],
        )

    async def test_track_proxy_rejects_html_upstream_as_unplayable(self):
        closed = {"upstream": False, "client": False}

        class FakeUpstream:
            status_code = 200
            headers = {"content-type": "text/html;charset=utf8"}

            async def aiter_bytes(self):
                yield b"<html>not audio</html>"

            async def aclose(self):
                closed["upstream"] = True

        class FakeClient:
            def build_request(self, method, url, headers=None):
                return object()

            async def send(self, request, stream=False):
                return FakeUpstream()

            async def aclose(self):
                closed["client"] = True

        with patch.object(radio.httpx, "AsyncClient", return_value=FakeClient()):
            response = await radio.get_audio_proxy("42")

        self.assertEqual(response.status_code, 502)
        self.assertTrue(closed["upstream"])
        self.assertTrue(closed["client"])
