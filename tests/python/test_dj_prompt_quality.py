import unittest

from backend.engines.dj import DJEngine


class FakeLLM:
    def __init__(self):
        self.calls = []

    async def chat(self, prompt, max_tokens=300, system=None):
        self.calls.append({
            "prompt": prompt,
            "max_tokens": max_tokens,
            "system": system,
        })
        return "llm generated"


class FakeContext:
    def to_prompt_text(self):
        return "刚刚说过夜色和鼓点。"


class DJPromptQualityTests(unittest.IsolatedAsyncioTestCase):
    async def test_segue_prompt_binds_current_next_song_and_clear_radio_constraints(self):
        llm = FakeLLM()
        engine = DJEngine(llm, store=None)

        await engine.generate_segue(
            {"personality": {"traits": ["安静"]}, "dj_style_suggestion": "知性、克制"},
            "深夜",
            {"id": "1", "name": "旧梦", "ar": [{"name": "甲"}]},
            {
                "id": "2",
                "name": "新雨",
                "ar": [{"name": "乙"}],
                "selection_reason": {"text": "从慢速人声过渡到更轻的器乐"},
            },
            FakeContext(),
            user_settings={"current_mode": "陪伴", "music_notes": "少说套话"},
        )

        prompt = llm.calls[0]["prompt"]
        self.assertIn("旧梦 - 甲", prompt)
        self.assertIn("新雨 - 乙", prompt)
        self.assertIn("从慢速人声过渡到更轻的器乐", prompt)
        self.assertIn("只输出主播要说的话", prompt)
        self.assertIn("不要使用“推荐”", prompt)
        self.assertNotIn("鏄", prompt)
        self.assertNotIn("歿", prompt)
