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
