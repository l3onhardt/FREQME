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
                "presentation_plan": {"segue_mode": "short_segue", "intro_value": "medium"},
            },
            FakeContext(),
            user_settings={"current_mode": "陪伴", "music_notes": "少说套话"},
            presentation_plan={"segue_mode": "short_segue", "intro_value": "medium"},
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
                "presentation_plan": {"segue_mode": "break", "intro_value": "high"},
            },
            FakeContext(),
            user_settings={"current_mode": "陪伴"},
            presentation_plan={"segue_mode": "break", "intro_value": "high"},
        )

        prompt = llm.calls[0]["prompt"]
        self.assertIn("刚刚播过的一组歌", prompt)
        self.assertIn("下一首即将播放：Fourth - D", prompt)
        self.assertIn("专辑：Night Album", prompt)
        self.assertIn("必须点到歌名和艺人", prompt)
        self.assertIn("绝对不要编造幕后故事", prompt)
        self.assertIn("像电台 DJ", prompt)
        self.assertEqual(llm.calls[0]["max_tokens"], 360)

    async def test_intro_prompt_uses_radio_insights_time_location_and_request_intent(self):
        llm = FakeLLM()
        engine = DJEngine(llm, store=None)

        await engine.generate_intro(
            {
                "personality": {"traits": ["夜晚型", "偏爱细腻人声"]},
                "dj_style_suggestion": "温暖、磁性、像懂歌的夜间主播",
                "radio_insights": {
                    "taste_summary": "你常听的不是热闹本身，而是夜里能把心放稳的歌。",
                    "comfort_zone": ["华语慢歌", "细腻男声"],
                    "discovery_direction": ["低饱和独立流行", "城市夜行感"],
                    "dj_talking_points": [
                        "你会反复回到有人声呼吸感的歌。",
                        "熟悉旋律对你更像一个安全地带。",
                    ],
                },
            },
            "深夜",
            user_settings={
                "display_name": "Katz",
                "current_mode": "陪伴",
                "listening_intent": {
                    "raw_text": "想听一点夜路上能放空的歌",
                    "keywords": "夜路 放空 城市",
                    "mood": "夜行感",
                },
                "timezone_name": "Asia/Shanghai",
                "locale": "zh-CN",
                "region_hint": "上海",
            },
        )

        prompt = llm.calls[0]["prompt"]
        self.assertIn("你常听的不是热闹本身", prompt)
        self.assertIn("你会反复回到有人声呼吸感的歌", prompt)
        self.assertIn("想听一点夜路上能放空的歌", prompt)
        self.assertIn("Asia/Shanghai", prompt)
        self.assertIn("上海", prompt)
        self.assertIn("不要说“根据你的画像”", prompt)

    async def test_program_break_prompt_carries_request_intent_without_becoming_mechanical(self):
        llm = FakeLLM()
        engine = DJEngine(llm, store=None)

        await engine.generate_program_break(
            {
                "personality": {"traits": ["安静"]},
                "dj_style_suggestion": "温暖、克制",
                "radio_insights": {
                    "taste_summary": "熟悉旋律像用户的安全地带。",
                    "dj_talking_points": ["用户会被低声部和留白吸引。"],
                },
            },
            "深夜",
            [{"id": "1", "name": "First", "ar": [{"name": "A"}]}],
            {
                "id": "2",
                "name": "Second",
                "ar": [{"name": "B"}],
                "selection_reason": {"text": "回应你刚刚说想听夜路上的歌。"},
                "presentation_plan": {"segue_mode": "ack", "intro_value": "high"},
            },
            FakeContext(),
            user_settings={
                "listening_intent": {
                    "raw_text": "想听夜路上的歌",
                    "keywords": "夜路 城市",
                },
                "timezone_name": "Asia/Shanghai",
                "region_hint": "杭州",
            },
            presentation_plan={"segue_mode": "ack", "intro_value": "high"},
        )

        prompt = llm.calls[0]["prompt"]
        self.assertIn("熟悉旋律像用户的安全地带", prompt)
        self.assertIn("用户会被低声部和留白吸引", prompt)
        self.assertIn("想听夜路上的歌", prompt)
        self.assertIn("杭州", prompt)
        self.assertIn("不要提系统、画像或选曲规则", prompt)

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
