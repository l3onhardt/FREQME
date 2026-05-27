import asyncio
import json
import unittest
from types import SimpleNamespace

from backend.api import auth, ws
from backend.engines.radio_brain import RadioBrain


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
        self.recent_playable_tracks = []
        self.playback_events = []
        self.saved_profiles = []

    async def get_user_settings(self, uid):
        return self.stored_settings

    async def get_profile(self, uid):
        return {
            "personality": {"traits": ["calm"]},
            "dj_style_suggestion": "natural",
            "anchor_tracks": [
                {
                    "id": "anchor-en",
                    "name": "Exit Music",
                    "artist": "Radiohead",
                    "language": "英文",
                }
            ],
        }

    async def save_profile(self, uid, profile):
        self.saved_profiles.append((uid, profile))

    async def create_session(self, uid):
        return 7

    async def log_track(self, track_id, name, artist, source, uid=None):
        self.logged_tracks.append((track_id, name, artist, source, uid))

    async def log_playback_event(
        self,
        event_type,
        song_id=None,
        uid=None,
        reason="",
    ):
        self.playback_events.append({
            "event_type": event_type,
            "song_id": song_id,
            "uid": uid,
            "reason": reason,
        })

    async def get_recent_playable_tracks(self, uid=None, limit=20):
        return self.recent_playable_tracks[:limit]


class FakeDJEngine:
    def __init__(self):
        self.intro_calls = []
        self.segue_calls = []
        self.request_ack_calls = []

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

    async def generate_program_break(
        self,
        profile,
        scene,
        played_songs,
        next_song,
        context,
        user_settings=None,
    ):
        self.segue_calls.append({
            "profile": profile,
            "scene": scene,
            "played_songs": list(played_songs),
            "next_song": next_song,
            "user_settings": user_settings,
        })
        return "program break"

    async def generate_request_ack(self, profile, scene, request_text, user_settings=None):
        self.request_ack_calls.append({
            "profile": profile,
            "scene": scene,
            "request_text": request_text,
            "user_settings": user_settings,
        })
        return f"好，我往{request_text}这个方向找。"


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


class FakeRequestPick:
    def __init__(self, found=True, song=None, dj_intro="", interpreted_request=""):
        self.found = found
        self.song = song or {}
        self.dj_intro = dj_intro
        self.interpreted_request = interpreted_request


class FakeRequestAgent:
    def __init__(self, result):
        self.result = result
        self.calls = []

    async def resolve(self, request_text, profile=None, user_settings=None):
        self.calls.append({
            "request_text": request_text,
            "profile": profile,
            "user_settings": user_settings,
        })
        return self.result


class FailingRequestAgent:
    async def resolve(self, *args, **kwargs):
        raise AssertionError("legacy request_agent.resolve should not be called")


class FailingRadioBrain:
    def interpret_user_text(self, *args, **kwargs):
        raise AssertionError("legacy radio_brain.interpret_user_text should not be called")


class RecordingQueueDirector:
    def __init__(self, status="needs_recovery", dj_text="I could not safely verify a playable match."):
        self.status = status
        self.dj_text = dj_text
        self.calls = []

    async def handle_song_request(self, **kwargs):
        self.calls.append(kwargs)
        return SimpleNamespace(status=self.status, dj_text=self.dj_text)


class RecordingRadioBrain(RadioBrain):
    def __init__(self):
        self.calls = []

    def interpret_user_text(self, text, profile=None, user_settings=None):
        self.calls.append({
            "text": text,
            "profile": profile,
            "user_settings": user_settings,
        })
        return super().interpret_user_text(text, profile=profile, user_settings=user_settings)


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
        if text in {"segue", "program break"}:
            raise RuntimeError("tts unavailable")
        return b"audio"


class FakeScheduler:
    def __init__(self):
        self.pick_next_calls = []
        self.session_states = []
        self.songs = [
            {"id": "first", "name": "First Song", "ar": [{"name": "First Artist"}]},
            {"id": "second", "name": "Second Song", "ar": [{"name": "Second Artist"}]},
            {"id": "third", "name": "Third Song", "ar": [{"name": "Third Artist"}]},
            {"id": "fourth", "name": "Fourth Song", "ar": [{"name": "Fourth Artist"}]},
            {"id": "fifth", "name": "Fifth Song", "ar": [{"name": "Fifth Artist"}]},
        ]
        self.intent_updates = []

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
        song = self.songs.pop(0)
        if (
            isinstance(user_settings, dict)
            and isinstance(user_settings.get("listening_intent"), dict)
        ):
            song = dict(song)
            song["selection_reason"] = {
                "type": "request_intent",
                "text": "回应刚刚点歌的方向。",
            }
        return song

    def apply_listening_intent(self, session_state, request_text, user_settings=None):
        intent = {
            "raw_text": request_text,
            "keywords": request_text,
            "mood": "",
        }
        self.intent_updates.append({
            "session_state": session_state,
            "request_text": request_text,
            "user_settings": user_settings,
        })
        if isinstance(user_settings, dict):
            user_settings["listening_intent"] = intent
        if isinstance(session_state, dict):
            session_state["listening_intent"] = intent
        return intent

    async def get_song_url(self, song):
        return f"https://example.test/{song['id']}.mp3"


