import inspect
import unittest
from unittest.mock import patch

from backend.adapters import tts
from backend.adapters.tts import TTSAdapter


class FakeSettings:
    mimo_api_base = "https://example.test/v1"
    mimo_api_key = "test-key"
    mimo_tts_model = "mimo-v2.5-tts"
    mimo_tts_voice = "冰糖"
    mimo_tts_voice_warm_female = "暖声女主播"
    mimo_tts_voice_warm_male = "磁性男主播"
    mimo_tts_voice_bright_girl = "明亮女主播"
    data_dir = "./data"


class TTSVoicePresetTests(unittest.TestCase):
    def make_adapter(self):
        with patch("backend.adapters.tts.settings", FakeSettings()):
            return TTSAdapter()

    def test_build_request_body_keeps_assistant_content_plain(self):
        adapter = self.make_adapter()

        body = adapter.build_request_body(
            "今晚我们从一首轻柔的歌开始。",
            scene="深夜",
            voice_preset="warm_female",
        )

        self.assertEqual(body["model"], "mimo-v2.5-tts")
        self.assertEqual(
            body["messages"][1],
            {"role": "assistant", "content": "今晚我们从一首轻柔的歌开始。"},
        )
        assistant_content = body["messages"][1]["content"]
        for forbidden in [
            "(温柔)",
            "(慵懒)",
            "(气声)",
            "(娓╂煍)",
            "(鎱垫噿)",
            "(姘斿０)",
        ]:
            self.assertNotIn(forbidden, assistant_content)

    def test_director_prompt_is_restrained_radio_guidance(self):
        adapter = self.make_adapter()

        body = adapter.build_request_body(
            "早安，今天也从音乐里慢慢醒来。",
            scene="清晨",
            voice_preset="bright_girl",
        )
        prompt = body["messages"][0]["content"]

        self.assertIn("电台主播", prompt)
        self.assertIn("克制", prompt)
        self.assertIn("自然", prompt)
        self.assertIn("不要加入奇怪语气词", prompt)
        self.assertIn("拟声词", prompt)
        self.assertIn("夸张重音", prompt)
        self.assertNotIn("(温柔)", prompt)
        self.assertNotIn("二次元", prompt)
        self.assertNotIn("撒娇", prompt)

    def test_audio_voice_resolves_from_preset_with_fallbacks(self):
        adapter = self.make_adapter()

        warm = adapter.build_request_body("你好", voice_preset="warm_female")
        male = adapter.build_request_body("你好", voice_preset="warm_male")
        bright = adapter.build_request_body("你好", voice_preset="bright_girl")
        unknown = adapter.build_request_body("你好", voice_preset="unknown")

        self.assertEqual(warm["audio"]["voice"], "暖声女主播")
        self.assertEqual(male["audio"]["voice"], "磁性男主播")
        self.assertEqual(bright["audio"]["voice"], "明亮女主播")
        self.assertEqual(unknown["audio"]["voice"], "暖声女主播")

    def test_audio_voice_uses_global_fallback_when_preset_voice_empty(self):
        class EmptyPresetSettings(FakeSettings):
            mimo_tts_voice_warm_female = ""

        with patch("backend.adapters.tts.settings", EmptyPresetSettings()):
            adapter = TTSAdapter()

        body = adapter.build_request_body("你好", voice_preset="warm_female")

        self.assertEqual(body["audio"]["voice"], "冰糖")

    def test_hash_changes_with_voice_preset_and_resolved_voice(self):
        adapter = self.make_adapter()

        warm_hash = adapter._hash("同一段话", "日常", voice_preset="warm_female")
        male_hash = adapter._hash("同一段话", "日常", voice_preset="warm_male")

        self.assertNotEqual(warm_hash, male_hash)

        class ChangedVoiceSettings(FakeSettings):
            mimo_tts_voice_warm_female = "另一位暖声女主播"

        with patch("backend.adapters.tts.settings", ChangedVoiceSettings()):
            changed_adapter = TTSAdapter()

        changed_voice_hash = changed_adapter._hash(
            "同一段话",
            "日常",
            voice_preset="warm_female",
        )

        self.assertNotEqual(warm_hash, changed_voice_hash)

    def test_user_settings_voice_preset_remains_supported(self):
        adapter = self.make_adapter()

        body = adapter.build_request_body(
            "午后好。",
            scene="午后",
            voice_preset="unknown",
        )
        resolved = adapter._voice_preset_from_settings(
            {"voice_preset": "warm_male"},
            voice_preset=None,
        )

        self.assertEqual(body["audio"]["voice"], "暖声女主播")
        self.assertEqual(resolved, "warm_male")

    def test_build_request_body_resolves_voice_preset_from_user_settings(self):
        adapter = self.make_adapter()

        body = adapter.build_request_body(
            "hi",
            user_settings={"voice_preset": "warm_male"},
        )

        self.assertEqual(body["audio"]["voice"], "磁性男主播")

    def test_hash_normalizes_legacy_scene_before_building_cache_key(self):
        adapter = self.make_adapter()
        legacy_scene, clean_scene = next(iter(tts.LEGACY_SCENE_ALIASES.items()))

        legacy_hash = adapter._hash(
            "同一段话",
            legacy_scene,
            voice_preset="warm_female",
        )
        clean_hash = adapter._hash(
            "同一段话",
            clean_scene,
            voice_preset="warm_female",
        )

        self.assertEqual(legacy_hash, clean_hash)

    def test_synthesize_default_style_is_clean_daily_scene(self):
        signature = inspect.signature(TTSAdapter.synthesize)

        self.assertEqual(signature.parameters["style"].default, "日常")

    def test_scene_guidance_contains_only_clean_scene_keys(self):
        self.assertEqual(
            set(tts.SCENE_GUIDANCE),
            {"深夜", "清晨", "午后", "日常"},
        )
        for legacy_scene in tts.LEGACY_SCENE_ALIASES:
            self.assertNotIn(legacy_scene, tts.SCENE_GUIDANCE)

    def test_legacy_scene_aliases_normalize_before_director_prompt(self):
        adapter = self.make_adapter()

        self.assertEqual(adapter._normalize_scene("鏃ゅ父"), "日常")
        self.assertEqual(adapter._normalize_scene("娣卞"), "深夜")

        daily_prompt = adapter._director_prompt("日常", "warm_female")
        legacy_daily_prompt = adapter._director_prompt("鏃ゅ父", "warm_female")
        night_prompt = adapter._director_prompt("深夜", "warm_female")
        legacy_night_prompt = adapter._director_prompt("娣卞", "warm_female")

        self.assertEqual(legacy_daily_prompt, daily_prompt)
        self.assertEqual(legacy_night_prompt, night_prompt)


if __name__ == "__main__":
    unittest.main()
