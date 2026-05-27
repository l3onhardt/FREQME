import json
import unittest

from backend.engines.dj_request_agent import DJRequestAgent


class MappingLLM:
    def __init__(self, mapping):
        self.mapping = mapping
        self.calls = []

    async def chat(self, prompt, max_tokens=300, system=None):
        self.calls.append({"prompt": prompt, "max_tokens": max_tokens, "system": system})
        user_message = self._user_message_from_prompt(prompt)
        if user_message in self.mapping:
            return json.dumps(self.mapping[user_message], ensure_ascii=False)
        return json.dumps(
            {
                "action": "ask_clarifying_question",
                "understood_intent": "unclear",
                "music_task": {
                    "type": "unclear",
                    "search_goals": [],
                    "must_not_search_literal_user_sentence": True,
                },
                "queue_policy": {"duration_tracks": 0, "continue_direction": False},
                "uncertainty": {"level": "high", "should_ask_user": True},
                "dj_response": {"speak_now": "这个我没接稳，你再给我一点方向。"},
                "memory_update": {"session_preference": [], "negative_constraints": []},
            },
            ensure_ascii=False,
        )

    def _user_message_from_prompt(self, prompt):
        marker = "User just spoke to the AI radio DJ:\n"
        context_marker = "\n\nContext pack JSON:"
        if marker not in prompt or context_marker not in prompt:
            return ""
        return prompt.split(marker, 1)[1].split(context_marker, 1)[0].strip()


