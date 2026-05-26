import unittest

from backend.engines.search_verify_agent import SearchVerifyAgent


class FakeLLM:
    def __init__(self, responses):
        self.responses = list(responses)
        self.calls = []

    async def chat(self, prompt, max_tokens=300, system=None):
        self.calls.append({"prompt": prompt, "max_tokens": max_tokens, "system": system})
        return self.responses.pop(0)


class FakeNetease:
    def __init__(self):
        self.search_calls = []
        self.results_by_query = {}

    async def search(self, keywords, limit=8):
        self.search_calls.append({"keywords": keywords, "limit": limit})
        return list(self.results_by_query.get(keywords, []))


class FakeResolver:
    async def resolve_with_candidates(self, song, uid=None):
        return type("Result", (), {
            "ok": song.get("id") == "rubinstein",
            "song_id": song.get("id"),
            "proxy_url": f"/api/radio/audio/{song.get('id')}" if song.get("id") == "rubinstein" else "",
        })()


class AlwaysPlayableResolver:
    async def resolve_with_candidates(self, song, uid=None):
        return type("Result", (), {
            "ok": True,
            "song_id": song.get("id"),
            "proxy_url": f"/api/radio/audio/{song.get('id')}",
        })()


class ExplodingResolver:
    async def resolve_with_candidates(self, song, uid=None):
        raise RuntimeError("resolver unavailable")


