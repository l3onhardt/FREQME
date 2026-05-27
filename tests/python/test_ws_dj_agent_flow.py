import unittest
from contextlib import asynccontextmanager
from types import SimpleNamespace
from unittest import mock

import httpx
from fastapi import FastAPI

from tests.python.test_ws_user_settings import (
    FakeCompressor,
    FakeDJEngine,
    FakeScheduler,
    FakeStore,
    FakeTTS,
    FakeWebSocket,
)


class FailingLegacyAgent:
    async def resolve(self, *args, **kwargs):
        raise AssertionError("legacy request agent should not be called")


class FailingLegacyBrain:
    def interpret_user_text(self, *args, **kwargs):
        raise AssertionError("legacy radio brain should not be called")


class RecordingCompressor(FakeCompressor):
    def get_context(self):
        return [{"speaker": "user", "text": "previous turn"}]


class FakeQueueDirector:
    def __init__(self, status="queued", dj_text="I queued the verified song.", song=None):
        self.status = status
        self.dj_text = dj_text
        self.song = song or {
            "id": "verified-radiohead",
            "name": "Weird Fishes",
            "artist": "Radiohead",
        }
        self.calls = []

    async def handle_song_request(self, **kwargs):
        self.calls.append(kwargs)
        if self.status == "queued":
            kwargs["playback_queue"].clear_ready()
            kwargs["playback_queue"].add_ready(
                self.song,
                "/audio/verified-radiohead",
                {
                    "type": "dj_agent_verified",
                    "text": "Verified Radiohead match",
                },
            )
        return SimpleNamespace(
            status=self.status,
            dj_text=self.dj_text,
            next_song=self.song if self.status == "queued" else None,
            url="/audio/verified-radiohead" if self.status == "queued" else "",
        )


class RaisingQueueDirector:
    def __init__(self):
        self.calls = []

    async def handle_song_request(self, **kwargs):
        self.calls.append(kwargs)
        raise RuntimeError("director unavailable")


class WSDJAgentFlowTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        from backend.api import auth, ws

        self.originals = {
            "store": ws.store,
            "dj_engine": ws.dj_engine,
            "tts": ws.tts,
            "scheduler": ws.scheduler,
            "compressor": ws.compressor,
            "profile_engine": ws.profile_engine,
            "audio_resolver": ws.audio_resolver,
            "request_agent": ws.request_agent,
            "radio_brain": ws.radio_brain,
            "dj_request_agent": ws.dj_request_agent,
            "search_verify_agent": ws.search_verify_agent,
            "queue_director": ws.queue_director,
            "dj_memory_manager": ws.dj_memory_manager,
            "auth_netease": auth.netease,
        }
        self.addCleanup(self._restore_ws_globals)

    def _restore_ws_globals(self):
        from backend.api import auth, ws

        for name, value in self.originals.items():
            if name == "auth_netease":
                auth.netease = value
            else:
                setattr(ws, name, value)

    async def _run_with_director(self, director, request_text):
        from backend.api import ws

        fake_websocket = FakeWebSocket([
            {"type": "handshake", "uid": "42", "settings": {}},
            {"type": "song_request", "text": request_text},
        ])

        ws.store = FakeStore({"voice_preset": "warm_male"})
        ws.dj_engine = FakeDJEngine()
        ws.tts = FakeTTS()
        ws.scheduler = FakeScheduler()
        ws.compressor = RecordingCompressor()
        ws.profile_engine = None
        ws.audio_resolver = None
        ws.queue_director = director
        ws.request_agent = FailingLegacyAgent()
        ws.radio_brain = FailingLegacyBrain()

        await ws.ws_handler(fake_websocket)
        return fake_websocket

    def test_ws_exposes_dj_request_service_globals(self):
        from backend.api import ws

        self.assertTrue(hasattr(ws, "dj_request_agent"))
        self.assertTrue(hasattr(ws, "search_verify_agent"))
        self.assertTrue(hasattr(ws, "queue_director"))
        self.assertTrue(hasattr(ws, "dj_memory_manager"))

    async def test_lifespan_wires_dj_request_services_to_ws_globals(self):
        from backend.api import ws
        import backend.main as main
        from backend.engines.dj_request_agent import DJRequestAgent
        from backend.engines.queue_director import QueueDirector
        from backend.engines.search_verify_agent import SearchVerifyAgent
        from backend.memory.dj_memory import DJMemoryManager

        class FakeHTTPResponse:
            status_code = 200

        async def noop_async(*args, **kwargs):
            return None

        class FakeClosable:
            async def close(self):
                return None

        for name in (
            "dj_request_agent",
            "search_verify_agent",
            "queue_director",
            "dj_memory_manager",
        ):
            setattr(ws, name, None)

        app = FastAPI()
        with (
            mock.patch.object(httpx, "get", return_value=FakeHTTPResponse()),
            mock.patch.object(main, "init_db", side_effect=noop_async),
            mock.patch.object(main, "NeteaseAdapter", return_value=FakeClosable()),
            mock.patch.object(main, "LLMRouter", return_value=FakeClosable()),
            mock.patch.object(main, "TTSAdapter", return_value=FakeClosable()),
        ):
            async with asynccontextmanager(main.lifespan)(app):
                self.assertIsInstance(ws.dj_memory_manager, DJMemoryManager)
                self.assertIsInstance(ws.dj_request_agent, DJRequestAgent)
                self.assertIsInstance(ws.search_verify_agent, SearchVerifyAgent)
                self.assertIsInstance(ws.queue_director, QueueDirector)

    async def test_song_request_uses_queue_director_not_radio_brain_or_old_request_agent(self):
        from backend.api import ws

        director = FakeQueueDirector(dj_text="I'll line up the verified Radiohead track.")
        request_text = "不能放点radiohead的吗"

        fake_websocket = await self._run_with_director(director, request_text)

        self.assertEqual(len(director.calls), 1)
        call = director.calls[0]
        self.assertEqual(call["request_text"], request_text)
        self.assertEqual(call["uid"], "42")
        self.assertEqual(call["session_id"], 7)
        self.assertIsInstance(call["playback_context"], dict)
        self.assertEqual(call["playback_context"]["current_track"]["id"], "first")
        self.assertTrue(call["playback_context"]["ready_queue"])
        self.assertEqual(call["recent_turns"], [{"speaker": "user", "text": "previous turn"}])
        self.assertEqual(ws.scheduler.intent_updates, [])

        dj_messages = [
            payload for payload in fake_websocket.sent
            if payload["type"] == "dj_message"
        ]
        self.assertEqual(dj_messages[0]["text"], "I'll line up the verified Radiohead track.")
        request_status = next(
            payload for payload in fake_websocket.sent
            if payload["type"] == "request_status"
        )
        self.assertEqual(request_status["status"], "ready")
        self.assertEqual(request_status["next_track"]["id"], "verified-radiohead")
        self.assertNotIn(request_text, request_status["text"])

    async def test_song_request_director_failure_does_not_quote_raw_sentence(self):
        from backend.api import ws

        request_text = "不能放点radiohead的吗"
        director = FakeQueueDirector(
            status="needs_recovery",
            dj_text="I could not safely verify a playable match.",
        )

        fake_websocket = await self._run_with_director(director, request_text)

        self.assertEqual(len(director.calls), 1)
        self.assertEqual(ws.scheduler.intent_updates, [])
        request_status = next(
            payload for payload in fake_websocket.sent
            if payload["type"] == "request_status"
        )
        self.assertEqual(request_status["status"], "not_found")
        self.assertEqual(request_status["text"], "I could not safely verify a playable match.")
        self.assertNotIn(request_text, request_status["text"])

    async def test_song_request_context_has_empty_current_track_before_playback(self):
        from backend.api import ws

        director = FakeQueueDirector(status="ask", dj_text="Which version do you mean?")
        request_text = "radiohead"
        fake_websocket = FakeWebSocket([
            {"type": "song_request", "text": request_text},
        ])

        ws.store = FakeStore({"voice_preset": "warm_male"})
        ws.dj_engine = FakeDJEngine()
        ws.tts = FakeTTS()
        ws.scheduler = FakeScheduler()
        ws.compressor = RecordingCompressor()
        ws.profile_engine = None
        ws.audio_resolver = None
        ws.queue_director = director
        ws.request_agent = FailingLegacyAgent()
        ws.radio_brain = FailingLegacyBrain()

        await ws.ws_handler(fake_websocket)

        self.assertEqual(len(director.calls), 1)
        current_track = director.calls[0]["playback_context"]["current_track"]
        self.assertIsInstance(current_track, dict)
        self.assertEqual(current_track, {})

    async def test_song_request_director_status_filters_spaced_raw_request_variant(self):
        request_text = "不能放点radiohead的吗"
        spaced_variant = "不能 放点 radiohead 的吗"
        director = FakeQueueDirector(
            status="needs_recovery",
            dj_text=spaced_variant,
        )

        fake_websocket = await self._run_with_director(director, request_text)

        texts = [
            payload["text"]
            for payload in fake_websocket.sent
            if payload["type"] in {"dj_message", "request_status"}
        ]
        self.assertTrue(texts)
        self.assertFalse(any(spaced_variant in text for text in texts))
        self.assertFalse(any(request_text in text for text in texts))
        request_status = next(
            payload for payload in fake_websocket.sent
            if payload["type"] == "request_status"
        )
        self.assertEqual(request_status["status"], "not_found")
        self.assertEqual(request_status["text"], "I could not safely verify a playable match.")

    async def test_song_request_director_exception_returns_safe_not_found(self):
        request_text = "不能放点radiohead的吗"
        director = RaisingQueueDirector()

        fake_websocket = await self._run_with_director(director, request_text)

        self.assertEqual(len(director.calls), 1)
        request_status = next(
            payload for payload in fake_websocket.sent
            if payload["type"] == "request_status"
        )
        self.assertEqual(request_status["status"], "not_found")
        self.assertEqual(request_status["text"], "I could not safely verify a playable match.")
        self.assertNotIn(request_text, request_status["text"])

    async def test_song_request_director_ask_does_not_clear_existing_ready_queue(self):
        from backend.api import ws

        class AskThenEndWebSocket(FakeWebSocket):
            async def iter_text(self):
                yield self.messages[0]
                yield self.messages[1]
                yield self.messages[2]

        request_text = "你说的是哪版来着"
        director = FakeQueueDirector(status="ask", dj_text="Which version do you mean?")
        fake_websocket = AskThenEndWebSocket([
            {"type": "handshake", "uid": "42", "settings": {}},
            {"type": "song_request", "text": request_text},
            {"type": "track_ended"},
        ])

        ws.store = FakeStore({"voice_preset": "warm_male"})
        ws.dj_engine = FakeDJEngine()
        ws.tts = FakeTTS()
        ws.scheduler = FakeScheduler()
        ws.compressor = RecordingCompressor()
        ws.profile_engine = None
        ws.audio_resolver = None
        ws.queue_director = director
        ws.request_agent = FailingLegacyAgent()
        ws.radio_brain = FailingLegacyBrain()

        await ws.ws_handler(fake_websocket)

        self.assertEqual(len(director.calls), 1)
        ready_ids = [
            track["id"]
            for track in director.calls[0]["playback_context"]["ready_queue"]
        ]
        self.assertIn("second", ready_ids)
        request_status = next(
            payload for payload in fake_websocket.sent
            if payload["type"] == "request_status"
        )
        self.assertEqual(request_status["status"], "needs_clarification")
        played_ids = [
            payload["track"]["id"]
            for payload in fake_websocket.sent
            if payload["type"] == "play_track"
        ]
        self.assertIn("second", played_ids)


if __name__ == "__main__":
    unittest.main()
