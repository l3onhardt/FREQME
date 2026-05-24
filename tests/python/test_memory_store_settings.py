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
