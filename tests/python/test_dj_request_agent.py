import unittest

from backend.engines.dj_request_agent import DJRequestAgent


class FakeLLM:
    def __init__(self, response):
        self.response = response
        self.calls = []

    async def chat(self, prompt, max_tokens=300, system=None):
        self.calls.append({"prompt": prompt, "max_tokens": max_tokens, "system": system})
        return self.response


class JsonModeLLM:
    def __init__(self, response):
        self.response = response
        self.calls = []

    async def chat(self, prompt, max_tokens=300, system=None, response_format=None):
        self.calls.append({
            "prompt": prompt,
            "max_tokens": max_tokens,
            "system": system,
            "response_format": response_format,
        })
        return self.response


class RaisingLLM:
    def __init__(self):
        self.calls = []

    async def chat(self, prompt, max_tokens=300, system=None):
        self.calls.append({"prompt": prompt, "max_tokens": max_tokens, "system": system})
        raise RuntimeError("llm unavailable")


class MappingLLM:
    def __init__(self, mapping):
        self.mapping = mapping
        self.calls = []

    async def chat(self, prompt, max_tokens=300, system=None):
        self.calls.append({"prompt": prompt, "max_tokens": max_tokens, "system": system})
        user_message = self._user_message_from_prompt(prompt)
        return self.mapping.get(user_message, """
        {
          "action": "ask_clarifying_question",
          "understood_intent": "unclear",
          "music_task": {"type": "unclear", "search_goals": []},
          "queue_policy": {"duration_tracks": 0, "continue_direction": false},
          "uncertainty": {"level": "high", "should_ask_user": true},
          "dj_response": {"speak_now": "这个我没接稳，是想听某个歌手，还是这种氛围？"},
          "memory_update": {"session_preference": [], "negative_constraints": []}
        }
        """)

    def _user_message_from_prompt(self, prompt):
        marker = "User just spoke to the AI radio DJ:\n"
        context_marker = "\n\nContext pack JSON:"
        if marker not in prompt or context_marker not in prompt:
            return ""
        return prompt.split(marker, 1)[1].split(context_marker, 1)[0].strip()


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

    async def test_json_mode_is_requested_for_intent_parsing(self):
        llm = JsonModeLLM("""
        {
          "action": "set_direction_and_play",
          "music_task": {"primary_entities": [{"role": "artist", "name": "Radiohead"}]},
          "dj_response": {"speak_now": "接上。"}
        }
        """)
        agent = DJRequestAgent(llm)

        await agent.decide("来点Radiohead", context_pack={})

        self.assertEqual(llm.calls[0]["response_format"], {"type": "json_object"})

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

        decision = await agent.decide("???", context_pack={})

        self.assertEqual(decision.action, "ask_clarifying_question")
        self.assertEqual(decision.uncertainty["level"], "high")

    async def test_accidental_single_letter_prefix_before_clear_request_is_ignored(self):
        llm = MappingLLM({
            "我要听肖邦": """
            {
              "action": "set_direction_and_play",
              "understood_intent": "User wants Chopin.",
              "music_task": {
                "type": "artist_work_direction",
                "primary_entities": [{"role": "composer", "name": "Frederic Chopin"}],
                "search_goals": ["Chopin Nocturnes", "Chopin Ballades"],
                "must_not_search_literal_user_sentence": true
              },
              "queue_policy": {"duration_tracks": 5, "continue_direction": true},
              "uncertainty": {"level": "low", "should_ask_user": false},
              "dj_response": {"speak_now": "我先接肖邦这条线。"},
              "memory_update": {"session_preference": ["Chopin"], "negative_constraints": []}
            }
            """,
            "来点Bill Evans": """
            {
              "action": "set_direction_and_play",
              "understood_intent": "User wants Bill Evans.",
              "music_task": {
                "type": "artist_direction",
                "primary_entities": [{"role": "artist", "name": "Bill Evans"}],
                "search_goals": ["Bill Evans Waltz for Debby"],
                "must_not_search_literal_user_sentence": true
              },
              "queue_policy": {"duration_tracks": 4, "continue_direction": true},
              "uncertainty": {"level": "low", "should_ask_user": false},
              "dj_response": {"speak_now": "我先接 Bill Evans。"},
              "memory_update": {"session_preference": ["Bill Evans"], "negative_constraints": []}
            }
            """,
        })
        agent = DJRequestAgent(llm)

        chopin = await agent.decide("w我要听肖邦", context_pack={})
        bill_evans = await agent.decide("q来点Bill Evans", context_pack={})

        self.assertEqual(chopin.action, "set_direction_and_play")
        self.assertEqual(chopin.raw_text, "我要听肖邦")
        self.assertEqual(chopin.music_task["primary_entities"][0]["name"], "Frederic Chopin")
        self.assertEqual(bill_evans.action, "set_direction_and_play")
        self.assertEqual(bill_evans.raw_text, "来点Bill Evans")
        self.assertNotIn("w我要听肖邦", llm.calls[0]["prompt"])
        self.assertNotIn("q来点Bill Evans", llm.calls[1]["prompt"])

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

    async def test_blank_search_goals_and_empty_entities_fall_back(self):
        agent = DJRequestAgent(FakeLLM("""
        {
          "action": "play_now",
          "music_task": {
            "search_goals": ["   "],
            "primary_entities": [{}]
          }
        }
        """))

        decision = await agent.decide("放点东西", context_pack={})

        self.assertEqual(decision.action, "ask_clarifying_question")
        self.assertEqual(decision.music_task["search_goals"], [])
        self.assertEqual(decision.music_task["primary_entities"], [])

    async def test_valid_entity_with_blank_role_defaults_to_music_entity(self):
        agent = DJRequestAgent(FakeLLM("""
        {
          "action": "set_direction_and_play",
          "music_task": {
            "primary_entities": [{"role": "   ", "name": "Björk"}]
          }
        }
        """))

        decision = await agent.decide("来点bjork", context_pack={})

        self.assertEqual(decision.action, "set_direction_and_play")
        self.assertEqual(
            decision.music_task["primary_entities"],
            [{"role": "music_entity", "name": "Björk"}],
        )

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

        decision = await agent.decide("???", context_pack={})

        self.assertEqual(decision.action, "ask_clarifying_question")
        self.assertEqual(decision.uncertainty["level"], "high")

    async def test_llm_exception_structures_clear_entity_request_without_asking(self):
        llm = RaisingLLM()
        agent = DJRequestAgent(llm)

        decision = await agent.decide("我要听齐默尔曼", context_pack={})

        self.assertEqual(decision.action, "set_direction_and_play")
        self.assertEqual(decision.music_task["type"], "artist_direction")
        self.assertEqual(
            decision.music_task["primary_entities"],
            [{"role": "music_entity", "name": "齐默尔曼"}],
        )
        self.assertEqual(decision.music_task["search_goals"], ["齐默尔曼"])
        self.assertFalse(decision.uncertainty["should_ask_user"])
        self.assertNotIn("没接稳", decision.dj_response["speak_now"])
        self.assertNotIn("我要听齐默尔曼", decision.music_task["search_goals"])
        self.assertIn("我要听齐默尔曼", llm.calls[0]["prompt"])

    async def test_model_clarification_for_performer_work_request_is_overridden(self):
        agent = DJRequestAgent(FakeLLM("""
        {
          "action": "ask_clarifying_question",
          "understood_intent": "unclear",
          "music_task": {"type": "unclear", "search_goals": []},
          "queue_policy": {"duration_tracks": 0, "continue_direction": false},
          "uncertainty": {"level": "high", "should_ask_user": true},
          "dj_response": {"speak_now": "这个我没接稳，是想听某个歌手，还是这种氛围？"},
          "memory_update": {"session_preference": [], "negative_constraints": []}
        }
        """))

        decision = await agent.decide("我想听齐默尔曼的肖邦", context_pack={})

        self.assertEqual(decision.action, "set_direction_and_play")
        self.assertEqual(decision.music_task["type"], "artist_work_direction")
        self.assertEqual(
            decision.music_task["primary_entities"],
            [
                {"role": "performer", "name": "齐默尔曼"},
                {"role": "work", "name": "肖邦"},
            ],
        )
        self.assertEqual(decision.music_task["work_hint"], "肖邦")
        self.assertEqual(decision.music_task["search_goals"], ["齐默尔曼 肖邦"])
        self.assertTrue(decision.queue_policy["continue_direction"])
        self.assertFalse(decision.uncertainty["should_ask_user"])

    async def test_bare_entity_request_is_playable_when_model_asks(self):
        agent = DJRequestAgent(FakeLLM("""
        {
          "action": "ask_clarifying_question",
          "understood_intent": "unclear",
          "music_task": {"type": "unclear", "search_goals": []},
          "queue_policy": {"duration_tracks": 0, "continue_direction": false},
          "uncertainty": {"level": "high", "should_ask_user": true},
          "dj_response": {"speak_now": "这个我没接稳，是想听某个歌手，还是这种氛围？"},
          "memory_update": {"session_preference": [], "negative_constraints": []}
        }
        """))

        decision = await agent.decide("齐默尔曼", context_pack={})

        self.assertEqual(decision.action, "set_direction_and_play")
        self.assertEqual(decision.music_task["type"], "artist_direction")
        self.assertEqual(
            decision.music_task["primary_entities"],
            [{"role": "music_entity", "name": "齐默尔曼"}],
        )
        self.assertEqual(decision.music_task["search_goals"], ["齐默尔曼"])
        self.assertFalse(decision.uncertainty["should_ask_user"])
        self.assertNotIn("没接稳", decision.dj_response["speak_now"])

    async def test_bare_latin_entity_request_is_playable_when_model_unavailable(self):
        agent = DJRequestAgent(RaisingLLM())

        decision = await agent.decide("Zimerman", context_pack={})

        self.assertEqual(decision.action, "set_direction_and_play")
        self.assertEqual(decision.music_task["search_goals"], ["Zimerman"])
        self.assertFalse(decision.uncertainty["should_ask_user"])

    async def test_model_clarification_for_colloquial_entity_request_is_overridden(self):
        agent = DJRequestAgent(FakeLLM("""
        {
          "action": "ask_clarifying_question",
          "understood_intent": "unclear",
          "music_task": {"type": "unclear", "search_goals": []},
          "queue_policy": {"duration_tracks": 0, "continue_direction": false},
          "uncertainty": {"level": "high", "should_ask_user": true},
          "dj_response": {"speak_now": "这个我没接稳，是想听某个歌手，还是这种氛围？"},
          "memory_update": {"session_preference": [], "negative_constraints": []}
        }
        """))

        decision = await agent.decide("能不能放点收音机头的", context_pack={})

        self.assertEqual(decision.action, "set_direction_and_play")
        self.assertEqual(decision.music_task["type"], "artist_direction")
        self.assertEqual(
            decision.music_task["primary_entities"],
            [{"role": "music_entity", "name": "收音机头"}],
        )
        self.assertEqual(decision.music_task["search_goals"], ["收音机头"])
        self.assertFalse(decision.uncertainty["should_ask_user"])
        self.assertNotIn("没接稳", decision.dj_response["speak_now"])

    async def test_llm_exception_structures_scene_constraint_without_asking(self):
        agent = DJRequestAgent(RaisingLLM())

        decision = await agent.decide("放点晚上听的，别这么炸", context_pack={})

        self.assertEqual(decision.action, "set_direction_and_play")
        self.assertEqual(decision.music_task["type"], "scene_genre_direction")
        self.assertIn("晚上", decision.music_task["style_hint"])
        self.assertIn("Joji Slow Dancing in the Dark", decision.music_task["search_goals"])
        self.assertIn("Cigarettes After Sex Apocalypse", decision.music_task["search_goals"])
        self.assertNotEqual(decision.music_task["search_goals"][0], "放点晚上听的，别这么炸")
        self.assertTrue(decision.queue_policy["continue_direction"])
        self.assertFalse(decision.uncertainty["should_ask_user"])
        self.assertNotIn("没接稳", decision.dj_response["speak_now"])

    async def test_model_clarification_for_english_scene_request_is_overridden(self):
        agent = DJRequestAgent(FakeLLM("""
        {
          "action": "ask_clarifying_question",
          "understood_intent": "unclear",
          "music_task": {"type": "unclear", "search_goals": []},
          "queue_policy": {"duration_tracks": 0, "continue_direction": false},
          "uncertainty": {"level": "high", "should_ask_user": true},
          "dj_response": {"speak_now": "这个我没接稳，是想听某个歌手，还是这种氛围？"},
          "memory_update": {"session_preference": [], "negative_constraints": []}
        }
        """))

        decision = await agent.decide(
            "play something like late night low-key rnb, not too loud",
            context_pack={},
        )

        self.assertEqual(decision.action, "set_direction_and_play")
        self.assertEqual(decision.music_task["type"], "scene_genre_direction")
        self.assertIn("R&B", decision.music_task["style_hint"])
        self.assertIn("低刺激", decision.music_task["style_hint"])
        self.assertIn("SZA Good Days", decision.music_task["search_goals"])
        self.assertIn("Daniel Caesar Best Part", decision.music_task["search_goals"])
        self.assertTrue(decision.queue_policy["continue_direction"])
        self.assertFalse(decision.uncertainty["should_ask_user"])

    async def test_scene_request_search_goals_are_concrete_tracks_not_playlists(self):
        agent = DJRequestAgent(FakeLLM("""
        {
          "action": "set_direction_and_play",
          "understood_intent": "quiet late-night music",
          "music_task": {
            "type": "scene_genre_direction",
            "primary_entities": [{"role": "genre", "name": "舒缓流行"}],
            "style_hint": "晚上、放松、舒缓、非炸裂",
            "search_goals": ["晚上放松舒缓歌曲", "安静夜晚歌单", "夜晚氛围音乐", "晚上 安静 放松 夜晚 mellow 安静 不炸"],
            "must_not_search_literal_user_sentence": true
          },
          "queue_policy": {"duration_tracks": 3, "continue_direction": true},
          "uncertainty": {"level": "low", "should_ask_user": false},
          "dj_response": {"speak_now": "换上晚上听的。"},
          "memory_update": {"session_preference": ["晚上场景"], "negative_constraints": ["避免炸"]}
        }
        """))

        decision = await agent.decide("放点晚上听的，别这么炸", context_pack={})

        self.assertIn("Joji Slow Dancing in the Dark", decision.music_task["search_goals"])
        self.assertIn("Cigarettes After Sex Apocalypse", decision.music_task["search_goals"])
        self.assertNotIn("安静夜晚歌单", decision.music_task["search_goals"])
        self.assertNotIn("夜晚氛围音乐", decision.music_task["search_goals"])
        self.assertNotIn("晚上 安静 放松 夜晚 mellow 安静 不炸", decision.music_task["search_goals"])
