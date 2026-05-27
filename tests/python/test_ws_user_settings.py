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
        presentation_plan=None,
    ):
        self.segue_calls.append({
            "profile": profile,
            "scene": scene,
            "played_songs": list(played_songs),
            "next_song": next_song,
            "user_settings": user_settings,
            "presentation_plan": presentation_plan,
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


class SlowIntroDJEngine(FakeDJEngine):
    def __init__(self):
        super().__init__()
        self.intro_finished = False

    async def generate_intro(self, profile, scene, user_settings=None):
        self.intro_calls.append({
            "profile": profile,
            "scene": scene,
            "user_settings": user_settings,
        })
        await asyncio.sleep(0.05)
        self.intro_finished = True
        return "slow intro"


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


class QueuingRecordingQueueDirector(RecordingQueueDirector):
    def __init__(self, dj_text="Queued by DJ agent.", song=None, decision=None):
        super().__init__(status="queued", dj_text=dj_text)
        self.song = song or {
            "id": "director-song",
            "name": "Director Song",
            "ar": [{"name": "Director Artist"}],
        }
        self.decision = decision or {}

    async def handle_song_request(self, **kwargs):
        self.calls.append(kwargs)
        kwargs["playback_queue"].clear_ready()
        kwargs["playback_queue"].add_ready(
            self.song,
            f"https://example.test/{self.song['id']}.mp3",
            selection_reason={
                "type": "dj_agent_verified",
                "text": "Verified by QueueDirector",
            },
        )
        return SimpleNamespace(
            status=self.status,
            dj_text=self.dj_text,
            next_song=self.song,
            url=f"https://example.test/{self.song['id']}.mp3",
            decision=self.decision,
        )


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
        intro_settings = fake_dj.intro_calls[0]["user_settings"]
        for key, value in stored_settings.items():
            self.assertEqual(intro_settings[key], value)
        self.assertEqual(intro_settings["local_time_block"], "daily")
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
        self.assertIn("电台", session_start["intro_text"])
        self.assertNotIn("AI", session_start["intro_text"])
        self.assertNotIn("接入", session_start["intro_text"])
        self.assertNotIn("正在", session_start["intro_text"])
        self.assertFalse(session_start["tts_ready"])
        intro = next(payload for payload in fake_websocket.sent if payload["type"] == "intro")
        self.assertIn("电台", intro["text"])
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
        self.assertTrue(any("电台" in payload["text"] for payload in intros))
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

    async def test_ws_song_request_is_not_blocked_by_slow_llm_intro_after_first_track(self):
        fake_store = FakeStore({"voice_preset": "warm_male"})
        fake_dj = SlowIntroDJEngine()
        fake_tts = FakeTTS()
        fake_scheduler = FakeScheduler()
        fake_director = QueuingRecordingQueueDirector(
            dj_text="我先接住这个方向。",
            song={"id": "director-fast", "name": "Fast Lane", "ar": [{"name": "DJ Agent"}]},
        )

        class CheckpointWebSocket(FakeWebSocket):
            async def iter_text(self):
                yield json.dumps({"type": "handshake", "uid": "42", "settings": {}})
                self.resumed_before_intro_finished = not fake_dj.intro_finished
                yield json.dumps({"type": "song_request", "text": "能不能放点收音机头的"})

        fake_websocket = CheckpointWebSocket([])

        ws.store = fake_store
        ws.dj_engine = fake_dj
        ws.tts = fake_tts
        ws.scheduler = fake_scheduler
        ws.request_agent = FailingRequestAgent()
        ws.radio_brain = FailingRadioBrain()
        ws.queue_director = fake_director
        ws.compressor = FakeCompressor()
        ws.profile_engine = None

        await asyncio.wait_for(ws.ws_handler(fake_websocket), timeout=1.0)

        self.assertTrue(fake_websocket.resumed_before_intro_finished)
        request_status = next(
            payload for payload in fake_websocket.sent
            if payload["type"] == "request_status"
        )
        self.assertEqual(request_status["status"], "ready")
        self.assertEqual(request_status["next_track"]["id"], "director-fast")

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

    async def test_ws_song_request_without_queue_director_fails_safely_without_legacy_fallback(self):
        fake_store = FakeStore({"voice_preset": "warm_male"})
        fake_dj = FakeDJEngine()
        fake_tts = FakeTTS()
        fake_scheduler = FakeScheduler()
        fake_agent = FakeRequestAgent(FakeRequestPick(found=True))
        fake_brain = RecordingRadioBrain()
        raw_request = "想听夜路上放空的歌"
        fake_websocket = FakeWebSocket([
            {"type": "handshake", "uid": "42", "settings": {}},
            {"type": "song_request", "text": raw_request},
        ])

        ws.store = fake_store
        ws.dj_engine = fake_dj
        ws.tts = fake_tts
        ws.scheduler = fake_scheduler
        ws.request_agent = fake_agent
        ws.radio_brain = fake_brain
        ws.queue_director = None
        ws.compressor = FakeCompressor()
        ws.profile_engine = None

        await ws.ws_handler(fake_websocket)

        self.assertEqual(fake_agent.calls, [])
        self.assertEqual(fake_brain.calls, [])
        self.assertEqual(fake_scheduler.intent_updates, [])
        self.assertEqual(fake_dj.request_ack_calls, [])
        request_statuses = [
            payload for payload in fake_websocket.sent
            if payload["type"] == "request_status"
        ]
        self.assertEqual(request_statuses[0]["status"], "not_found")
        self.assertEqual(request_statuses[0]["text"], "I could not safely verify a playable match.")
        self.assertNotIn(raw_request, request_statuses[0]["text"])
        request_events = [
            event for event in fake_store.playback_events
            if event["event_type"] == "song_request"
        ]
        self.assertEqual(request_events[0]["reason"], raw_request)

    async def test_ws_afternoon_rnb_request_goes_through_queue_director(self):
        fake_store = FakeStore({"voice_preset": "warm_male"})
        fake_dj = FakeDJEngine()
        fake_tts = FakeTTS()
        fake_scheduler = FakeScheduler()
        fake_director = QueuingRecordingQueueDirector(
            dj_text="下午这段我往松一点的 R&B 接。",
            song={"id": "rnb-director", "name": "Good Days", "ar": [{"name": "SZA"}]},
        )
        fake_websocket = FakeWebSocket([
            {"type": "handshake", "uid": "42", "settings": {}},
            {"type": "song_request", "text": "来点下午听的rnb"},
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

        self.assertEqual(fake_director.calls[0]["request_text"], "来点下午听的rnb")
        self.assertEqual(fake_scheduler.intent_updates, [])
        messages = [
            payload["text"]
            for payload in fake_websocket.sent
            if payload["type"] in {"dj_message", "request_status"}
        ]
        self.assertTrue(any("R&B" in text for text in messages))
        self.assertFalse(any("没找到特别准" in text for text in messages))
        request_status = next(
            payload for payload in fake_websocket.sent
            if payload["type"] == "request_status"
        )
        self.assertEqual(request_status["status"], "ready")
        self.assertEqual(request_status["next_track"]["id"], "rnb-director")

    async def test_ws_song_request_ready_status_hides_internal_verification_note(self):
        fake_store = FakeStore({"voice_preset": "warm_male"})
        fake_dj = FakeDJEngine()
        fake_tts = FakeTTS()
        fake_scheduler = FakeScheduler()

        class InternalNoteDirector(QueuingRecordingQueueDirector):
            async def handle_song_request(self, **kwargs):
                self.calls.append(kwargs)
                kwargs["playback_queue"].clear_ready()
                kwargs["playback_queue"].add_ready(
                    self.song,
                    f"https://example.test/{self.song['id']}.mp3",
                    selection_reason={
                        "type": "dj_agent_verified",
                        "text": "Selected the first playable candidate from a concrete track query.",
                    },
                )
                return SimpleNamespace(
                    status=self.status,
                    dj_text=self.dj_text,
                    next_song=self.song,
                    url=f"https://example.test/{self.song['id']}.mp3",
                    decision=self.decision,
                )

        fake_director = InternalNoteDirector(
            dj_text="我先接住这个方向。",
            song={"id": "director-song", "name": "Director Song", "ar": [{"name": "Director Artist"}]},
        )
        fake_websocket = FakeWebSocket([
            {"type": "handshake", "uid": "42", "settings": {}},
            {"type": "song_request", "text": "能不能放点收音机头的"},
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

        request_status = next(
            payload for payload in fake_websocket.sent
            if payload["type"] == "request_status"
        )
        self.assertEqual(request_status["status"], "ready")
        self.assertIn("下一首", request_status["text"])
        self.assertNotIn("Selected the first playable candidate", request_status["text"])
        self.assertNotIn("query", request_status["text"])

    async def test_ws_song_request_ready_status_uses_chinese_copy_for_english_version_note(self):
        fake_store = FakeStore({"voice_preset": "warm_male"})
        fake_dj = FakeDJEngine()
        fake_tts = FakeTTS()
        fake_scheduler = FakeScheduler()

        class EnglishNoteDirector(QueuingRecordingQueueDirector):
            async def handle_song_request(self, **kwargs):
                self.calls.append(kwargs)
                kwargs["playback_queue"].clear_ready()
                kwargs["playback_queue"].add_ready(
                    self.song,
                    f"https://example.test/{self.song['id']}.mp3",
                    selection_reason={
                        "type": "dj_agent_verified",
                        "text": "Original album version from OK Computer",
                    },
                )
                return SimpleNamespace(
                    status=self.status,
                    dj_text=self.dj_text,
                    next_song=self.song,
                    url=f"https://example.test/{self.song['id']}.mp3",
                    decision=self.decision,
                )

        fake_director = EnglishNoteDirector(
            dj_text="我先接住这个方向。",
            song={"id": "radiohead-song", "name": "Karma Police", "ar": [{"name": "Radiohead"}]},
        )
        fake_websocket = FakeWebSocket([
            {"type": "handshake", "uid": "42", "settings": {}},
            {"type": "song_request", "text": "能不能放点收音机头的"},
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

        request_status = next(
            payload for payload in fake_websocket.sent
            if payload["type"] == "request_status"
        )
        self.assertEqual(request_status["text"], "下一首准备好了：Karma Police。")
        self.assertNotIn("Original album version", request_status["text"])

    async def test_ws_song_request_ready_status_hides_mixed_english_judgement_note(self):
        fake_store = FakeStore({"voice_preset": "warm_male"})
        fake_dj = FakeDJEngine()
        fake_tts = FakeTTS()
        fake_scheduler = FakeScheduler()

        class MixedJudgementDirector(QueuingRecordingQueueDirector):
            async def handle_song_request(self, **kwargs):
                self.calls.append(kwargs)
                kwargs["playback_queue"].clear_ready()
                kwargs["playback_queue"].add_ready(
                    self.song,
                    f"https://example.test/{self.song['id']}.mp3",
                    selection_reason={
                        "type": "dj_agent_verified",
                        "text": (
                            "Selected 'Creep' as a highly recognizable and iconic song by Radiohead, "
                            "matching the artist_direction task and 收音机头 search goal."
                        ),
                    },
                )
                return SimpleNamespace(
                    status=self.status,
                    dj_text=self.dj_text,
                    next_song=self.song,
                    url=f"https://example.test/{self.song['id']}.mp3",
                    decision=self.decision,
                )

        fake_director = MixedJudgementDirector(
            dj_text="我先接住这个方向。",
            song={"id": "radiohead-creep", "name": "Creep", "ar": [{"name": "Radiohead"}]},
        )
        fake_websocket = FakeWebSocket([
            {"type": "handshake", "uid": "42", "settings": {}},
            {"type": "song_request", "text": "能不能放点收音机头的"},
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

        request_status = next(
            payload for payload in fake_websocket.sent
            if payload["type"] == "request_status"
        )
        self.assertEqual(request_status["text"], "下一首准备好了：Creep。")
        self.assertNotIn("recognizable", request_status["text"])
        self.assertNotIn("artist_direction", request_status["text"])

    async def test_ws_song_request_extends_structured_direction_after_verified_queue(self):
        fake_store = FakeStore({"voice_preset": "warm_male"})
        fake_dj = FakeDJEngine()
        fake_tts = FakeTTS()
        fake_scheduler = FakeScheduler()
        fake_director = QueuingRecordingQueueDirector(
            dj_text="我先把晚上这条线接住。",
            song={"id": "night-director", "name": "Apocalypse", "ar": [{"name": "Cigarettes After Sex"}]},
            decision={
                "action": "set_direction_and_play",
                "music_task": {
                    "type": "scene_genre_direction",
                    "primary_entities": [{"role": "scene", "name": "晚上听"}],
                    "style_hint": "安静 放松 不炸",
                    "search_goals": ["Cigarettes After Sex Apocalypse"],
                },
                "queue_policy": {"duration_tracks": 5, "continue_direction": True},
            },
        )
        fake_websocket = FakeWebSocket([
            {"type": "handshake", "uid": "42", "settings": {}},
            {"type": "song_request", "text": "放点晚上听的，别这么炸"},
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

        self.assertEqual(len(fake_scheduler.intent_updates), 1)
        update = fake_scheduler.intent_updates[0]
        self.assertEqual(update["request_text"], "晚上听 安静 放松 不炸")
        self.assertNotIn("放点晚上听的", update["request_text"])
        self.assertEqual(
            update["user_settings"]["listening_intent"]["raw_text"],
            "晚上听 安静 放松 不炸",
        )
        self.assertEqual(
            update["user_settings"]["listening_intent"]["keywords"],
            "晚上听 安静 放松 不炸",
        )

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

    async def test_ws_electronic_scene_request_uses_queue_director_without_specific_agent(self):
        fake_store = FakeStore({"voice_preset": "warm_male"})
        fake_dj = FakeDJEngine()
        fake_tts = FakeTTS()
        fake_scheduler = FakeScheduler()
        fake_director = RecordingQueueDirector(
            status="needs_recovery",
            dj_text="I could not safely verify a playable match.",
        )
        fake_websocket = FakeWebSocket([
            {"type": "handshake", "uid": "42", "settings": {}},
            {"type": "song_request", "text": "我想听点炸场电音"},
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

        self.assertEqual(fake_director.calls[0]["request_text"], "我想听点炸场电音")
        self.assertEqual(fake_scheduler.intent_updates, [])
        messages = [
            payload["text"]
            for payload in fake_websocket.sent
            if payload["type"] in {"dj_message", "request_status"}
        ]
        self.assertFalse(any("没找到特别准" in text for text in messages))
        self.assertFalse(any("往这个方向靠" in text for text in messages))

    async def test_ws_negative_feedback_goes_through_queue_director_without_specific_search(self):
        fake_store = FakeStore({"voice_preset": "warm_male"})
        fake_dj = FakeDJEngine()
        fake_tts = FakeTTS()
        fake_scheduler = FakeScheduler()
        fake_director = RecordingQueueDirector(
            status="needs_recovery",
            dj_text="懂了，这批中文方向先避开。",
        )
        fake_websocket = FakeWebSocket([
            {"type": "handshake", "uid": "42", "settings": {}},
            {"type": "song_request", "text": "能不能不要放这些中文歌了"},
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

        self.assertEqual(fake_director.calls[0]["request_text"], "能不能不要放这些中文歌了")
        self.assertEqual(fake_scheduler.intent_updates, [])
        statuses = [
            payload for payload in fake_websocket.sent
            if payload["type"] == "request_status"
        ]
        self.assertIn("中文", statuses[0]["text"])

    async def test_ws_rejecting_current_results_does_not_become_legacy_song_search(self):
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
        fake_director = RecordingQueueDirector(
            status="needs_recovery",
            dj_text="I could not safely verify a playable match.",
        )
        fake_websocket = FakeWebSocket([
            {"type": "handshake", "uid": "42", "settings": {}},
            {"type": "song_request", "text": "不是，不是这些"},
        ])

        ws.store = fake_store
        ws.dj_engine = FakeDJEngine()
        ws.tts = FakeTTS()
        ws.scheduler = fake_scheduler
        ws.request_agent = FailingRequestAgent()
        ws.radio_brain = FailingRadioBrain()
        ws.queue_director = fake_director
        ws.compressor = FakeCompressor()
        ws.profile_engine = None

        await ws.ws_handler(fake_websocket)

        self.assertEqual(fake_director.calls[0]["request_text"], "不是，不是这些")
        self.assertEqual(fake_scheduler.intent_updates, [])
        messages = [
            payload["text"]
            for payload in fake_websocket.sent
            if payload["type"] in {"dj_message", "request_status"}
        ]
        self.assertFalse(any("往这个方向靠" in text for text in messages))
        self.assertFalse(any("不如不见面" in text for text in messages))

    async def test_ws_song_request_does_not_use_radio_brain_profile_learning_fallback(self):
        fake_store = FakeStore({"voice_preset": "warm_male"})
        fake_scheduler = FakeScheduler()
        fake_director = RecordingQueueDirector(status="needs_recovery")
        fake_websocket = FakeWebSocket([
            {"type": "handshake", "uid": "42", "settings": {}},
            {"type": "song_request", "text": "能不能不要放这些中文歌了"},
        ])

        ws.store = fake_store
        ws.dj_engine = FakeDJEngine()
        ws.tts = FakeTTS()
        ws.scheduler = fake_scheduler
        ws.request_agent = FailingRequestAgent()
        ws.radio_brain = FailingRadioBrain()
        ws.queue_director = fake_director
        ws.compressor = FakeCompressor()
        ws.profile_engine = None

        await ws.ws_handler(fake_websocket)

        self.assertEqual(fake_store.saved_profiles, [])
        self.assertEqual(fake_director.calls[0]["request_text"], "能不能不要放这些中文歌了")

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

    async def test_ws_song_request_plays_director_selected_version_with_dj_intro(self):
        fake_store = FakeStore({"voice_preset": "warm_male"})
        fake_dj = FakeDJEngine()
        fake_tts = FakeTTS()
        fake_scheduler = FakeScheduler()
        fake_director = QueuingRecordingQueueDirector(
            dj_text="我给你选李云迪这个版本的普罗科菲耶夫第二钢琴协奏曲。",
            song={
                "id": "p2-yundi",
                "name": "Piano Concerto No. 2 in G minor",
                "ar": [{"name": "李云迪"}],
            },
        )
        fake_websocket = FakeWebSocket([
            {"type": "handshake", "uid": "42", "settings": {}},
            {"type": "song_request", "text": "放点古典，我想听李云迪的普2"},
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

        self.assertEqual(
            fake_director.calls[0]["request_text"],
            "放点古典，我想听李云迪的普2",
        )
        self.assertEqual(fake_scheduler.intent_updates, [])
        self.assertEqual(fake_dj.request_ack_calls, [])
        messages = [
            payload for payload in fake_websocket.sent
            if payload["type"] == "dj_message"
        ]
        self.assertEqual(messages[0]["text"], "我给你选李云迪这个版本的普罗科菲耶夫第二钢琴协奏曲。")
        request_status = next(
            payload for payload in fake_websocket.sent
            if payload["type"] == "request_status"
        )
        self.assertEqual(request_status["status"], "ready")
        self.assertEqual(request_status["next_track"]["id"], "p2-yundi")

    async def test_ws_specific_song_request_does_not_fall_back_to_raw_search_when_director_misses(self):
        fake_store = FakeStore({"voice_preset": "warm_male"})
        fake_dj = FakeDJEngine()
        fake_tts = FakeTTS()
        fake_scheduler = FakeScheduler()
        fake_scheduler.songs = [
            {"id": "first", "name": "First Song", "ar": [{"name": "First Artist"}]},
            {"id": "wrong", "name": "想听", "ar": [{"name": "Wrong Artist"}]},
        ]
        fake_director = RecordingQueueDirector(status="needs_recovery")
        fake_websocket = FakeWebSocket([
            {"type": "handshake", "uid": "42", "settings": {}},
            {"type": "song_request", "text": "我想听李云迪的普2"},
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

        self.assertEqual(fake_director.calls[0]["request_text"], "我想听李云迪的普2")
        self.assertEqual(fake_scheduler.intent_updates, [])
        self.assertEqual(fake_dj.request_ack_calls, [])
        request_statuses = [
            payload for payload in fake_websocket.sent
            if payload["type"] == "request_status"
        ]
        self.assertEqual(request_statuses[0]["status"], "not_found")
        self.assertNotIn("找到了", request_statuses[0]["text"])
        self.assertNotIn("想听", request_statuses[0].get("next_track", {}).get("name", ""))

    async def test_ws_correction_phrase_uses_queue_director_without_legacy_thinking_feedback(self):
        fake_store = FakeStore({"voice_preset": "warm_male"})
        fake_dj = FakeDJEngine()
        fake_tts = FakeTTS()
        fake_scheduler = FakeScheduler()
        fake_director = QueuingRecordingQueueDirector(
            dj_text="对，我按普罗科菲耶夫来接，不再按泛风格乱走。",
            song={
                "id": "p2",
                "name": "Piano Concerto No. 2 in G minor",
                "ar": [{"name": "Sergei Prokofiev"}],
            },
        )
        fake_websocket = FakeWebSocket([
            {"type": "handshake", "uid": "42", "settings": {}},
            {"type": "song_request", "text": "我说的是普罗科菲耶夫"},
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

        self.assertEqual(fake_director.calls[0]["request_text"], "我说的是普罗科菲耶夫")
        self.assertEqual(fake_scheduler.intent_updates, [])
        messages = [
            payload["text"]
            for payload in fake_websocket.sent
            if payload["type"] == "dj_message"
        ]
        self.assertTrue(any("普罗科菲耶夫" in text for text in messages))
        request_status = next(
            payload for payload in fake_websocket.sent
            if payload["type"] == "request_status"
        )
        self.assertEqual(request_status["next_track"]["id"], "p2")

    async def test_ws_short_title_request_does_not_become_mood_direction_when_director_misses(self):
        fake_store = FakeStore({"voice_preset": "warm_male"})
        fake_dj = FakeDJEngine()
        fake_tts = FakeTTS()
        fake_scheduler = FakeScheduler()
        fake_scheduler.songs = [
            {"id": "first", "name": "First Song", "ar": [{"name": "First Artist"}]},
            {"id": "wrong", "name": "Вечера", "ar": [{"name": "Wrong Artist"}]},
        ]
        fake_director = RecordingQueueDirector(status="needs_recovery")
        fake_websocket = FakeWebSocket([
            {"type": "handshake", "uid": "42", "settings": {}},
            {"type": "song_request", "text": "我想听夜曲"},
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

        self.assertEqual(fake_director.calls[0]["request_text"], "我想听夜曲")
        self.assertEqual(fake_scheduler.intent_updates, [])
        request_statuses = [
            payload for payload in fake_websocket.sent
            if payload["type"] == "request_status"
        ]
        self.assertEqual(request_statuses[0]["status"], "not_found")
        self.assertNotIn("往这个方向靠", request_statuses[0]["text"])
        self.assertNotIn("Вечера", request_statuses[0].get("next_track", {}).get("name", ""))

    async def test_ws_song_request_tells_user_when_director_has_no_matching_song(self):
        fake_store = FakeStore({"voice_preset": "warm_male"})
        fake_scheduler = EndlessUnplayableScheduler()
        fake_resolver = MostlyFailingResolver()
        fake_director = RecordingQueueDirector(
            status="needs_recovery",
            dj_text="I could not safely verify a playable match.",
        )
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
        ws.request_agent = FailingRequestAgent()
        ws.radio_brain = FailingRadioBrain()
        ws.queue_director = fake_director

        await asyncio.wait_for(ws.ws_handler(fake_websocket), timeout=1.0)

        request_statuses = [
            payload for payload in fake_websocket.sent
            if payload["type"] == "request_status"
        ]
        self.assertEqual(request_statuses[0]["status"], "not_found")
        self.assertEqual(request_statuses[0]["text"], "I could not safely verify a playable match.")
        self.assertNotIn("没找到特别准", request_statuses[0]["text"])

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
