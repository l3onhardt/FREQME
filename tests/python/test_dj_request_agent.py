import unittest

from backend.engines.dj_request_agent import DJRequestAgent


class FakeLLM:
    def __init__(self, response):
        self.response = response
        self.calls = []

    async def chat(self, prompt, max_tokens=300, system=None):
        self.calls.append({"prompt": prompt, "max_tokens": max_tokens, "system": system})
        return self.response


class RaisingLLM:
    async def chat(self, prompt, max_tokens=300, system=None):
        raise RuntimeError("llm unavailable")


class DJRequestAgentTests(unittest.IsolatedAsyncioTestCase):
    async def test_radiohead_request_becomes_music_task_not_literal_search(self):
        llm = FakeLLM("""
        {
          "action": "set_direction_and_play",
          "understood_intent": "User wants Radiohead songs.",
          "music_task": {
            "type": "artist_direction",
            "primary_entities": [{"role": "artist", "name": "Radiohead"}],
            "search_goals": ["Radiohead Weird Fishes", "Radiohead No Surprises"],
            "must_not_search_literal_user_sentence": true
          },
          "queue_policy": {"duration_tracks": 4, "continue_direction": true},
          "uncertainty": {"level": "low", "should_ask_user": false},
          "dj_response": {"speak_now": "懂了，我先把它接到 Radiohead 这条线上。"},
          "memory_update": {"session_preference": ["Radiohead direction"], "negative_constraints": []}
        }
        """)
        agent = DJRequestAgent(llm)

        decision = await agent.decide(
            user_message="不能放点radiohead的吗",
            context_pack={
                "user_profile_digest": "likes textured alternative rock",
                "session_working_memory": {},
                "playback_context": {},
            },
        )

        self.assertEqual(decision.action, "set_direction_and_play")
        self.assertEqual(decision.music_task["primary_entities"][0]["name"], "Radiohead")
        self.assertTrue(decision.music_task["must_not_search_literal_user_sentence"])
        self.assertNotIn("不能放点radiohead的吗", decision.music_task["search_goals"])
        self.assertIn("Do not search", llm.calls[0]["prompt"])

    async def test_invalid_json_returns_safe_clarifying_decision(self):
        agent = DJRequestAgent(FakeLLM("not json"))

        decision = await agent.decide("???", context_pack={})

        self.assertEqual(decision.action, "ask_clarifying_question")
        self.assertEqual(decision.uncertainty["level"], "high")
        self.assertTrue(decision.dj_response["speak_now"])

    async def test_fenced_prose_json_parsing_succeeds_and_skips_invalid_braces(self):
        agent = DJRequestAgent(FakeLLM("""
        I first thought {this is not json}.

        ```json
        {
          "action": "play_now",
          "music_task": {
            "type": "specific_track",
            "search_goals": ["Massive Attack Teardrop"]
          },
          "dj_response": {"speak_now": "接上。"}
        }
        ```
        """))

        decision = await agent.decide("来点teardrop", context_pack={})

        self.assertEqual(decision.action, "play_now")
        self.assertEqual(decision.music_task["search_goals"], ["Massive Attack Teardrop"])

    async def test_invalid_action_enum_falls_back(self):
        agent = DJRequestAgent(FakeLLM("""
        {
          "action": "search_the_web",
          "music_task": {"search_goals": ["Radiohead Creep"]}
        }
        """))

        decision = await agent.decide("放radiohead", context_pack={})

        self.assertEqual(decision.action, "ask_clarifying_question")
        self.assertEqual(decision.uncertainty["level"], "high")

    async def test_playable_action_with_empty_music_task_falls_back(self):
        agent = DJRequestAgent(FakeLLM("""
        {
          "action": "play_now",
          "music_task": {}
        }
        """))

        decision = await agent.decide("放点东西", context_pack={})

        self.assertEqual(decision.action, "ask_clarifying_question")
        self.assertEqual(decision.music_task["type"], "unclear")

    async def test_model_cannot_disable_literal_search_guard(self):
        agent = DJRequestAgent(FakeLLM("""
        {
          "action": "play_now",
          "music_task": {
            "type": "specific_track",
            "search_goals": ["Radiohead Nude"],
            "must_not_search_literal_user_sentence": false
          }
        }
        """))

        decision = await agent.decide("radiohead nude", context_pack={})

        self.assertTrue(decision.music_task["must_not_search_literal_user_sentence"])

    async def test_nonnumeric_and_excessive_duration_are_coerced_and_clamped(self):
        nonnumeric = DJRequestAgent(FakeLLM("""
        {
          "action": "play_now",
          "music_task": {"search_goals": ["Portishead Roads"]},
          "queue_policy": {"duration_tracks": "many"}
        }
        """))
        excessive = DJRequestAgent(FakeLLM("""
        {
          "action": "set_direction_and_play",
          "music_task": {"primary_entities": [{"role": "artist", "name": "Portishead"}]},
          "queue_policy": {"duration_tracks": 99}
        }
        """))

        nonnumeric_decision = await nonnumeric.decide("roads", context_pack={})
        excessive_decision = await excessive.decide("portishead", context_pack={})

        self.assertEqual(nonnumeric_decision.queue_policy["duration_tracks"], 1)
        self.assertEqual(excessive_decision.queue_policy["duration_tracks"], 8)
        self.assertIn("avoid_repetition", excessive_decision.queue_policy)

    async def test_missing_memory_update_keys_are_filled(self):
        agent = DJRequestAgent(FakeLLM("""
        {
          "action": "play_now",
          "music_task": {"style_hint": "late night trip hop"},
          "memory_update": {"session_preference": ["trip hop"]}
        }
        """))

        decision = await agent.decide("来点深夜trip hop", context_pack={})

        self.assertEqual(decision.memory_update["session_preference"], ["trip hop"])
        self.assertEqual(decision.memory_update["possible_long_term_preference"], [])
        self.assertEqual(decision.memory_update["negative_constraints"], [])

    async def test_llm_exception_returns_safe_fallback(self):
        agent = DJRequestAgent(RaisingLLM())

        decision = await agent.decide("radiohead", context_pack={})

        self.assertEqual(decision.action, "ask_clarifying_question")
        self.assertEqual(decision.uncertainty["level"], "high")