class DJAgentProbeMatrixTests(unittest.IsolatedAsyncioTestCase):
    async def test_varied_clear_requests_preserve_structured_task_contract(self):
        mapping = {
            "齐默尔曼的肖邦": self._decision(
                "artist_work_direction",
                [
                    {"role": "performer", "name": "Krystian Zimerman"},
                    {"role": "composer", "name": "Frederic Chopin"},
                ],
                ["Krystian Zimerman Chopin Ballades", "Zimerman Chopin Piano Concerto"],
                duration=4,
            ),
            "鲁宾斯坦弹的肖邦夜曲": self._decision(
                "specific_performer_work_family",
                [
                    {"role": "performer", "name": "Arthur Rubinstein"},
                    {"role": "composer", "name": "Frederic Chopin"},
                    {"role": "work", "name": "Nocturnes"},
                ],
                ["Arthur Rubinstein Chopin Nocturnes", "Rubinstein Chopin Nocturne op 9"],
                duration=3,
            ),
            "霍洛维茨的拉赫玛尼诺夫": self._decision(
                "artist_work_direction",
                [
                    {"role": "performer", "name": "Vladimir Horowitz"},
                    {"role": "composer", "name": "Sergei Rachmaninoff"},
                ],
                ["Horowitz Rachmaninoff Piano Concerto", "Horowitz Rachmaninoff Prelude"],
                duration=3,
            ),
            "海菲兹的柴可夫斯基小协": self._decision(
                "specific_performer_work_family",
                [
                    {"role": "performer", "name": "Jascha Heifetz"},
                    {"role": "composer", "name": "Pyotr Ilyich Tchaikovsky"},
                    {"role": "work", "name": "Violin Concerto"},
                ],
                ["Heifetz Tchaikovsky Violin Concerto", "Jascha Heifetz Tchaikovsky"],
                duration=3,
            ),
            "Bill Evans 的爵士": self._decision(
                "artist_direction",
                [{"role": "artist", "name": "Bill Evans"}],
                ["Bill Evans Waltz for Debby", "Bill Evans Peace Piece"],
                duration=5,
            ),
            "下午想听点rnb": self._decision(
                "scene_genre_direction",
                [
                    {"role": "genre", "name": "R&B"},
                    {"role": "scene", "name": "afternoon"},
                ],
                ["SZA Good Days", "Daniel Caesar Best Part", "H.E.R. Focus"],
                duration=6,
            ),
            "脑子有点糊，来点半梦半醒的trip hop": self._decision(
                "scene_genre_direction",
                [
                    {"role": "genre", "name": "trip hop"},
                    {"role": "mood", "name": "dreamy low-focus"},
                ],
                ["Massive Attack Teardrop", "Portishead Roads", "Morcheeba The Sea"],
                duration=6,
            ),
            "Coldplay 但别太体育场": self._decision(
                "artist_direction",
                [
                    {"role": "artist", "name": "Coldplay"},
                    {"role": "constraint", "name": "less arena rock"},
                ],
                ["Coldplay Sparks", "Coldplay Trouble", "Coldplay O"],
                duration=4,
            ),
        }
        agent = DJRequestAgent(MappingLLM(mapping))

        for raw in mapping:
            with self.subTest(raw=raw):
                decision = await agent.decide(raw, context_pack={"session_working_memory": {}})
                expected = mapping[raw]

                self.assertEqual(decision.action, expected["action"])
                self.assertEqual(decision.music_task["type"], expected["music_task"]["type"])
                self.assertEqual(decision.music_task["primary_entities"], expected["music_task"]["primary_entities"])
                self.assertEqual(decision.music_task["search_goals"], expected["music_task"]["search_goals"])
                self.assert_raw_request_not_embedded(raw, decision.music_task["search_goals"])
                self.assertTrue(decision.music_task["must_not_search_literal_user_sentence"])
                self.assertGreaterEqual(decision.queue_policy["duration_tracks"], 3)
                self.assertTrue(decision.queue_policy["continue_direction"])

        for call in agent.llm.calls:
            self.assertIn("Infer fuzzy artist", call["prompt"])
            self.assertIn("Do not search the literal user sentence", call["prompt"])
            self.assertIn("Return only JSON", call["prompt"])

    async def test_correction_and_continuation_keep_direction_without_literal_search(self):
        mapping = {
            "接着刚才那个方向，但别这么吵": self._decision(
                "continuation",
                [
                    {"role": "genre", "name": "active session direction"},
                    {"role": "constraint", "name": "quieter"},
                ],
                ["quieter adjacent tracks from current direction", "lower intensity continuation"],
                action="revise_mode_and_play",
                duration=4,
            ),
            "不是这个版本，换个钢琴更轻一点的": self._decision(
                "negative_feedback",
                [
                    {"role": "work", "name": "current work"},
                    {"role": "constraint", "name": "lighter piano performance"},
                ],
                ["same work lighter piano performance", "alternate softer piano version"],
                action="revise_mode_and_play",
                duration=3,
            ),
        }
        agent = DJRequestAgent(MappingLLM(mapping))

        for raw in mapping:
            with self.subTest(raw=raw):
                decision = await agent.decide(
                    raw,
                    context_pack={
                        "session_working_memory": {
                            "active_mode": {"label": "Chopin piano direction", "expires_after_tracks": 3}
                        },
                        "playback_context": {
                            "current_track": {"name": "Nocturne", "artist": "Arthur Rubinstein"}
                        },
                    },
                )
                expected = mapping[raw]

                self.assertEqual(decision.action, "revise_mode_and_play")
                self.assertEqual(decision.music_task["type"], expected["music_task"]["type"])
                self.assertEqual(decision.music_task["primary_entities"], expected["music_task"]["primary_entities"])
                self.assertEqual(decision.music_task["search_goals"], expected["music_task"]["search_goals"])
                self.assert_raw_request_not_embedded(raw, decision.music_task["search_goals"])
                self.assertTrue(decision.music_task["must_not_search_literal_user_sentence"])
                self.assertTrue(decision.queue_policy["continue_direction"])

    def assert_raw_request_not_embedded(self, raw, search_goals):
        for goal in search_goals:
            self.assertNotIn(raw, goal)

    def _decision(self, task_type, entities, search_goals, action="set_direction_and_play", duration=3):
        return {
            "action": action,
            "understood_intent": " / ".join(entity["name"] for entity in entities),
            "music_task": {
                "type": task_type,
                "primary_entities": entities,
                "search_goals": search_goals,
                "must_not_search_literal_user_sentence": True,
            },
            "queue_policy": {
                "duration_tracks": duration,
                "continue_direction": action != "play_now",
                "avoid_repetition": True,
            },
            "uncertainty": {"level": "low", "should_ask_user": False},
            "dj_response": {"speak_now": "懂了，我按这个方向接上。", "tone": "warm_confident"},
            "memory_update": {
                "session_preference": [entity["name"] for entity in entities],
                "possible_long_term_preference": [],
                "negative_constraints": [],
            },
        }
