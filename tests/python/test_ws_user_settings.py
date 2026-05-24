import json
import unittest

from backend.api import ws


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

    async def log_track(self, track_id, name, artist, source):
        self.logged_tracks.append((track_id, name, artist, source))


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


class FakeTTS:
    def __init__(self):
        self.synthesize_calls = []
        self.hash_calls = []

    async def synthesize(self, text, style="daily", user_settings=None):
        self.synthesize_calls.append({
            "text": text,
            "style": style,
            "user_settings": user_settings,
        })
        return b"audio"

    def _hash(self, text, style, user_settings=None):
        self.hash_calls.append({
            "text": text,
            "style": style,
            "user_settings": user_settings,
        })
        return f"hash-{text}"


class FakeScheduler:
    def __init__(self):
        self.pick_next_calls = []
        self.songs = [
            {"id": "first", "name": "First Song", "ar": [{"name": "First Artist"}]},
            {"id": "second", "name": "Second Song", "ar": [{"name": "Second Artist"}]},
        ]

    async def pick_next(
        self,
        current_song_id=None,
        profile=None,
        user_settings=None,
    ):
        self.pick_next_calls.append({
            "current_song_id": current_song_id,
            "profile": profile,
            "user_settings": user_settings,
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
        }
        self.addCleanup(self._restore_ws_globals)

    def _restore_ws_globals(self):
        for name, value in self.originals.items():
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
        self.assertEqual(fake_scheduler.pick_next_calls[0]["user_settings"], stored_settings)
        self.assertEqual(fake_scheduler.pick_next_calls[0]["profile"], fake_dj.intro_calls[0]["profile"])
        self.assertEqual(fake_scheduler.pick_next_calls[1]["current_song_id"], "first")
        self.assertEqual(fake_scheduler.pick_next_calls[1]["user_settings"], stored_settings)
        self.assertEqual(fake_scheduler.pick_next_calls[1]["profile"], fake_dj.intro_calls[0]["profile"])
        self.assertEqual(fake_dj.segue_calls[0]["user_settings"], stored_settings)
        self.assertEqual(fake_tts.synthesize_calls[1]["user_settings"], stored_settings)
        self.assertEqual(fake_tts.hash_calls[1]["user_settings"], stored_settings)
        self.assertNotEqual(fake_dj.intro_calls[0]["user_settings"], handshake_settings)


if __name__ == "__main__":
    unittest.main()
