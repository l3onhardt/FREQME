import asyncio
import os
import tempfile
import unittest
from pathlib import Path


class MemoryStoreSettingsTest(unittest.TestCase):
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


if __name__ == "__main__":
    unittest.main()
