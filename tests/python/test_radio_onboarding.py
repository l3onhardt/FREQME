import unittest
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from unittest.mock import patch

from backend.api import auth, radio


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
        self.assertEqual(settings["voice_preset"], "silver_female")
        self.assertEqual(len(settings["display_name"]), 40)
        self.assertEqual(len(settings["music_notes"]), 500)
        self.assertEqual(settings["current_mode"], "陪伴")
        self.assertEqual(self.fake_store.saved, [("42", settings)])

    async def test_save_onboarding_allows_only_two_voice_presets(self):
        result = await radio.save_onboarding(
            42,
            {"voice_preset": "bright_girl", "current_mode": "闄即"},
        )

        self.assertEqual(result["settings"]["voice_preset"], "silver_female")

    async def test_save_onboarding_rejects_uid_that_does_not_match_active_login(self):
        original_auth_netease = auth.netease

        async def login_status():
            return {"data": {"profile": {"userId": 42}}}

        auth.netease = SimpleNamespace(login_status=login_status)
        self.addCleanup(lambda: setattr(auth, "netease", original_auth_netease))

        response = await radio.save_onboarding(
            7,
            {
                "voice_preset": "warm_male",
                "display_name": "Other User",
                "current_mode": "闄即",
            },
        )

        self.assertEqual(response.status_code, 403)
        self.assertEqual(self.fake_store.saved, [])

    async def test_get_onboarding_rejects_uid_that_does_not_match_active_login(self):
        original_auth_netease = auth.netease

        async def login_status():
            return {"data": {"profile": {"userId": 42}}}

        auth.netease = SimpleNamespace(login_status=login_status)
        self.addCleanup(lambda: setattr(auth, "netease", original_auth_netease))

        response = await radio.get_onboarding(7)

        self.assertEqual(response.status_code, 403)

    async def test_get_onboarding_rejects_when_active_login_is_missing(self):
        original_auth_netease = auth.netease

        async def login_status():
            return {"data": {"profile": None}}

        auth.netease = SimpleNamespace(login_status=login_status)
        self.addCleanup(lambda: setattr(auth, "netease", original_auth_netease))

        response = await radio.get_onboarding(42)

        self.assertEqual(response.status_code, 403)

    async def test_safe_tts_hash_requires_md5_length(self):
        self.assertTrue(radio._is_safe_tts_hash("a" * 32))
        self.assertFalse(radio._is_safe_tts_hash("a" * 31))
        self.assertFalse(radio._is_safe_tts_hash("a" * 33))
        self.assertFalse(radio._is_safe_tts_hash("z" * 32))

    async def test_get_tts_serves_file_from_configured_data_dir(self):
        with TemporaryDirectory() as temp_dir:
            cache_dir = radio.Path(temp_dir) / "tts_cache"
            cache_dir.mkdir()
            hash_value = "a" * 32
            wav_path = cache_dir / f"{hash_value}.wav"
            wav_path.write_bytes(b"RIFFtest")

            with patch(
                "backend.api.radio.get_settings",
                return_value=SimpleNamespace(data_dir=temp_dir),
                create=True,
            ):
                response = await radio.get_tts(hash_value)

            self.assertEqual(radio.Path(response.path), wav_path)
            self.assertEqual(response.media_type, "audio/wav")


if __name__ == "__main__":
    unittest.main()
