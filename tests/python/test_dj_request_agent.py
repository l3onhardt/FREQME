import unittest

from backend.engines.dj_request_agent import DJRequestAgent


class FakeLLM:
    def __init__(self, response):
        self.response = response
        self.calls = []

    async def chat(self, prompt, max_tokens=300, system=None):
        self.calls.append({"prompt": prompt, "max_tokens": max_tokens, "system": system})
        return self.response


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