class EndlessUnplayableScheduler(FakeScheduler):
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
        return {
            "id": f"bad-{len(self.pick_next_calls)}",
            "name": "Unplayable",
            "ar": [{"name": "No Audio"}],
        }


class BlockingPrewarmScheduler(FakeScheduler):
    def __init__(self):
        super().__init__()
        self.songs = [
            {"id": "first", "name": "First Song", "ar": [{"name": "First Artist"}]},
            {"id": "second", "name": "Second Song", "ar": [{"name": "Second Artist"}]},
            {"id": "third", "name": "Third Song", "ar": [{"name": "Third Artist"}]},
            {"id": "intent", "name": "Intent Song", "ar": [{"name": "Intent Artist"}]},
        ]
        self.blocking_started = asyncio.Event()
        self.release_block = asyncio.Event()
        self.cancelled_old_prewarm = False

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
        if len(self.pick_next_calls) == 4:
            self.blocking_started.set()
            try:
                await self.release_block.wait()
            except asyncio.CancelledError:
                self.cancelled_old_prewarm = True
                raise
            return {
                "id": "stale",
                "name": "Stale Prewarm",
                "ar": [{"name": "Old Direction"}],
            }
        return self.songs.pop(0)


class MostlyFailingResolver:
    def __init__(self):
        self.calls = []

    async def resolve_with_candidates(self, song, uid=None):
        self.calls.append(str(song.get("id")))
        song_id = str(song.get("id"))

        ok = song_id == "cached-good"
        return type(
            "Result",
            (),
            {
                "ok": ok,
                "proxy_url": "/api/radio/audio/cached-good" if ok else "",
                "reason": "unplayable_url",
                "song_id": "cached-good" if ok else song_id,
            },
        )()


