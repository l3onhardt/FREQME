import unittest

from backend.memory.dj_memory import DJMemoryManager


class FakeStore:
    def __init__(self):
        self.session_memory = {
            "active_mode": {"label": "Zimerman / Chopin", "expires_after_tracks": 3},
            "current_constraints": ["Avoid overplayed Chinese pop."],
        }
        self.user_memories = [
            {
                "memory_key": "avoid_pop",
                "memory_text": "User dislikes overplayed Chinese pop.",
                "confidence": 0.8,
                "tags": ["taste", "negative_feedback"],
            }
        ]
        self.events = [
            {
                "event_type": "user_request",
                "raw_text": "我要听齐默尔曼的肖邦",
                "payload": {"tags": ["classical", "piano"]},
                "importance": 0.82,
            }
        ]

    async def get_dj_session_memory(self, uid, session_id):
        return self.session_memory

    async def get_dj_user_memories(self, uid, tags=None, limit=10):
        return self.user_memories[:limit]

    async def get_recent_dj_memory_events(self, uid, limit=20):
        return self.events[:limit]


class FailingReadStore(FakeStore):
    async def get_dj_session_memory(self, uid, session_id):
        raise RuntimeError("session read failed")

    async def get_dj_user_memories(self, uid, tags=None, limit=10):
        raise RuntimeError("memory read failed")

    async def get_recent_dj_memory_events(self, uid, limit=20):
        raise RuntimeError("event read failed")


class RecordingStore(FakeStore):
    def __init__(self, fail_writes=False):
        super().__init__()
        self.fail_writes = fail_writes
        self.saved_memory = None
        self.logged_event = None

    async def save_dj_session_memory(self, uid, session_id, memory):
        if self.fail_writes:
            raise RuntimeError("save failed")
        self.saved_memory = {"uid": uid, "session_id": session_id, "memory": memory}

    async def log_dj_memory_event(self, **event):
        if self.fail_writes:
            raise RuntimeError("log failed")
        self.logged_event = event


