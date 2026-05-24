import unittest

from backend.api import radio


class FakeStore:
    def __init__(self):
        self.profiles = {}
        self.settings = {}
        self.saved = []

    async def get_profile(self, uid):
        return self.profiles.get(uid)

    async def get_user_settings(self, uid):
        return self.settings.get(uid)

    async def save_user_settings(self, uid, payload):
        self.saved.append((uid, payload))
        self.settings[uid] = payload


class RadioOnboardingTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.original_store = radio.store
        self.fake_store = FakeStore()
        radio.store = self.fake_store
        self.addCleanup(self._restore_radio_globals)

    def _restore_radio_globals(self):
        radio.store = self.original_store

    async def test_get_onboarding_reports_profile_and_missing_settings(self):
        self.fake_store.profiles["42"] = {"userId": 42, "nickname": "Tester"}

        result = await radio.get_onboarding(42)

        self.assertEqual(result["profile"], {"userId": 42, "nickname": "Tester"})
        self.assertTrue(result["profile_ready"])
        self.assertIsNone(result["settings"])
        self.assertFalse(result["onboarded"])

    async def test_save_onboarding_sanitizes_payload_and_persists_settings(self):
        result = await radio.save_onboarding(
            42,
            {
                "voice_preset": "invalid",
                "display_name": "  This display name is intentionally longer than forty chars  ",
                "music_notes": " x " * 300,
                "current_mode": "mystery",
            },
        )

        settings = result["settings"]
        self.assertTrue(result["onboarded"])
        self.assertEqual(settings["voice_preset"], "warm_female")
        self.assertEqual(len(settings["display_name"]), 40)
        self.assertEqual(len(settings["music_notes"]), 500)
        self.assertEqual(settings["current_mode"], "陪伴")
        self.assertEqual(self.fake_store.saved, [("42", settings)])


if __name__ == "__main__":
    unittest.main()
