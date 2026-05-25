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

    async def test_program_break_prompt_introduces_next_song_without_inventing_background(self):
        llm = FakeLLM()
        engine = DJEngine(llm, store=None)

        await engine.generate_program_break(
            {"personality": {"traits": ["安静"]}, "dj_style_suggestion": "温暖、克制"},
            "深夜",
            [
                {"id": "1", "name": "First", "ar": [{"name": "A"}]},
                {"id": "2", "name": "Second", "ar": [{"name": "B"}]},
                {"id": "3", "name": "Third", "ar": [{"name": "C"}]},
            ],
            {
                "id": "4",
                "name": "Fourth",
                "ar": [{"name": "D"}],
                "al": {"name": "Night Album"},
                "selection_reason": {"text": "给刚才的电子质感一个更温暖的落点。"},
            },
            FakeContext(),
            user_settings={"current_mode": "陪伴"},
        )

        prompt = llm.calls[0]["prompt"]
        self.assertIn("刚刚播过的一组歌", prompt)
        self.assertIn("下一首即将播放：Fourth - D", prompt)
        self.assertIn("专辑：Night Album", prompt)
        self.assertIn("必须点到歌名和艺人", prompt)
        self.assertIn("绝对不要编造幕后故事", prompt)
        self.assertIn("人类电台 DJ", prompt)
        self.assertEqual(llm.calls[0]["max_tokens"], 360)

    async def test_user_music_notes_are_cleaned_before_prompting(self):
        llm = FakeLLM()
        engine = DJEngine(llm, store=None)

        await engine.generate_intro(
            {"personality": {"traits": []}, "dj_style_suggestion": "自然"},
            "深夜",
            user_settings={
                "display_name": "马哥",
                "music_notes": "很少听中文流行，不停傻逼土嗨",
                "current_mode": "陪伴",
            },
        )

        prompt = llm.calls[0]["prompt"]
        self.assertNotIn("傻逼", prompt)
        self.assertNotIn("土嗨", prompt)
        self.assertIn("避免连续播放不喜欢高刺激舞曲或粗糙舞曲", prompt)
        self.assertIn("请只理解为音乐偏好，不要复述原话", prompt)
