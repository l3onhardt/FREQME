import asyncio
import os
import tempfile
import unittest
from pathlib import Path


class MemoryStoreSettingsTest(unittest.TestCase):
    def setUp(self):
        self._original_radio_db_path = os.environ.get("RADIO_DB_PATH")
        self.addCleanup(self._restore_radio_db_path)

    def _restore_radio_db_path(self):
        if self._original_radio_db_path is None:
            os.environ.pop("RADIO_DB_PATH", None)
        else:
            os.environ["RADIO_DB_PATH"] = self._original_radio_db_path

    def test_saves_and_loads_auth_account_and_user_settings(self):
        with tempfile.TemporaryDirectory() as tmp:
            os.environ["RADIO_DB_PATH"] = str(Path(tmp) / "radio-test.db")

            from backend.memory.models import init_db
            from backend.memory.store import MemoryStore

            async def run():
                await init_db()
                store = MemoryStore()
                await store.save_auth_account(
                    "42",
                    {"userId": 42, "nickname": "阿测", "avatarUrl": "x"},
                )
                await store.save_user_settings(
                    "42",
                    {
                        "display_name": "小林",
                        "voice_preset": "warm_male",
                        "music_notes": "最近想听安静一点",
                        "current_mode": "专注",
                    },
                )

                account = await store.get_auth_account("42")
                settings = await store.get_user_settings("42")

                self.assertEqual(account["nickname"], "阿测")
                self.assertEqual(settings["display_name"], "小林")
                self.assertEqual(settings["voice_preset"], "warm_male")
                self.assertEqual(settings["current_mode"], "专注")

            asyncio.run(run())

    def test_missing_account_and_settings_return_none(self):
        with tempfile.TemporaryDirectory() as tmp:
            os.environ["RADIO_DB_PATH"] = str(Path(tmp) / "radio-test.db")

            from backend.memory.models import init_db
            from backend.memory.store import MemoryStore

            async def run():
                await init_db()
                store = MemoryStore()

                self.assertIsNone(await store.get_auth_account("missing"))
                self.assertIsNone(await store.get_user_settings("missing"))

            asyncio.run(run())

    def test_auth_account_and_settings_upsert_replaces_existing_payload(self):
        with tempfile.TemporaryDirectory() as tmp:
            os.environ["RADIO_DB_PATH"] = str(Path(tmp) / "radio-test.db")

            from backend.memory.models import init_db
            from backend.memory.store import MemoryStore

            async def run():
                await init_db()
                store = MemoryStore()

                await store.save_auth_account("42", {"nickname": "old"})
                await store.save_auth_account("42", {"nickname": "new"})
                await store.save_user_settings("42", {"voice_preset": "calm"})
                await store.save_user_settings("42", {"voice_preset": "bright"})

                self.assertEqual(
                    await store.get_auth_account("42"), {"nickname": "new"}
                )
                self.assertEqual(
                    await store.get_user_settings("42"), {"voice_preset": "bright"}
                )

            asyncio.run(run())

    def test_dj_memory_event_session_and_user_memory_round_trip(self):
        with tempfile.TemporaryDirectory() as tmp:
            os.environ["RADIO_DB_PATH"] = str(Path(tmp) / "radio-test.db")

            from backend.memory.models import init_db
            from backend.memory.store import MemoryStore

            async def run():
                await init_db()
                store = MemoryStore()

                event_id = await store.log_dj_memory_event(
                    uid="42",
                    session_id=7,
                    event_type="user_request",
                    raw_text="我要听齐默尔曼的肖邦",
                    payload={
                        "agent_understanding": "Zimerman / Chopin",
                        "entities": ["Krystian Zimerman", "Chopin"],
                        "tags": ["classical", "piano"],
                        "importance": 0.82,
                    },
                )
                self.assertIsInstance(event_id, int)

                await store.save_dj_session_memory(
                    uid="42",
                    session_id=7,
                    memory={
                        "active_mode": {
                            "label": "Zimerman / Chopin",
                            "expires_after_tracks": 4,
                        }
                    },
                )
                await store.upsert_dj_user_memory(
                    uid="42",
                    memory_key="avoid_overplayed_chinese_pop",
                    memory_text="User dislikes overplayed Chinese pop.",
                    confidence=0.78,
                    evidence_count=5,
                    tags=["negative_feedback", "taste"],
                )

                session_memory = await store.get_dj_session_memory("42", 7)
                user_memories = await store.get_dj_user_memories("42", tags=["taste"])
                events = await store.get_recent_dj_memory_events("42", limit=5)

                self.assertEqual(session_memory["active_mode"]["label"], "Zimerman / Chopin")
                self.assertEqual(user_memories[0]["memory_key"], "avoid_overplayed_chinese_pop")
                self.assertEqual(events[0]["raw_text"], "我要听齐默尔曼的肖邦")
                self.assertEqual(events[0]["payload"]["importance"], 0.82)
                self.assertEqual(events[0]["importance"], 0.82)

            asyncio.run(run())

    def test_dj_user_memories_filter_by_tags_before_applying_limit(self):
        with tempfile.TemporaryDirectory() as tmp:
            os.environ["RADIO_DB_PATH"] = str(Path(tmp) / "radio-test.db")

            from backend.memory.models import init_db
            from backend.memory.store import MemoryStore

            async def run():
                await init_db()
                store = MemoryStore()

                await store.upsert_dj_user_memory(
                    uid="42",
                    memory_key="high_confidence_unrelated",
                    memory_text="User likes high confidence unrelated songs.",
                    confidence=0.99,
                    evidence_count=3,
                    tags=["unrelated"],
                )
                await store.upsert_dj_user_memory(
                    uid="42",
                    memory_key="lower_confidence_taste",
                    memory_text="User prefers late-night piano.",
                    confidence=0.4,
                    evidence_count=2,
                    tags=["taste"],
                )

                memories = await store.get_dj_user_memories("42", tags=["taste"], limit=1)

                self.assertEqual(len(memories), 1)
                self.assertEqual(memories[0]["memory_key"], "lower_confidence_taste")

            asyncio.run(run())

    def test_dj_memory_event_preserves_zero_payload_importance(self):
        with tempfile.TemporaryDirectory() as tmp:
            os.environ["RADIO_DB_PATH"] = str(Path(tmp) / "radio-test.db")

            from backend.memory.models import init_db
            from backend.memory.store import MemoryStore

            async def run():
                await init_db()
                store = MemoryStore()

                await store.log_dj_memory_event(
                    uid="42",
                    session_id=7,
                    event_type="user_request",
                    payload={"importance": 0},
                )

                events = await store.get_recent_dj_memory_events("42", limit=1)

                self.assertEqual(events[0]["payload"]["importance"], 0)
                self.assertEqual(events[0]["importance"], 0)

            asyncio.run(run())

    def test_recent_tracks_are_scoped_by_uid_with_legacy_fallback(self):
        with tempfile.TemporaryDirectory() as tmp:
            os.environ["RADIO_DB_PATH"] = str(Path(tmp) / "radio-test.db")

            from backend.memory.models import connect_db, init_db
            from backend.memory.store import MemoryStore

            async def run():
                await init_db()
                store = MemoryStore()

                await store.log_track("user-a-song", "A Song", "A Artist", "test", uid="user-a")
                await store.log_track("user-b-song", "B Song", "B Artist", "test", uid="user-b")

                self.assertEqual(await store.get_recent_tracks(uid="user-a"), ["user-a-song"])
                self.assertEqual(await store.get_recent_tracks(uid="user-b"), ["user-b-song"])

                async with connect_db() as db:
                    await db.execute(
                        "INSERT INTO track_log (song_id, song_name, artist, source) VALUES (?,?,?,?)",
                        ("legacy-song", "Legacy Song", "Legacy Artist", "test"),
                    )
                    await db.commit()

                self.assertIn("legacy-song", await store.get_recent_tracks())
                self.assertNotIn("legacy-song", await store.get_recent_tracks(uid="user-a"))

            asyncio.run(run())

    def test_init_db_migrates_legacy_track_log_without_uid(self):
        with tempfile.TemporaryDirectory() as tmp:
            os.environ["RADIO_DB_PATH"] = str(Path(tmp) / "radio-test.db")

            from backend.memory.models import connect_db, init_db

            async def run():
                async with connect_db() as db:
                    await db.execute("""
                        CREATE TABLE track_log (
                            id INTEGER PRIMARY KEY AUTOINCREMENT,
                            song_id TEXT NOT NULL,
                            song_name TEXT NOT NULL,
                            artist TEXT,
                            source TEXT,
                            feedback TEXT,
                            played_at TEXT DEFAULT CURRENT_TIMESTAMP
                        )
                    """)
                    await db.execute(
                        "INSERT INTO track_log (song_id, song_name, artist, source) VALUES (?,?,?,?)",
                        ("legacy-song", "Legacy Song", "Legacy Artist", "test"),
                    )
                    await db.commit()

                await init_db()

                async with connect_db() as db:
                    async with db.execute("PRAGMA table_info(track_log)") as cursor:
                        columns = {row[1] for row in await cursor.fetchall()}
                    async with db.execute(
                        "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_track_uid_played'"
                    ) as cursor:
                        index_row = await cursor.fetchone()

                self.assertIn("uid", columns)
                self.assertIsNotNone(index_row)

            asyncio.run(run())

    def test_init_db_creates_default_parent_directory(self):
        os.environ.pop("RADIO_DB_PATH", None)

        with tempfile.TemporaryDirectory() as tmp:
            original_cwd = os.getcwd()
            try:
                os.chdir(tmp)

                from backend.memory.models import init_db

                asyncio.run(init_db())

                self.assertTrue((Path(tmp) / "data" / "radio.db").exists())
            finally:
                os.chdir(original_cwd)


if __name__ == "__main__":
    unittest.main()