class DJMemoryManagerTests(unittest.IsolatedAsyncioTestCase):
    async def test_context_pack_is_bounded_and_prioritized(self):
        manager = DJMemoryManager(FakeStore(), max_profile_chars=80, max_recent_turns=2, max_retrieved_memories=1)
        pack = await manager.build_context_pack(
            uid="42",
            session_id=7,
            user_message="还是这个方向继续",
            profile={
                "radio_insights": {
                    "taste_summary": "x" * 200,
                    "comfort_zone": ["quiet piano"],
                },
                "anchor_tracks": [{"name": "Exit Music", "artist": "Radiohead"}],
            },
            user_settings={"timezone_name": "Asia/Hong_Kong"},
            playback_context={
                "current_track": {"name": "Nocturne", "artist": "Arthur Rubinstein"},
                "recent_tracks": [],
                "ready_queue": [],
            },
            recent_turns=[
                {"speaker": "user", "text": "old"},
                {"speaker": "dj", "text": "old response"},
                {"speaker": "user", "text": "new"},
            ],
        )

        self.assertEqual(pack["user_message"], "还是这个方向继续")
        self.assertEqual(pack["session_working_memory"]["active_mode"]["label"], "Zimerman / Chopin")
        self.assertLessEqual(len(pack["user_profile_digest"]), 80)
        self.assertEqual(len(pack["recent_turns"]), 2)
        self.assertEqual(len(pack["retrieved_memories"]), 1)
        self.assertEqual(pack["playback_context"]["current_track"]["name"], "Nocturne")

    async def test_nested_context_inputs_are_compacted(self):
        store = FakeStore()
        store.session_memory = {
            "active_mode": {
                "label": "L" * 500,
                "understood_intent": "I" * 500,
                "expires_after_tracks": 9,
                "seed_task": {"query": "Q" * 500, "tags": ["a", "b", "c", "d", "e", "f"], "ignored": "x" * 500},
                "confidence": 0.6,
                "extra": "not needed",
            },
            "current_constraints": ["C" * 500, "D" * 500, "E" * 500, "F" * 500, "G" * 500],
            "recent_corrections": [{"text": "R" * 500, "extra": "x" * 500} for _ in range(6)],
            "pending_soft_confirmation": {"prompt": "P" * 500, "extra": "x" * 500},
            "last_successful_request": "S" * 500,
            "unneeded_blob": "B" * 5000,
        }
        store.user_memories = [
            {
                "memory_key": "M" * 200,
                "memory_text": "T" * 1000,
                "confidence": 0.4,
                "tags": [str(i) * 100 for i in range(20)],
                "payload": {"huge": "x" * 1000},
            }
        ]
        store.events = [
            {
                "event_type": "user_request",
                "raw_text": "E" * 1000,
                "payload": {
                    "query": "P" * 1000,
                    "tags": [str(i) * 100 for i in range(20)],
                    "nested": {"large": "N" * 1000},
                },
                "importance": 0.9,
            }
        ]

        manager = DJMemoryManager(store, max_recent_turns=2, max_retrieved_memories=1)
        pack = await manager.build_context_pack(
            uid="42",
            session_id=7,
            user_message="继续",
            recent_turns=[
                {"speaker": "user", "text": "old"},
                {"speaker": "dj", "text": "D" * 1000, "payload": {"notes": "N" * 1000}},
                {"speaker": "user", "text": "U" * 1000, "payload": {"ignored": "I" * 1000}},
            ],
            playback_context={
                "current_track": {"name": "N" * 500, "artist": "A" * 500, "album": "B" * 500, "extra": "x"},
                "recent_tracks": [{"name": str(i) * 300, "artist": "A" * 300, "extra": "x"} for i in range(10)],
                "ready_queue": [{"name": str(i) * 300, "artist": "Q" * 300, "reason": "R" * 300} for i in range(12)],
                "scene": {"mood": "M" * 500, "extra": "x" * 500},
                "unneeded": "x" * 5000,
            },
        )

        session = pack["session_working_memory"]
        self.assertEqual(set(session), {
            "active_mode",
            "current_constraints",
            "recent_corrections",
            "pending_soft_confirmation",
            "last_successful_request",
        })
        self.assertLess(len(session["active_mode"]["label"]), 200)
        self.assertLessEqual(len(session["current_constraints"]), 4)
        self.assertLess(len(session["current_constraints"][0]), 200)
        self.assertLessEqual(len(session["recent_corrections"]), 4)
        self.assertLess(len(session["pending_soft_confirmation"]["prompt"]), 200)
        self.assertLess(len(session["last_successful_request"]), 200)

        self.assertEqual(len(pack["recent_turns"]), 2)
        self.assertLess(len(pack["recent_turns"][0]["text"]), 300)
        self.assertLess(len(pack["recent_turns"][0]["payload"]["notes"]), 300)
        self.assertLess(len(pack["retrieved_memories"][0]["memory_text"]), 300)
        self.assertLessEqual(len(pack["retrieved_memories"][0]["tags"]), 8)
        self.assertNotIn("payload", pack["retrieved_memories"][0])
        self.assertLess(len(pack["recent_memory_events"][0]["payload"]["query"]), 300)
        self.assertLessEqual(len(pack["recent_memory_events"][0]["payload"]["tags"]), 8)
        self.assertLessEqual(len(pack["playback_context"]["recent_tracks"]), 5)
        self.assertLessEqual(len(pack["playback_context"]["ready_queue"]), 8)
        self.assertLess(len(pack["playback_context"]["ready_queue"][0]["reason"]), 200)
        self.assertNotIn("unneeded", pack["playback_context"])

    async def test_dict_decision_updates_session_memory_and_event_payload(self):
        store = RecordingStore()
        manager = DJMemoryManager(store)
        decision = {
            "understood_intent": "More nocturnes",
            "action": "play",
            "raw_text": "继续肖邦",
            "queue_policy": {"duration_tracks": 4},
            "music_task": {"type": "artist_style", "query": "Chopin nocturnes", "tags": ["classical", "piano"]},
            "memory_update": {"negative_constraints": ["avoid pop", "avoid vocals"]},
        }

        memory = await manager.apply_decision_update("42", 7, "继续肖邦", decision)

        self.assertEqual(memory["active_mode"]["expires_after_tracks"], 4)
        self.assertEqual(memory["active_mode"]["seed_task"]["query"], "Chopin nocturnes")
        self.assertEqual(memory["active_mode"]["understood_intent"], "More nocturnes")
        self.assertEqual(memory["current_constraints"], ["avoid pop", "avoid vocals"])
        self.assertEqual(memory["last_successful_request"], "继续肖邦")
        self.assertEqual(store.logged_event["payload"]["understood_intent"], "More nocturnes")
        self.assertEqual(store.logged_event["payload"]["action"], "play")
        self.assertEqual(store.logged_event["payload"]["memory_update"]["negative_constraints"], ["avoid pop", "avoid vocals"])
        self.assertEqual(store.logged_event["payload"]["music_task"]["query"], "Chopin nocturnes")

    async def test_store_read_failures_return_usable_context_pack(self):
        manager = DJMemoryManager(FailingReadStore())

        pack = await manager.build_context_pack(
            uid="42",
            session_id=7,
            user_message="继续",
            playback_context={"current_track": {"name": "Nocturne"}},
        )

        self.assertEqual(pack["user_message"], "继续")
        self.assertEqual(pack["session_working_memory"], {})
        self.assertEqual(pack["retrieved_memories"], [])
        self.assertEqual(pack["recent_memory_events"], [])
        self.assertEqual(pack["playback_context"]["current_track"]["name"], "Nocturne")

    async def test_store_write_failures_do_not_raise_and_set_last_error(self):
        manager = DJMemoryManager(RecordingStore(fail_writes=True))
        decision = {
            "understood_intent": "More nocturnes",
            "queue_policy": {"duration_tracks": 2},
            "music_task": {"type": "classical"},
        }

        memory = await manager.apply_decision_update("42", 7, "继续", decision)

        self.assertEqual(memory["active_mode"]["expires_after_tracks"], 2)
        self.assertIn("save failed", manager.last_error)