class IntroOrderScheduler(FakeScheduler):
    def __init__(self, websocket):
        super().__init__()
        self.websocket = websocket
        self.intro_sent_before_first_pick = None
        self.intro_sent_before_second_pick = None

    async def pick_next(
        self,
        current_song_id=None,
        profile=None,
        user_settings=None,
        session_state=None,
        uid=None,
    ):
        if len(self.pick_next_calls) == 0:
            self.intro_sent_before_first_pick = any(
                payload["type"] == "intro"
                for payload in self.websocket.sent
            )
        if len(self.pick_next_calls) == 1:
            self.intro_sent_before_second_pick = any(
                payload["type"] == "intro"
                for payload in self.websocket.sent
            )
        return await super().pick_next(
            current_song_id,
            profile=profile,
            user_settings=user_settings,
            session_state=session_state,
            uid=uid,
        )


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
            "audio_resolver": ws.audio_resolver,
            "request_agent": ws.request_agent,
            "radio_brain": ws.radio_brain,
            "dj_request_agent": ws.dj_request_agent,
            "search_verify_agent": ws.search_verify_agent,
            "queue_director": ws.queue_director,
            "dj_memory_manager": ws.dj_memory_manager,
            "auth_netease": auth.netease,
        }
        ws.queue_director = None
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
            {"type": "track_ended"},
            {"type": "track_ended"},
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
        self.assertEqual(
            [song["id"] for song in fake_dj.segue_calls[0]["played_songs"]],
            ["first", "second", "third"],
        )
        self.assertEqual(fake_dj.segue_calls[0]["next_song"]["id"], "fourth")
        self.assertEqual(fake_tts.synthesize_calls[1]["user_settings"], stored_settings)
        self.assertEqual(fake_tts.synthesize_calls[1]["voice_preset"], "bright_girl")
        self.assertEqual(fake_tts.hash_calls[1]["user_settings"], stored_settings)
        self.assertEqual(fake_tts.hash_calls[1]["voice_preset"], "bright_girl")
        self.assertNotEqual(fake_dj.intro_calls[0]["user_settings"], handshake_settings)

    async def test_ws_skip_uses_prewarmed_llm_break_without_waiting_for_new_inference(self):
        fake_store = FakeStore({"voice_preset": "warm_male"})
        fake_dj = FakeDJEngine()
        fake_tts = FakeTTS()
        fake_scheduler = FakeScheduler()

        class CheckpointWebSocket(FakeWebSocket):
            async def iter_text(self):
                yield json.dumps({"type": "handshake", "uid": "42", "settings": {}})
                self.pre_skip_segue_count = len(fake_dj.segue_calls)
                yield json.dumps({"type": "skip"})
                self.post_first_skip_segue_count = len(fake_dj.segue_calls)
                yield json.dumps({"type": "track_ended"})
                self.pre_break_skip_segue_count = len(fake_dj.segue_calls)
                yield json.dumps({"type": "track_ended"})

        fake_websocket = CheckpointWebSocket([])

        ws.store = fake_store
        ws.dj_engine = fake_dj
        ws.tts = fake_tts
        ws.scheduler = fake_scheduler
        ws.compressor = FakeCompressor()
        ws.profile_engine = None

        await asyncio.wait_for(ws.ws_handler(fake_websocket), timeout=1.0)

        self.assertEqual(fake_websocket.pre_skip_segue_count, 0)
        self.assertEqual(fake_websocket.post_first_skip_segue_count, 0)
        self.assertEqual(fake_websocket.pre_break_skip_segue_count, 1)
        self.assertEqual(len(fake_dj.segue_calls), 1)
        self.assertEqual(
            [song["id"] for song in fake_dj.segue_calls[0]["played_songs"]],
            ["first", "second", "third"],
        )
        self.assertEqual(fake_dj.segue_calls[0]["next_song"]["id"], "fourth")
        sent_types = [payload["type"] for payload in fake_websocket.sent]
        self.assertIn("segue", sent_types)
        segue = next(payload for payload in fake_websocket.sent if payload["type"] == "segue")
        self.assertEqual(segue["next_track"]["id"], "fourth")

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

        await asyncio.wait_for(ws.ws_handler(fake_websocket), timeout=1.0)

        sent_types = [payload["type"] for payload in fake_websocket.sent]
        self.assertIn("session_start", sent_types)
        self.assertIn("play_track", sent_types)
        self.assertIn("intro", sent_types)
        session_start = next(payload for payload in fake_websocket.sent if payload["type"] == "session_start")
        self.assertIn("今晚", session_start["intro_text"])
        self.assertNotIn("AI", session_start["intro_text"])
        self.assertNotIn("接入", session_start["intro_text"])
        self.assertNotIn("正在", session_start["intro_text"])
        self.assertFalse(session_start["tts_ready"])
        intro = next(payload for payload in fake_websocket.sent if payload["type"] == "intro")
        self.assertIn("今晚", intro["text"])
        self.assertNotIn("AI", intro["text"])
        self.assertNotIn("接入", intro["text"])
        self.assertNotIn("正在", intro["text"])
        self.assertTrue(intro["tts_ready"])

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
        intros = [payload for payload in fake_websocket.sent if payload["type"] == "intro"]
        self.assertTrue(any("今晚" in payload["text"] for payload in intros))
        self.assertFalse(any("AI" in payload["text"] for payload in intros))
        self.assertFalse(any("接入" in payload["text"] for payload in intros))
        llm_intro = next(payload for payload in intros if payload["text"] == "intro")
        self.assertTrue(llm_intro["tts_ready"])

    async def test_ws_sends_default_intro_before_waiting_for_first_track(self):
        fake_store = FakeStore({"voice_preset": "warm_male"})
        fake_dj = FakeDJEngine()
        fake_tts = FakeTTS()
        fake_websocket = FakeWebSocket([
            {"type": "handshake", "uid": "42", "settings": {}},
        ])
        fake_scheduler = IntroOrderScheduler(fake_websocket)

        ws.store = fake_store
        ws.dj_engine = fake_dj
        ws.tts = fake_tts
        ws.scheduler = fake_scheduler
        ws.compressor = FakeCompressor()
        ws.profile_engine = None

        await ws.ws_handler(fake_websocket)

        self.assertTrue(fake_scheduler.intro_sent_before_first_pick)

    async def test_ws_sends_intro_before_waiting_for_second_track_prewarm(self):
        fake_store = FakeStore({"voice_preset": "warm_male"})
        fake_dj = FakeDJEngine()
        fake_tts = FakeTTS()
        fake_websocket = FakeWebSocket([
            {"type": "handshake", "uid": "42", "settings": {}},
        ])
        fake_scheduler = IntroOrderScheduler(fake_websocket)

        ws.store = fake_store
        ws.dj_engine = fake_dj
        ws.tts = fake_tts
        ws.scheduler = fake_scheduler
        ws.compressor = FakeCompressor()
        ws.profile_engine = None

        await ws.ws_handler(fake_websocket)

        self.assertTrue(fake_scheduler.intro_sent_before_second_pick)

    async def test_ws_uses_recent_playable_track_when_first_song_resolution_keeps_failing(self):
        fake_store = FakeStore({"voice_preset": "warm_male"})
        fake_store.recent_playable_tracks = [
            {"id": "cached-good", "name": "Known Good", "artist": "Known Artist"},
        ]
        fake_resolver = MostlyFailingResolver()
        fake_websocket = FakeWebSocket([
            {"type": "handshake", "uid": "42", "settings": {}},
        ])

        ws.store = fake_store
        ws.dj_engine = FakeDJEngine()
        ws.tts = FakeTTS()
        ws.scheduler = EndlessUnplayableScheduler()
        ws.compressor = FakeCompressor()
        ws.profile_engine = None
        ws.audio_resolver = fake_resolver

        await asyncio.wait_for(ws.ws_handler(fake_websocket), timeout=1.0)

        play_track = next(payload for payload in fake_websocket.sent if payload["type"] == "play_track")
        self.assertEqual(play_track["track"]["id"], "cached-good")
        self.assertEqual(play_track["track"]["name"], "Known Good")
        self.assertEqual(play_track["url"], "/api/radio/audio/cached-good")
        self.assertIn("cached-good", fake_resolver.calls)

    async def test_ws_keeps_llm_segue_text_when_tts_for_segue_fails(self):
        fake_store = FakeStore({"voice_preset": "warm_male"})
        fake_dj = FakeDJEngine()
        fake_tts = FailingSegueTTS()
        fake_scheduler = FakeScheduler()
        fake_websocket = FakeWebSocket([
            {"type": "handshake", "uid": "42", "settings": {}},
            {"type": "skip"},
            {"type": "track_ended"},
            {"type": "track_ended"},
        ])

        ws.store = fake_store
        ws.dj_engine = fake_dj
        ws.tts = fake_tts
        ws.scheduler = fake_scheduler
        ws.compressor = FakeCompressor()
        ws.profile_engine = None

        await ws.ws_handler(fake_websocket)

        segue = next(payload for payload in fake_websocket.sent if payload["type"] == "segue")
        self.assertEqual(segue["text"], "program break")
        self.assertFalse(segue["tts_ready"])
        self.assertEqual(segue["tts_hash"], "")

    async def test_ws_song_request_updates_intent_and_sends_dj_ack_without_restarting_playback(self):
        fake_store = FakeStore({"voice_preset": "warm_male"})
        fake_dj = FakeDJEngine()
        fake_tts = FakeTTS()
        fake_scheduler = FakeScheduler()
        fake_websocket = FakeWebSocket([
            {"type": "handshake", "uid": "42", "settings": {}},
            {"type": "song_request", "text": "想听夜路上放空的歌"},
            {"type": "track_ended"},
        ])

        ws.store = fake_store
        ws.dj_engine = fake_dj
        ws.tts = fake_tts
        ws.scheduler = fake_scheduler
        ws.compressor = FakeCompressor()
        ws.profile_engine = None

        await ws.ws_handler(fake_websocket)

        self.assertEqual(fake_scheduler.intent_updates[0]["request_text"], "想听夜路上放空的歌")
        self.assertEqual(
            fake_scheduler.pick_next_calls[-1]["user_settings"]["listening_intent"]["raw_text"],
            "想听夜路上放空的歌",
        )
        self.assertEqual(fake_dj.request_ack_calls[0]["request_text"], "想听夜路上放空的歌")
        intent_messages = [
            payload for payload in fake_websocket.sent
            if payload["type"] == "dj_message"
        ]
        self.assertEqual(intent_messages[0]["text"], "好，我往想听夜路上放空的歌这个方向找。")
        request_statuses = [
            payload for payload in fake_websocket.sent
            if payload["type"] == "request_status"
        ]
        self.assertEqual(request_statuses[0]["status"], "ready")
        self.assertIn(request_statuses[0]["next_track"]["id"], {"second", "third"})
        self.assertIn("下一首", request_statuses[0]["text"])
        request_events = [
            event for event in fake_store.playback_events
            if event["event_type"] == "song_request"
        ]
        self.assertEqual(request_events[0]["reason"], "想听夜路上放空的歌")

    async def test_ws_afternoon_rnb_request_gets_dj_ack_not_failure_copy(self):
        fake_store = FakeStore({"voice_preset": "warm_male"})
        fake_dj = FakeDJEngine()
        fake_tts = FakeTTS()
        fake_scheduler = FakeScheduler()
        fake_websocket = FakeWebSocket([
            {"type": "handshake", "uid": "42", "settings": {}},
            {"type": "song_request", "text": "来点下午听的rnb"},
        ])

        ws.store = fake_store
        ws.dj_engine = fake_dj
        ws.tts = fake_tts
        ws.scheduler = fake_scheduler
        ws.radio_brain = RecordingRadioBrain()
        ws.compressor = FakeCompressor()
        ws.profile_engine = None

        await ws.ws_handler(fake_websocket)

        messages = [
            payload["text"]
            for payload in fake_websocket.sent
            if payload["type"] in {"dj_message", "request_status"}
        ]
        self.assertTrue(any("R&B" in text for text in messages))
        self.assertFalse(any("没找到特别准" in text for text in messages))

    async def test_ws_queue_director_positive_request_bypasses_legacy_interpreters(self):
        fake_store = FakeStore({"voice_preset": "warm_male"})
        fake_dj = FakeDJEngine()
        fake_tts = FakeTTS()
        fake_scheduler = FakeScheduler()
        fake_director = RecordingQueueDirector(
            status="needs_recovery",
            dj_text="I could not safely verify a playable match.",
        )
        raw_request = "不能放点radiohead的吗"
        fake_websocket = FakeWebSocket([
            {"type": "handshake", "uid": "42", "settings": {}},
            {"type": "song_request", "text": raw_request},
        ])

        ws.store = fake_store
        ws.dj_engine = fake_dj
        ws.tts = fake_tts
        ws.scheduler = fake_scheduler
        ws.request_agent = FailingRequestAgent()
        ws.radio_brain = FailingRadioBrain()
        ws.queue_director = fake_director
        ws.compressor = FakeCompressor()
        ws.profile_engine = None

        await ws.ws_handler(fake_websocket)

        self.assertEqual(len(fake_director.calls), 1)
        self.assertEqual(fake_director.calls[0]["request_text"], raw_request)
        self.assertEqual(fake_scheduler.intent_updates, [])
        request_status = next(
            payload for payload in fake_websocket.sent
            if payload["type"] == "request_status"
        )
        self.assertEqual(request_status["status"], "not_found")
        self.assertNotIn(raw_request, request_status["text"])
        self.assertNotIn("没找到特别准", request_status["text"])

    async def test_ws_electronic_scene_request_uses_brain_plan_without_specific_agent(self):
        fake_store = FakeStore({"voice_preset": "warm_male"})
        fake_dj = FakeDJEngine()
        fake_tts = FakeTTS()
        fake_scheduler = FakeScheduler()
        fake_agent = FakeRequestAgent(FakeRequestPick(found=False))
        fake_websocket = FakeWebSocket([
            {"type": "handshake", "uid": "42", "settings": {}},
            {"type": "song_request", "text": "我想听点炸场电音"},
        ])

        ws.store = fake_store
        ws.dj_engine = fake_dj
        ws.tts = fake_tts
        ws.scheduler = fake_scheduler
        ws.request_agent = fake_agent
        ws.radio_brain = RecordingRadioBrain()
        ws.compressor = FakeCompressor()
        ws.profile_engine = None

        await ws.ws_handler(fake_websocket)

        self.assertEqual(fake_agent.calls, [])
        brain_settings = fake_scheduler.pick_next_calls[-1]["user_settings"]["radio_brain"]
        decision = brain_settings["decision"]
        self.assertEqual(decision["intent_type"], "taste_direction")
        self.assertEqual(decision["semantic_queries"][0], "电子 舞曲 高能")
        self.assertFalse(decision["search_raw_text"])
        messages = [
            payload["text"]
            for payload in fake_websocket.sent
            if payload["type"] in {"dj_message", "request_status"}
        ]
        self.assertTrue(any("电子" in text for text in messages))
        self.assertFalse(any("没找到特别准" in text for text in messages))
        self.assertFalse(any("往这个方向靠" in text for text in messages))

    async def test_ws_negative_feedback_uses_radio_brain_without_specific_search(self):
        fake_store = FakeStore({"voice_preset": "warm_male"})
        fake_dj = FakeDJEngine()
        fake_tts = FakeTTS()
        fake_scheduler = FakeScheduler()
        fake_agent = FakeRequestAgent(FakeRequestPick(
            found=True,
            song={
                "id": "wrong",
                "name": "能不能不要说再见",
                "ar": [{"name": "Wrong Artist"}],
            },
            dj_intro="错误的点歌结果。",
        ))
        fake_brain = RecordingRadioBrain()
        fake_websocket = FakeWebSocket([
            {"type": "handshake", "uid": "42", "settings": {}},
            {"type": "song_request", "text": "能不能不要放这些中文歌了"},
        ])

        ws.store = fake_store
        ws.dj_engine = fake_dj
        ws.tts = fake_tts
        ws.scheduler = fake_scheduler
        ws.request_agent = fake_agent
        ws.radio_brain = fake_brain
        ws.compressor = FakeCompressor()
        ws.profile_engine = None

        await ws.ws_handler(fake_websocket)

        self.assertEqual(fake_agent.calls, [])
        self.assertEqual(fake_brain.calls[0]["text"], "能不能不要放这些中文歌了")
        brain_settings = fake_scheduler.pick_next_calls[-1]["user_settings"]["radio_brain"]
        self.assertEqual(brain_settings["decision"]["intent_type"], "negative_feedback")
        self.assertIn("中文", brain_settings["decision"]["avoid_languages"])
        dj_messages = [
            payload for payload in fake_websocket.sent
            if payload["type"] == "dj_message"
        ]
        self.assertIn("中文", dj_messages[0]["text"])

    async def test_ws_rejecting_current_results_does_not_become_song_search(self):
        fake_store = FakeStore({"voice_preset": "warm_male"})
        fake_scheduler = FakeScheduler()
        fake_scheduler.songs = [
            {"id": "first", "name": "First Song", "ar": [{"name": "First Artist"}]},
            {
                "id": "wrong",
                "name": "不如不见面",
                "ar": [{"name": "Wrong Artist"}],
                "selection_reason": {
                    "type": "request_intent",
                    "text": "错误地按不是这些搜索。",
                },
            },
            {"id": "better", "name": "Better Song", "ar": [{"name": "Better Artist"}]},
        ]
        fake_agent = FakeRequestAgent(FakeRequestPick(found=False))
        fake_websocket = FakeWebSocket([
            {"type": "handshake", "uid": "42", "settings": {}},
            {"type": "song_request", "text": "不是，不是这些"},
        ])

        ws.store = fake_store
        ws.dj_engine = FakeDJEngine()
        ws.tts = FakeTTS()
        ws.scheduler = fake_scheduler
        ws.request_agent = fake_agent
        ws.radio_brain = RecordingRadioBrain()
        ws.compressor = FakeCompressor()
        ws.profile_engine = None

        await ws.ws_handler(fake_websocket)

        self.assertEqual(fake_agent.calls, [])
        brain_settings = fake_scheduler.pick_next_calls[-1]["user_settings"]["radio_brain"]
        self.assertEqual(brain_settings["decision"]["intent_type"], "negative_feedback")
        self.assertEqual(fake_scheduler.pick_next_calls[-1]["user_settings"]["listening_intent"]["keywords"], "")
        messages = [
            payload["text"]
            for payload in fake_websocket.sent
            if payload["type"] in {"dj_message", "request_status"}
        ]
        self.assertFalse(any("往这个方向靠" in text for text in messages))
        self.assertFalse(any("不如不见面" in text for text in messages))
        self.assertTrue(any("不是这些" in text or "这批" in text for text in messages))

    async def test_ws_negative_feedback_silently_updates_profile_learning(self):
        fake_store = FakeStore({"voice_preset": "warm_male"})
        fake_scheduler = FakeScheduler()
        fake_websocket = FakeWebSocket([
            {"type": "handshake", "uid": "42", "settings": {}},
            {"type": "song_request", "text": "能不能不要放这些中文歌了"},
        ])

        ws.store = fake_store
        ws.dj_engine = FakeDJEngine()
        ws.tts = FakeTTS()
        ws.scheduler = fake_scheduler
        ws.radio_brain = RecordingRadioBrain()
        ws.compressor = FakeCompressor()
        ws.profile_engine = None

        await ws.ws_handler(fake_websocket)

        self.assertEqual(fake_store.saved_profiles[0][0], "42")
        learned = fake_store.saved_profiles[0][1]["radio_brain"]["learned_preferences"]
        self.assertIn("中文", learned["avoid_languages"])
        self.assertIn("华语流行", learned["avoid_styles"])
        self.assertEqual(learned["negative_feedback_count"], 1)

    async def test_ws_skip_silently_records_skipped_track_in_profile(self):
        fake_store = FakeStore({"voice_preset": "warm_male"})
        fake_scheduler = FakeScheduler()
        fake_websocket = FakeWebSocket([
            {"type": "handshake", "uid": "42", "settings": {}},
            {"type": "skip"},
        ])

        ws.store = fake_store
        ws.dj_engine = FakeDJEngine()
        ws.tts = FakeTTS()
        ws.scheduler = fake_scheduler
        ws.radio_brain = RecordingRadioBrain()
        ws.compressor = FakeCompressor()
        ws.profile_engine = None

        await ws.ws_handler(fake_websocket)

        learned = fake_store.saved_profiles[0][1]["radio_brain"]["learned_preferences"]
        self.assertEqual(learned["skipped_track_ids"][0], "first")
        self.assertEqual(learned["skip_count"], 1)

    async def test_ws_song_request_plays_agent_selected_version_with_dj_intro(self):
        fake_store = FakeStore({"voice_preset": "warm_male"})
        fake_dj = FakeDJEngine()
        fake_tts = FakeTTS()
        fake_scheduler = FakeScheduler()
        fake_agent = FakeRequestAgent(FakeRequestPick(
            found=True,
            song={
                "id": "p2-yundi",
                "name": "Piano Concerto No. 2 in G minor",
                "ar": [{"name": "李云迪"}],
                "selection_reason": {
                    "type": "request_agent",
                    "text": "AI 主播选择的李云迪版本。",
                },
            },
            dj_intro="我给你选李云迪这个版本的普罗科菲耶夫第二钢琴协奏曲。这个录音的钢琴颗粒很硬，适合现在这种想往古典里沉一下的时刻。",
            interpreted_request="普罗科菲耶夫第二钢琴协奏曲，偏李云迪版本",
        ))
        fake_websocket = FakeWebSocket([
            {"type": "handshake", "uid": "42", "settings": {}},
            {"type": "song_request", "text": "放点古典，我想听李云迪的普2"},
        ])

        ws.store = fake_store
        ws.dj_engine = fake_dj
        ws.tts = fake_tts
        ws.scheduler = fake_scheduler
        ws.request_agent = fake_agent
        ws.compressor = FakeCompressor()
        ws.profile_engine = None

        await ws.ws_handler(fake_websocket)

        self.assertEqual(
            fake_agent.calls[0]["request_text"],
            "放点古典，我想听李云迪的普2",
        )
        self.assertEqual(fake_scheduler.intent_updates, [])
        self.assertEqual(fake_dj.request_ack_calls, [])
        segues = [
            payload for payload in fake_websocket.sent
            if payload["type"] == "segue"
        ]
        self.assertEqual(segues[0]["text"], fake_agent.result.dj_intro)
        self.assertEqual(segues[0]["next_track"]["id"], "p2-yundi")
        self.assertEqual(segues[0]["url"], "https://example.test/p2-yundi.mp3")
        self.assertTrue(segues[0]["tts_ready"])
        self.assertEqual(fake_store.logged_tracks[-1][0], "p2-yundi")

    async def test_ws_specific_song_request_does_not_fall_back_to_raw_search_when_agent_misses(self):
        fake_store = FakeStore({"voice_preset": "warm_male"})
        fake_dj = FakeDJEngine()
        fake_tts = FakeTTS()
        fake_scheduler = FakeScheduler()
        fake_scheduler.songs = [
            {"id": "first", "name": "First Song", "ar": [{"name": "First Artist"}]},
            {"id": "wrong", "name": "想听", "ar": [{"name": "Wrong Artist"}]},
        ]
        fake_agent = FakeRequestAgent(FakeRequestPick(
            found=False,
            interpreted_request="李云迪演奏的普罗科菲耶夫第二钢琴协奏曲",
        ))
        fake_websocket = FakeWebSocket([
            {"type": "handshake", "uid": "42", "settings": {}},
            {"type": "song_request", "text": "我想听李云迪的普2"},
        ])

        ws.store = fake_store
        ws.dj_engine = fake_dj
        ws.tts = fake_tts
        ws.scheduler = fake_scheduler
        ws.request_agent = fake_agent
        ws.compressor = FakeCompressor()
        ws.profile_engine = None

        await ws.ws_handler(fake_websocket)

        self.assertEqual(fake_agent.calls[0]["request_text"], "我想听李云迪的普2")
        self.assertEqual(fake_scheduler.intent_updates, [])
        self.assertEqual(fake_dj.request_ack_calls, [])
        request_statuses = [
            payload for payload in fake_websocket.sent
            if payload["type"] == "request_status"
        ]
        self.assertEqual(request_statuses[0]["status"], "not_found")
        self.assertNotIn("找到了", request_statuses[0]["text"])
        self.assertNotIn("想听", request_statuses[0].get("next_track", {}).get("name", ""))

    async def test_ws_correction_phrase_uses_request_agent_with_thinking_feedback(self):
        fake_store = FakeStore({"voice_preset": "warm_male"})
        fake_dj = FakeDJEngine()
        fake_tts = FakeTTS()
        fake_scheduler = FakeScheduler()
        fake_agent = FakeRequestAgent(FakeRequestPick(
            found=True,
            song={
                "id": "p2",
                "name": "Piano Concerto No. 2 in G minor",
                "ar": [{"name": "Sergei Prokofiev"}],
                "selection_reason": {
                    "type": "request_agent",
                    "text": "按用户纠正确认为普罗科菲耶夫作品。",
                },
            },
            dj_intro="对，我按普罗科菲耶夫来接，不再按泛风格乱走。",
            interpreted_request="普罗科菲耶夫作品",
        ))
        fake_websocket = FakeWebSocket([
            {"type": "handshake", "uid": "42", "settings": {}},
            {"type": "song_request", "text": "我说的是普罗科菲耶夫"},
        ])

        ws.store = fake_store
        ws.dj_engine = fake_dj
        ws.tts = fake_tts
        ws.scheduler = fake_scheduler
        ws.request_agent = fake_agent
        ws.radio_brain = RecordingRadioBrain()
        ws.compressor = FakeCompressor()
        ws.profile_engine = None

        await ws.ws_handler(fake_websocket)

        self.assertEqual(fake_agent.calls[0]["request_text"], "我说的是普罗科菲耶夫")
        self.assertEqual(fake_scheduler.intent_updates, [])
        thinking_messages = [
            payload["text"]
            for payload in fake_websocket.sent
            if payload["type"] == "dj_message"
        ]
        self.assertTrue(any("作品" in text or "人名" in text for text in thinking_messages))
        self.assertFalse(any("往“我说的是普罗科菲耶夫”这个方向接" in text for text in thinking_messages))
        segues = [
            payload for payload in fake_websocket.sent
            if payload["type"] == "segue"
        ]
        self.assertEqual(segues[0]["next_track"]["id"], "p2")

    async def test_ws_short_title_request_does_not_become_mood_direction_when_agent_misses(self):
        fake_store = FakeStore({"voice_preset": "warm_male"})
        fake_dj = FakeDJEngine()
        fake_tts = FakeTTS()
        fake_scheduler = FakeScheduler()
        fake_scheduler.songs = [
            {"id": "first", "name": "First Song", "ar": [{"name": "First Artist"}]},
            {"id": "wrong", "name": "Вечера", "ar": [{"name": "Wrong Artist"}]},
        ]
        fake_agent = FakeRequestAgent(FakeRequestPick(
            found=False,
            interpreted_request="夜曲",
        ))
        fake_websocket = FakeWebSocket([
            {"type": "handshake", "uid": "42", "settings": {}},
            {"type": "song_request", "text": "我想听夜曲"},
        ])

        ws.store = fake_store
        ws.dj_engine = fake_dj
        ws.tts = fake_tts
        ws.scheduler = fake_scheduler
        ws.request_agent = fake_agent
        ws.compressor = FakeCompressor()
        ws.profile_engine = None

        await ws.ws_handler(fake_websocket)

        self.assertEqual(fake_agent.calls[0]["request_text"], "我想听夜曲")
        self.assertEqual(fake_scheduler.intent_updates, [])
        request_statuses = [
            payload for payload in fake_websocket.sent
            if payload["type"] == "request_status"
        ]
        self.assertEqual(request_statuses[0]["status"], "not_found")
        self.assertNotIn("往这个方向靠", request_statuses[0]["text"])
        self.assertNotIn("Вечера", request_statuses[0].get("next_track", {}).get("name", ""))

    async def test_ws_song_request_tells_user_when_no_matching_song_is_ready(self):
        fake_store = FakeStore({"voice_preset": "warm_male"})
        fake_scheduler = EndlessUnplayableScheduler()
        fake_resolver = MostlyFailingResolver()
        fake_websocket = FakeWebSocket([
            {"type": "handshake", "uid": "42", "settings": {}},
            {"type": "song_request", "text": "我不是很开心，放点emo的"},
        ])

        ws.store = fake_store
        ws.dj_engine = FakeDJEngine()
        ws.tts = FakeTTS()
        ws.scheduler = fake_scheduler
        ws.compressor = FakeCompressor()
        ws.profile_engine = None
        ws.audio_resolver = fake_resolver

        await asyncio.wait_for(ws.ws_handler(fake_websocket), timeout=1.0)

        request_statuses = [
            payload for payload in fake_websocket.sent
            if payload["type"] == "request_status"
        ]
        self.assertEqual(request_statuses[0]["status"], "fallback")
        self.assertIn("没找到特别准", request_statuses[0]["text"])

    async def test_ws_song_request_cancels_old_background_prewarm_before_refilling(self):
        fake_store = FakeStore({"voice_preset": "warm_male"})
        fake_scheduler = BlockingPrewarmScheduler()

        class RequestDuringPrewarmWebSocket(FakeWebSocket):
            async def iter_text(self):
                yield json.dumps({"type": "handshake", "uid": "42", "settings": {}})
                yield json.dumps({"type": "track_ended"})
                yield json.dumps({"type": "track_ended"})
                await asyncio.wait_for(fake_scheduler.blocking_started.wait(), timeout=1.0)
                yield json.dumps({"type": "song_request", "text": "想听夜路上放空的歌"})
                fake_scheduler.release_block.set()
                yield json.dumps({"type": "track_ended"})

        fake_websocket = RequestDuringPrewarmWebSocket([])

        ws.store = fake_store
        ws.dj_engine = FakeDJEngine()
        ws.tts = FakeTTS()
        ws.scheduler = fake_scheduler
        ws.compressor = FakeCompressor()
        ws.profile_engine = None

        await asyncio.wait_for(ws.ws_handler(fake_websocket), timeout=1.0)

        self.assertTrue(fake_scheduler.cancelled_old_prewarm)
        played_ids = [
            payload["track"]["id"]
            for payload in fake_websocket.sent
            if payload["type"] == "play_track"
        ]
        self.assertIn("intent", played_ids)
        self.assertNotIn("stale", played_ids)

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
