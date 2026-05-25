import json
import unittest

from backend.api import auth, ws


class FakeWebSocket:
    def __init__(self, messages):
        self.messages = [json.dumps(message) for message in messages]
        self.sent = []
        self.accepted = False

    async def accept(self):
        self.accepted = True

    async def iter_text(self):
        for message in self.messages:
            yield message

    async def send_json(self, payload):
        self.sent.append(payload)


class FakeStore:
    def __init__(self, stored_settings):
        self.stored_settings = stored_settings
        self.logged_tracks = []

    async def get_user_settings(self, uid):
        return self.stored_settings

    async def get_profile(self, uid):
        return {
            "personality": {"traits": ["calm"]},
            "dj_style_suggestion": "natural",
        }

    async def create_session(self, uid):
        return 7

    async def log_track(self, track_id, name, artist, source, uid=None):
        self.logged_tracks.append((track_id, name, artist, source, uid))


class FakeDJEngine:
    def __init__(self):
        self.intro_calls = []
        self.segue_calls = []

    def detect_scene(self, utc_offset):
        return "daily"

    async def generate_intro(self, profile, scene, user_settings=None):
        self.intro_calls.append({
            "profile": profile,
            "scene": scene,
            "user_settings": user_settings,
        })
        return "intro"

    async def generate_segue(
        self,
        profile,
        scene,
        current_song,
        next_song,
        context,
        user_settings=None,
    ):
        self.segue_calls.append({
            "profile": profile,
            "scene": scene,
            "current_song": current_song,
            "next_song": next_song,
            "user_settings": user_settings,
        })
        return "segue"


class FailingIntroDJEngine(FakeDJEngine):
    async def generate_intro(self, profile, scene, user_settings=None):
        self.intro_calls.append({
            "profile": profile,
            "scene": scene,
            "user_settings": user_settings,
        })
        raise RuntimeError("llm unavailable")


class FakeTTS:
    def __init__(self):
        self.synthesize_calls = []
        self.hash_calls = []

    async def synthesize(
        self,
        text,
        style="daily",
        voice_preset=None,
        user_settings=None,
    ):
        self.synthesize_calls.append({
            "text": text,
            "style": style,
            "voice_preset": voice_preset,
            "user_settings": user_settings,
        })
        return b"audio"

    def _hash(self, text, style, voice_preset=None, user_settings=None):
        self.hash_calls.append({
            "text": text,
            "style": style,
            "voice_preset": voice_preset,
            "user_settings": user_settings,
        })
        return f"hash-{text}"


class FailingSegueTTS(FakeTTS):
    async def synthesize(
        self,
        text,
        style="daily",
        voice_preset=None,
        user_settings=None,
    ):
        self.synthesize_calls.append({
            "text": text,
            "style": style,
            "voice_preset": voice_preset,
            "user_settings": user_settings,
        })
        if text == "segue":
            raise RuntimeError("tts unavailable")
        return b"audio"


class FakeScheduler:
    def __init__(self):
        self.pick_next_calls = []
        self.session_states = []
        self.songs = [
            {"id": "first", "name": "First Song", "ar": [{"name": "First Artist"}]},
            {"id": "second", "name": "Second Song", "ar": [{"name": "Second Artist"}]},
        ]

    def new_session_state(self):
        state = {"fake_scheduler_state": len(self.session_states) + 1}
        self.session_states.append(state)
        return state

    async def pick_next(
        self,
        current_song_id=None,
        profile=None,
        user_settings=None,
        session_state=None,
        uid=None,
    ):
        self.pick_next_calls.append({
            "current_song_id": current_song_id,
            "profile": profile,
            "user_settings": user_settings,
            "session_state": session_state,
            "uid": uid,
        })
        return self.songs.pop(0)

    async def get_song_url(self, song):
        return f"https://example.test/{song['id']}.mp3"


class FakeCompressor:
    def __init__(self):
        self.rounds = []

    def add_round(self, payload):
        self.rounds.append(payload)


class WebSocketUserSettingsTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.originals = {
            "store": ws.store,
            "dj_engine": ws.dj_engine,
            "tts": ws.tts,
            "scheduler": ws.scheduler,
            "compressor": ws.compressor,
            "profile_engine": ws.profile_engine,
            "auth_netease": auth.netease,
        }
        self.addCleanup(self._restore_ws_globals)

    def _restore_ws_globals(self):
        for name, value in self.originals.items():
            if name == "auth_netease":
                auth.netease = value
            else:
                setattr(ws, name, value)

    async def test_ws_session_passes_stored_user_settings_to_intro_first_song_and_skip(self):
        stored_settings = {
            "voice_preset": "bright_girl",
            "display_name": "Saved Name",
            "current_mode": "focus",
        }
        handshake_settings = {
            "voice_preset": "warm_male",
            "display_name": "Handshake Name",
        }
        fake_store = FakeStore(stored_settings)
        fake_dj = FakeDJEngine()
        fake_tts = FakeTTS()
        fake_scheduler = FakeScheduler()
        fake_websocket = FakeWebSocket([
            {"type": "handshake", "uid": "42", "settings": handshake_settings},
            {"type": "skip"},
        ])

        ws.store = fake_store
        ws.dj_engine = fake_dj
        ws.tts = fake_tts
        ws.scheduler = fake_scheduler
        ws.compressor = FakeCompressor()
        ws.profile_engine = None

        await ws.ws_handler(fake_websocket)

        self.assertTrue(fake_websocket.accepted)
        self.assertEqual(fake_dj.intro_calls[0]["user_settings"], stored_settings)
        self.assertEqual(fake_tts.synthesize_calls[0]["user_settings"], stored_settings)
        self.assertEqual(fake_tts.synthesize_calls[0]["voice_preset"], "bright_girl")
        self.assertEqual(fake_scheduler.pick_next_calls[0]["user_settings"], stored_settings)
        self.assertEqual(fake_scheduler.pick_next_calls[0]["uid"], "42")
        self.assertEqual(fake_scheduler.pick_next_calls[0]["profile"], fake_dj.intro_calls[0]["profile"])
        self.assertEqual(fake_scheduler.pick_next_calls[1]["current_song_id"], "first")
        self.assertEqual(fake_scheduler.pick_next_calls[1]["user_settings"], stored_settings)
        self.assertEqual(fake_scheduler.pick_next_calls[1]["uid"], "42")
        self.assertEqual(fake_scheduler.pick_next_calls[1]["profile"], fake_dj.intro_calls[0]["profile"])
        self.assertEqual(fake_store.logged_tracks[0][-1], "42")
        self.assertEqual(len(fake_scheduler.session_states), 1)
        self.assertIs(
            fake_scheduler.pick_next_calls[0]["session_state"],
            fake_scheduler.session_states[0],
        )
        self.assertIs(
            fake_scheduler.pick_next_calls[1]["session_state"],
            fake_scheduler.session_states[0],
        )
        self.assertEqual(fake_dj.segue_calls[0]["user_settings"], stored_settings)
        self.assertEqual(fake_tts.synthesize_calls[1]["user_settings"], stored_settings)
        self.assertEqual(fake_tts.synthesize_calls[1]["voice_preset"], "bright_girl")
        self.assertEqual(fake_tts.hash_calls[1]["user_settings"], stored_settings)
        self.assertEqual(fake_tts.hash_calls[1]["voice_preset"], "bright_girl")
        self.assertNotEqual(fake_dj.intro_calls[0]["user_settings"], handshake_settings)

    async def test_ws_skip_uses_prewarmed_llm_segue_without_waiting_for_new_inference(self):
        fake_store = FakeStore({"voice_preset": "warm_male"})
        fake_dj = FakeDJEngine()
        fake_tts = FakeTTS()
        fake_scheduler = FakeScheduler()

        class CheckpointWebSocket(FakeWebSocket):
            async def iter_text(self):
                yield json.dumps({"type": "handshake", "uid": "42", "settings": {}})
                self.pre_skip_segue_count = len(fake_dj.segue_calls)
                yield json.dumps({"type": "skip"})

        fake_websocket = CheckpointWebSocket([])

        ws.store = fake_store
        ws.dj_engine = fake_dj
        ws.tts = fake_tts
        ws.scheduler = fake_scheduler
        ws.compressor = FakeCompressor()
        ws.profile_engine = None

        await ws.ws_handler(fake_websocket)

        self.assertEqual(fake_websocket.pre_skip_segue_count, 1)
        self.assertEqual(len(fake_dj.segue_calls), 1)
        self.assertEqual(fake_dj.segue_calls[0]["current_song"]["id"], "first")
        self.assertEqual(fake_dj.segue_calls[0]["next_song"]["id"], "second")
        sent_types = [payload["type"] for payload in fake_websocket.sent]
        self.assertIn("segue", sent_types)

    async def test_ws_handshake_does_not_stall_when_llm_intro_is_unavailable(self):
        fake_store = FakeStore({"voice_preset": "warm_male"})
        fake_dj = FailingIntroDJEngine()
        fake_tts = FakeTTS()
        fake_scheduler = FakeScheduler()
        fake_websocket = FakeWebSocket([
            {"type": "handshake", "uid": "42", "settings": {}},
        ])

        ws.store = fake_store
        ws.dj_engine = fake_dj
        ws.tts = fake_tts
        ws.scheduler = fake_scheduler
        ws.compressor = FakeCompressor()
        ws.profile_engine = None

        await ws.ws_handler(fake_websocket)

        sent_types = [payload["type"] for payload in fake_websocket.sent]
        self.assertIn("session_start", sent_types)
        self.assertIn("play_track", sent_types)
        session_start = next(payload for payload in fake_websocket.sent if payload["type"] == "session_start")
        self.assertEqual(session_start["intro_text"], "")
        self.assertFalse(session_start["tts_ready"])

    async def test_ws_sends_intro_message_when_llm_intro_is_available(self):
        fake_store = FakeStore({"voice_preset": "warm_male"})
        fake_dj = FakeDJEngine()
        fake_tts = FakeTTS()
        fake_scheduler = FakeScheduler()
        fake_websocket = FakeWebSocket([
            {"type": "handshake", "uid": "42", "settings": {}},
        ])

        ws.store = fake_store
        ws.dj_engine = fake_dj
        ws.tts = fake_tts
        ws.scheduler = fake_scheduler
        ws.compressor = FakeCompressor()
        ws.profile_engine = None

        await ws.ws_handler(fake_websocket)

        sent_types = [payload["type"] for payload in fake_websocket.sent]
        self.assertIn("session_start", sent_types)
        self.assertIn("play_track", sent_types)
        self.assertIn("intro", sent_types)
        intro = next(payload for payload in fake_websocket.sent if payload["type"] == "intro")
        self.assertEqual(intro["text"], "intro")
        self.assertTrue(intro["tts_ready"])

    async def test_ws_keeps_llm_segue_text_when_tts_for_segue_fails(self):
        fake_store = FakeStore({"voice_preset": "warm_male"})
        fake_dj = FakeDJEngine()
        fake_tts = FailingSegueTTS()
        fake_scheduler = FakeScheduler()
        fake_websocket = FakeWebSocket([
            {"type": "handshake", "uid": "42", "settings": {}},
            {"type": "skip"},
        ])

        ws.store = fake_store
        ws.dj_engine = fake_dj
        ws.tts = fake_tts
        ws.scheduler = fake_scheduler
        ws.compressor = FakeCompressor()
        ws.profile_engine = None

        await ws.ws_handler(fake_websocket)

        segue = next(payload for payload in fake_websocket.sent if payload["type"] == "segue")
        self.assertEqual(segue["text"], "segue")
        self.assertFalse(segue["tts_ready"])
        self.assertEqual(segue["tts_hash"], "")

    async def test_ws_rejects_handshake_uid_that_does_not_match_active_login(self):
        async def login_status():
            return {"data": {"profile": {"userId": 42}}}

        auth.netease = type("FakeAuthNetease", (), {"login_status": staticmethod(login_status)})()
        fake_websocket = FakeWebSocket([
            {"type": "handshake", "uid": "7", "settings": {}},
        ])

        ws.store = FakeStore({})
        ws.dj_engine = FakeDJEngine()
        ws.tts = FakeTTS()
        ws.scheduler = FakeScheduler()
        ws.compressor = FakeCompressor()
        ws.profile_engine = None

        await ws.ws_handler(fake_websocket)

        self.assertEqual(fake_websocket.sent[0]["type"], "error")
        self.assertIn("登录账号", fake_websocket.sent[0]["message"])

    async def test_ws_rejects_handshake_when_active_login_is_missing(self):
        async def login_status():
            return {"data": {"profile": None}}

        auth.netease = type("FakeAuthNetease", (), {"login_status": staticmethod(login_status)})()
        fake_websocket = FakeWebSocket([
            {"type": "handshake", "uid": "42", "settings": {}},
        ])

        ws.store = FakeStore({})
        ws.dj_engine = FakeDJEngine()
        ws.tts = FakeTTS()
        ws.scheduler = FakeScheduler()
        ws.compressor = FakeCompressor()
        ws.profile_engine = None

        await ws.ws_handler(fake_websocket)

        self.assertEqual(fake_websocket.sent[0]["type"], "error")
        self.assertIn("登录账号", fake_websocket.sent[0]["message"])

    async def test_track_info_reads_artist_from_supported_song_shapes(self):
        self.assertEqual(
            ws._track_info({
                "id": "artist-field",
                "name": "Artist Field",
                "artist": "Solo Artist",
            })["artist"],
            "Solo Artist",
        )
        self.assertEqual(
            ws._track_info({
                "id": "artists-list",
                "name": "Artists List",
                "artists": [{"name": "List Artist"}],
            })["artist"],
            "List Artist",
        )


if __name__ == "__main__":
    unittest.main()