class SearchVerifyAgentTests(unittest.IsolatedAsyncioTestCase):
    async def test_verifies_performer_work_without_raw_sentence_search(self):
        netease = FakeNetease()
        netease.results_by_query["Arthur Rubinstein Chopin Nocturne"] = [
            {"id": "playlist", "name": "Chopin sleep playlist", "ar": [{"name": "Study Piano"}]},
            {"id": "rubinstein", "name": "Nocturne No.2 in E-flat Major", "ar": [{"name": "Arthur Rubinstein"}], "al": {"name": "Chopin: Nocturnes"}},
        ]
        llm = FakeLLM([
            '{"search_queries":["Arthur Rubinstein Chopin Nocturne"]}',
            '{"chosen_id":"rubinstein","confidence":0.91,"matched_entities":["Arthur Rubinstein","Chopin","Nocturne"],"version_note":"Matches performer and work family.","risk":""}',
        ])
        agent = SearchVerifyAgent(llm, netease, FakeResolver())

        result = await agent.verify(
            {
                "type": "specific_performer_work_family",
                "primary_entities": [
                    {"role": "performer", "name": "Arthur Rubinstein"},
                    {"role": "composer", "name": "Frederic Chopin"},
                ],
                "work_hint": "Nocturnes",
                "search_goals": ["Arthur Rubinstein Chopin Nocturne"],
                "must_not_search_literal_user_sentence": True,
            },
            uid="42",
            raw_user_text="想听鲁宾斯坦弹的肖邦夜曲",
        )

        self.assertEqual(result.status, "verified")
        self.assertEqual(result.selected_song["id"], "rubinstein")
        self.assertEqual(result.url, "/api/radio/audio/rubinstein")
        self.assertEqual([call["keywords"] for call in netease.search_calls], ["Arthur Rubinstein Chopin Nocturne"])
        self.assertNotIn("想听鲁宾斯坦弹的肖邦夜曲", [call["keywords"] for call in netease.search_calls])

    async def test_returns_recovery_options_when_no_playable_candidate(self):
        netease = FakeNetease()
        llm = FakeLLM([
            '{"search_queries":["Krystian Zimerman Chopin"]}',
            '{"chosen_id":"","confidence":0.0,"recovery_options":[{"type":"adjacent_version","task":"Zimerman classical piano","reason":"keep performer"}]}',
        ])
        agent = SearchVerifyAgent(llm, netease, FakeResolver())

        result = await agent.verify({"search_goals": ["Krystian Zimerman Chopin"]}, uid="42")

        self.assertEqual(result.status, "not_found")
        self.assertEqual(result.recovery_options[0]["task"], "Zimerman classical piano")

    async def test_raw_user_sentence_from_llm_query_output_is_not_searched(self):
        netease = FakeNetease()
        netease.results_by_query["Arthur Rubinstein Chopin Nocturne"] = [
            {"id": "rubinstein", "name": "Nocturne No.2 in E-flat Major", "ar": [{"name": "Arthur Rubinstein"}]},
        ]
        llm = FakeLLM([
            '{"search_queries":["想听鲁宾斯坦弹的肖邦夜曲","Arthur Rubinstein Chopin Nocturne"]}',
            '{"chosen_id":"rubinstein","confidence":0.9}',
        ])
        agent = SearchVerifyAgent(llm, netease, FakeResolver())

        result = await agent.verify(
            {"search_goals": ["Arthur Rubinstein Chopin Nocturne"]},
            raw_user_text="想听鲁宾斯坦弹的肖邦夜曲",
        )

        self.assertEqual(result.status, "verified")
        searched = [call["keywords"] for call in netease.search_calls]
        self.assertEqual(searched, ["Arthur Rubinstein Chopin Nocturne"])
        self.assertNotIn("想听鲁宾斯坦弹的肖邦夜曲", llm.calls[0]["prompt"])
        for call in llm.calls:
            self.assertNotIn("想听鲁宾斯坦弹的肖邦夜曲", call["prompt"])

    async def test_valid_chinese_structured_goal_is_searched_and_verified(self):
        netease = FakeNetease()
        netease.results_by_query["鲁宾斯坦 肖邦 夜曲"] = [
            {"id": "rubinstein", "name": "肖邦 夜曲", "ar": [{"name": "鲁宾斯坦"}]},
        ]
        llm = FakeLLM([
            '{"search_queries":["鲁宾斯坦 肖邦 夜曲"]}',
            '{"chosen_id":"rubinstein","confidence":0.9}',
        ])
        agent = SearchVerifyAgent(llm, netease, FakeResolver())

        result = await agent.verify({"search_goals": ["鲁宾斯坦 肖邦 夜曲"]})

        self.assertEqual(result.status, "verified")
        self.assertEqual([call["keywords"] for call in netease.search_calls], ["鲁宾斯坦 肖邦 夜曲"])

    async def test_mojibake_chinese_structured_goal_is_repaired_and_searched(self):
        netease = FakeNetease()
        netease.results_by_query["放点 播放"] = [
            {"id": "rubinstein", "name": "肖邦 夜曲", "ar": [{"name": "鲁宾斯坦"}]},
        ]
        llm = FakeLLM([
            '{"search_queries":[]}',
            '{"chosen_id":"rubinstein","confidence":0.9}',
        ])
        agent = SearchVerifyAgent(llm, netease, FakeResolver())

        result = await agent.verify({"search_goals": ["鎯冲惉 鏀剧偣 鎾斁"]})

        self.assertEqual(result.status, "verified")
        self.assertEqual([call["keywords"] for call in netease.search_calls], ["放点 播放"])

    async def test_dirty_search_goals_are_cleaned_or_rejected_before_search(self):
        netease = FakeNetease()
        netease.results_by_query["Radiohead Creep"] = [
            {"id": "creep", "name": "Creep", "ar": [{"name": "Radiohead"}]},
        ]
        llm = FakeLLM([
            '{"search_queries":["播放 Radiohead Creep","Radiohead Creep","不能放点 radiohead 吗","我想听鲁宾斯坦肖邦夜曲"]}',
            '{"chosen_id":"creep","confidence":0.9}',
        ])
        agent = SearchVerifyAgent(llm, netease, AlwaysPlayableResolver())

        await agent.verify(
            {
                "search_goals": [
                    "播放 Radiohead Creep",
                    "不能放点 radiohead 吗",
                    "想听 Arthur Rubinstein Chopin",
                    "鎯冲惉 Arthur Rubinstein Chopin",
                    "Radiohead Creep",
                ]
            },
            raw_user_text="不能放点 radiohead 吗",
        )

        searched = [call["keywords"] for call in netease.search_calls]
        self.assertEqual(searched, ["Radiohead Creep", "Arthur Rubinstein Chopin"])
        self.assertNotIn("播放 Radiohead Creep", searched)
        self.assertNotIn("不能放点 radiohead 吗", searched)
        self.assertNotIn("想听 Arthur Rubinstein Chopin", searched)
        self.assertNotIn("鎯冲惉 Arthur Rubinstein Chopin", searched)

    async def test_invalid_chosen_id_and_bad_confidence_does_not_queue_first_candidate(self):
        netease = FakeNetease()
        netease.results_by_query["Radiohead Creep"] = [
            {"id": "creep", "name": "Creep", "ar": [{"name": "Radiohead"}]},
        ]
        llm = FakeLLM([
            '{"search_queries":["Radiohead Creep"]}',
            '{"chosen_id":"missing","confidence":"low","recovery_options":[{"type":"adjacent_version","task":"Radiohead","reason":"try artist"}]}',
        ])
        agent = SearchVerifyAgent(llm, netease, AlwaysPlayableResolver())

        result = await agent.verify({"search_goals": ["Radiohead Creep"]})

        self.assertEqual(result.status, "not_found")
        self.assertIsNone(result.selected_song)
        self.assertEqual(result.recovery_options[0]["task"], "Radiohead")

    async def test_resolver_exception_returns_not_found_with_recovery_options(self):
        netease = FakeNetease()
        netease.results_by_query["Radiohead Creep"] = [
            {"id": "creep", "name": "Creep", "ar": [{"name": "Radiohead"}]},
        ]
        llm = FakeLLM([
            '{"search_queries":["Radiohead Creep"]}',
            '{"chosen_id":"creep","confidence":0.9,"recovery_options":[{"type":"adjacent_version","task":"Radiohead acoustic","reason":"resolver failed"}]}',
        ])
        agent = SearchVerifyAgent(llm, netease, ExplodingResolver())

        result = await agent.verify({"search_goals": ["Radiohead Creep"]})

        self.assertEqual(result.status, "not_found")
        self.assertEqual(result.recovery_options[0]["task"], "Radiohead acoustic")

    async def test_bad_candidates_are_filtered_before_judgement(self):
        netease = FakeNetease()
        netease.results_by_query["Radiohead Creep"] = [
            {"id": "ktv", "name": "Creep KTV伴奏", "ar": [{"name": "Radiohead"}]},
            {"id": "noise", "name": "白噪音 睡眠", "ar": [{"name": "Utility Audio"}]},
            {"id": "cover", "name": "Creep cover", "ar": [{"name": "Bedroom Singer"}], "alia": ["翻唱"]},
            {"id": "study-bg", "name": "学习用背景音乐", "ar": [{"name": "Focus Audio"}]},
            {"id": "study-piano", "name": "自习钢琴曲", "ar": [{"name": "Study Piano"}]},
            {"id": "white-before-bed", "name": "白噪声 睡前", "ar": [{"name": "Sleep Utility"}]},
            {"id": "karaoke-cn", "name": "Creep 卡拉OK版", "ar": [{"name": "Radiohead"}]},
            {"id": "creep", "name": "Creep", "ar": [{"name": "Radiohead"}], "al": {"name": "Pablo Honey"}},
        ]
        llm = FakeLLM([
            '{"search_queries":["Radiohead Creep"]}',
            '{"chosen_id":"creep","confidence":0.9}',
        ])
        agent = SearchVerifyAgent(llm, netease, AlwaysPlayableResolver())

        result = await agent.verify({"search_goals": ["Radiohead Creep"]})

        self.assertEqual(result.status, "verified")
        self.assertEqual(result.selected_song["id"], "creep")
        judgement_prompt = llm.calls[1]["prompt"]
        self.assertNotIn('"id": "ktv"', judgement_prompt)
        self.assertNotIn("白噪音", judgement_prompt)
        self.assertNotIn("Bedroom Singer", judgement_prompt)
        self.assertNotIn('"id": "cover"', judgement_prompt)
        self.assertNotIn("学习用背景音乐", judgement_prompt)
        self.assertNotIn("自习钢琴曲", judgement_prompt)
        self.assertNotIn("白噪声", judgement_prompt)
        self.assertNotIn("卡拉OK", judgement_prompt)
        self.assertIn("Pablo Honey", judgement_prompt)

    async def test_utility_candidate_filter_covers_reviewed_variants(self):
        agent = SearchVerifyAgent(FakeLLM([]), FakeNetease(), AlwaysPlayableResolver())

        bad_examples = [
            {"name": "学习用背景音乐"},
            {"name": "自习钢琴曲"},
            {"name": "白噪声 睡前"},
            {"name": "卡拉OK版"},
            {"name": "shared playlist"},
            {"name": "深夜歌单"},
            {"name": "Creep backing track"},
            {"name": "Creep backing"},
            {"name": "Creep accompaniment"},
            {"name": "Creep accompaniment version"},
            {"name": "Creep cover"},
            {"name": "翻唱合集"},
            {"name": "Creep KTV"},
            {"name": "Creep karaoke"},
            {"name": "study piano"},
            {"name": "背景音乐"},
            {"name": "white noise"},
            {"name": "白噪音"},
            {"name": "sleep music"},
            {"name": "睡眠音乐"},
            {"name": "助眠钢琴"},
        ]

        for song in bad_examples:
            with self.subTest(song=song["name"]):
                self.assertTrue(agent._is_bad_candidate(song))

    async def test_requested_version_candidates_are_allowed_for_judgement(self):
        netease = FakeNetease()
        netease.results_by_query["Creep cover"] = [
            {"id": "cover", "name": "Creep cover", "ar": [{"name": "Bedroom Singer"}], "alia": ["翻唱"]},
        ]
        netease.results_by_query["Creep accompaniment"] = [
            {"id": "accompaniment", "name": "Creep accompaniment version", "ar": [{"name": "Session Band"}]},
        ]
        netease.results_by_query["Creep 卡拉OK"] = [
            {"id": "karaoke", "name": "Creep 卡拉OK版", "ar": [{"name": "Radiohead"}]},
        ]
        llm = FakeLLM([
            '{"search_queries":["Creep cover","Creep accompaniment","Creep 卡拉OK"]}',
            '{"chosen_id":"cover","confidence":0.9}',
        ])
        agent = SearchVerifyAgent(llm, netease, AlwaysPlayableResolver())

        result = await agent.verify(
            {
                "type": "cover_request",
                "work_hint": "cover accompaniment",
                "style_hint": "卡拉OK",
                "search_goals": ["Creep cover", "Creep accompaniment", "Creep 卡拉OK"],
            }
        )

        self.assertEqual(result.status, "verified")
        judgement_prompt = llm.calls[1]["prompt"]
        self.assertIn('"id": "cover"', judgement_prompt)
        self.assertIn('"id": "accompaniment"', judgement_prompt)
        self.assertIn('"id": "karaoke"', judgement_prompt)

    async def test_cover_request_allows_cover_but_filters_other_version_pollutants(self):
        netease = FakeNetease()
        netease.results_by_query["Creep cover"] = [
            {"id": "cover", "name": "Creep cover", "ar": [{"name": "Bedroom Singer"}], "alia": ["翻唱"]},
            {"id": "karaoke", "name": "Creep karaoke", "ar": [{"name": "Radiohead"}]},
            {"id": "accompaniment", "name": "Creep accompaniment version", "ar": [{"name": "Session Band"}]},
        ]
        llm = FakeLLM([
            '{"search_queries":["Creep cover"]}',
            '{"chosen_id":"cover","confidence":0.9}',
        ])
        agent = SearchVerifyAgent(llm, netease, AlwaysPlayableResolver())

        result = await agent.verify({"type": "cover_request", "search_goals": ["Creep cover"]})

        self.assertEqual(result.status, "verified")
        judgement_prompt = llm.calls[1]["prompt"]
        self.assertIn('"id": "cover"', judgement_prompt)
        self.assertNotIn('"id": "karaoke"', judgement_prompt)
        self.assertNotIn('"id": "accompaniment"', judgement_prompt)

    async def test_ktv_request_allows_ktv_but_filters_cover_and_accompaniment(self):
        netease = FakeNetease()
        netease.results_by_query["Creep karaoke"] = [
            {"id": "karaoke", "name": "Creep karaoke", "ar": [{"name": "Radiohead"}]},
            {"id": "cover", "name": "Creep cover", "ar": [{"name": "Bedroom Singer"}]},
            {"id": "accompaniment", "name": "Creep backing track", "ar": [{"name": "Session Band"}]},
        ]
        llm = FakeLLM([
            '{"search_queries":["Creep karaoke"]}',
            '{"chosen_id":"karaoke","confidence":0.9}',
        ])
        agent = SearchVerifyAgent(llm, netease, AlwaysPlayableResolver())

        result = await agent.verify({"style_hint": "karaoke", "search_goals": ["Creep karaoke"]})

        self.assertEqual(result.status, "verified")
        judgement_prompt = llm.calls[1]["prompt"]
        self.assertIn('"id": "karaoke"', judgement_prompt)
        self.assertNotIn('"id": "cover"', judgement_prompt)
        self.assertNotIn('"id": "accompaniment"', judgement_prompt)

    async def test_structured_entities_generate_fallback_query_when_llm_query_fails(self):
        netease = FakeNetease()
        netease.results_by_query["Arthur Rubinstein Chopin Nocturnes classical piano"] = [
            {"id": "rubinstein", "name": "Nocturne No.2", "ar": [{"name": "Arthur Rubinstein"}]},
        ]
        llm = FakeLLM([
            'not json',
            '{"chosen_id":"rubinstein","confidence":0.9}',
        ])
        agent = SearchVerifyAgent(llm, netease, FakeResolver())

        result = await agent.verify(
            {
                "primary_entities": [
                    {"role": "performer", "name": "Arthur Rubinstein"},
                    {"role": "composer", "name": "Chopin"},
                ],
                "work_hint": "Nocturnes",
                "style_hint": "classical piano",
            }
        )

        self.assertEqual(result.status, "verified")
        self.assertEqual(
            [call["keywords"] for call in netease.search_calls],
            ["Arthur Rubinstein Chopin Nocturnes classical piano"],
        )

    async def test_structured_fallback_ignores_raw_user_text_equality(self):
        netease = FakeNetease()
        netease.results_by_query["Radiohead Creep"] = [
            {"id": "creep", "name": "Creep", "ar": [{"name": "Radiohead"}]},
        ]
        llm = FakeLLM([
            'not json',
            '{"chosen_id":"creep","confidence":0.9}',
        ])
        agent = SearchVerifyAgent(llm, netease, AlwaysPlayableResolver())

        result = await agent.verify(
            {
                "primary_entities": [
                    {"role": "artist", "name": "Radiohead"},
                ],
                "work_hint": "Creep",
            },
            raw_user_text="Radiohead Creep",
        )

        self.assertEqual(result.status, "verified")
        self.assertEqual([call["keywords"] for call in netease.search_calls], ["Radiohead Creep"])

    async def test_bounds_recovery_and_fallback_candidate_fields(self):
        long_text = "x" * 400
        netease = FakeNetease()
        netease.results_by_query["Radiohead Creep"] = [
            {"id": "creep", "name": "Creep", "ar": [{"name": "Radiohead"}]},
        ]
        llm = FakeLLM([
            '{"search_queries":["Radiohead Creep"]}',
            '{"chosen_id":"creep","confidence":0.9,"fallback_candidates":[{"type":"a","task":"' + long_text + '","reason":"' + long_text + '"},{"type":"b","task":"b","reason":"b"},{"type":"c","task":"c","reason":"c"},{"type":"d","task":"d","reason":"d"}]}',
        ])
        agent = SearchVerifyAgent(llm, netease, AlwaysPlayableResolver())

        result = await agent.verify({"search_goals": ["Radiohead Creep"]})

        self.assertEqual(result.status, "verified")
        self.assertEqual(len(result.fallback_candidates), 3)
        self.assertLessEqual(len(result.fallback_candidates[0]["task"]), 240)
