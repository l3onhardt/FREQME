import os
import tempfile
import unittest

from backend.memory.models import init_db
from backend.memory.store import MemoryStore


class AudioResolutionStoreTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        os.environ["RADIO_DB_PATH"] = os.path.join(self.tmp.name, "radio.db")
        await init_db()
        self.store = MemoryStore()

    async def asyncTearDown(self):
        self.tmp.cleanup()
        os.environ.pop("RADIO_DB_PATH", None)

    async def test_audio_cache_round_trip(self):
        await self.store.save_audio_resolution(
            song_id="42",
            url="https://example.test/42.mp3",
            source="song_url",
            content_type="audio/mpeg",
        )

        cached = await self.store.get_audio_resolution("42")

        self.assertEqual(cached["song_id"], "42")
        self.assertEqual(cached["url"], "https://example.test/42.mp3")
        self.assertEqual(cached["source"], "song_url")
        self.assertEqual(cached["content_type"], "audio/mpeg")

    async def test_failed_track_blocks_recent_replay(self):
        await self.store.log_playback_event(
            uid="u1",
            song_id="bad",
            event_type="url_failed",
            reason="empty_url",
        )

        self.assertTrue(await self.store.was_track_recently_failed("bad", uid="u1"))
        self.assertFalse(await self.store.was_track_recently_failed("other", uid="u1"))
