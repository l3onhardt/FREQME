import unittest

from backend.core.event_bus import EventBus
from backend.engines.scheduler import StreamScheduler


class FakeStore:
    async def get_recent_tracks(self, limit=100, uid=None):
        return []

    async def was_track_recently_failed(self, song_id, uid=None, limit=50):
        return str(song_id) == "bad"


class SchedulerFailedTracksTests(unittest.IsolatedAsyncioTestCase):
    async def test_choose_candidate_skips_recently_failed_song(self):
        scheduler = StreamScheduler(None, FakeStore(), EventBus())
        songs = [
            {"id": "bad", "name": "Broken", "ar": [{"name": "A"}]},
            {"id": "good", "name": "Good", "ar": [{"name": "B"}]},
        ]

        selected = await scheduler._choose_candidate_async(songs, set(), set(), uid="u1")

        self.assertEqual(selected["id"], "good")
