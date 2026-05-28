import unittest

from backend.engines.search_verify_agent import SearchVerifyAgent


class FakeLLM:
    def __init__(self, responses):
        self.responses = list(responses)
        self.calls = []

    async def chat(self, prompt, max_tokens=300, system=None):
        self.calls.append({"prompt": prompt, "max_tokens": max_tokens, "system": system})
        return self.responses.pop(0)


class JsonModeLLM(FakeLLM):
    async def chat(self, prompt, max_tokens=300, system=None, response_format=None):
        self.calls.append({
            "prompt": prompt,
            "max_tokens": max_tokens,
            "system": system,
            "response_format": response_format,
        })
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


class RecordingResolver:
    def __init__(self, playable_ids):
        self.playable_ids = set(playable_ids)
        self.calls = []

    async def resolve_with_candidates(self, song, uid=None):
        self.calls.append(song)
        ok = song.get("id") in self.playable_ids
        return type("Result", (), {
            "ok": ok,
            "song_id": song.get("id"),
            "proxy_url": f"/api/radio/audio/{song.get('id')}" if ok else "",
        })()


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

    async def test_json_mode_is_requested_for_query_and_judgement(self):
        netease = FakeNetease()
        netease.results_by_query["Radiohead Creep"] = [
            {"id": "creep", "name": "Creep", "ar": [{"name": "Radiohead"}]},
        ]
        llm = JsonModeLLM([
            '{"search_queries":["Radiohead Creep"]}',
            '{"chosen_id":"creep","confidence":0.9}',
        ])
        agent = SearchVerifyAgent(llm, netease, AlwaysPlayableResolver())

        result = await agent.verify({"search_goals": ["Radiohead Creep"]})

        self.assertEqual(result.status, "verified")
        self.assertEqual([call["response_format"] for call in llm.calls], [
            {"type": "json_object"},
            {"type": "json_object"},
        ])

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

    async def test_scene_playlist_like_queries_are_replaced_with_track_queries(self):
        netease = FakeNetease()
        netease.results_by_query["Joji Slow Dancing in the Dark"] = [
            {"id": "joji", "name": "Slow Dancing in the Dark", "ar": [{"name": "Joji"}]},
        ]
        llm = FakeLLM([
            '{"search_queries":["晚上放松舒缓歌曲","安静夜晚歌单","Joji Slow Dancing in the Dark"]}',
            '{"chosen_id":"joji","confidence":0.9}',
        ])
        agent = SearchVerifyAgent(llm, netease, AlwaysPlayableResolver())

        result = await agent.verify(
            {
                "type": "scene_genre_direction",
                "style_hint": "晚上、放松、舒缓、非炸裂",
                "search_goals": ["晚上放松舒缓歌曲", "安静夜晚歌单", "晚上 安静 放松 夜晚 mellow 安静 不炸"],
            }
        )

        self.assertEqual(result.status, "verified")
        searched = [call["keywords"] for call in netease.search_calls]
        self.assertEqual(searched, ["Joji Slow Dancing in the Dark"])
        self.assertNotIn("安静夜晚歌单", searched)
        self.assertNotIn("晚上 安静 放松 夜晚 mellow 安静 不炸", searched)

    async def test_scene_direction_asks_llm_for_concrete_picks_before_searching_style_words(self):
        netease = FakeNetease()
        netease.results_by_query["Phoebe Bridgers Funeral"] = [
            {"id": "funeral", "name": "Funeral", "ar": [{"name": "Phoebe Bridgers"}]},
        ]
        netease.results_by_query["深夜 emotional 不炸"] = [
            {"id": "junk", "name": "深夜伤感歌单", "ar": [{"name": "歌单频道"}]},
        ]
        llm = FakeLLM([
            '{"search_queries":["深夜 emotional 不炸"],"picks":[{"title":"Funeral","artist":"Phoebe Bridgers","query":"Phoebe Bridgers Funeral"}]}',
            '{"chosen_id":"funeral","confidence":0.9}',
        ])
        agent = SearchVerifyAgent(llm, netease, AlwaysPlayableResolver())

        result = await agent.verify(
            {
                "type": "scene_genre_direction",
                "style_hint": "深夜 emotional 安静一点 不炸",
                "search_goals": ["深夜 emotional 不炸"],
                "must_not_search_literal_user_sentence": True,
            },
            raw_user_text="别放炸的，放深夜 emotional 的",
        )

        self.assertEqual(result.status, "verified")
        self.assertEqual(result.selected_song["id"], "funeral")
        searched = [call["keywords"] for call in netease.search_calls]
        self.assertEqual(searched, ["Phoebe Bridgers Funeral"])
        self.assertNotIn("深夜 emotional 不炸", searched)
        self.assertIn("具体歌曲", llm.calls[0]["prompt"])
        self.assertIn("negative_constraints and avoidance words as hard filters", llm.calls[0]["prompt"])
        self.assertIn("late-night emotional", llm.calls[0]["prompt"])

    async def test_artist_direction_asks_llm_for_concrete_picks_before_searching_bare_direction(self):
        netease = FakeNetease()
        netease.results_by_query["Radiohead No Surprises"] = [
            {"id": "no-surprises", "name": "No Surprises", "ar": [{"name": "Radiohead"}]},
        ]
        netease.results_by_query["Radiohead"] = [
            {"id": "lau-17", "name": "17岁", "ar": [{"name": "刘德华"}]},
        ]
        llm = FakeLLM([
            '{"search_queries":["Radiohead"],"picks":[{"title":"No Surprises","artist":"Radiohead","query":"Radiohead No Surprises"}]}',
            '{"chosen_id":"no-surprises","confidence":0.93}',
        ])
        agent = SearchVerifyAgent(llm, netease, AlwaysPlayableResolver())

        result = await agent.verify(
            {
                "type": "artist_direction",
                "primary_entities": [{"role": "artist", "name": "Radiohead"}],
                "style_hint": "Radiohead",
                "search_goals": ["Radiohead"],
                "must_not_search_literal_user_sentence": True,
            },
            raw_user_text="来点radiohead",
        )

        self.assertEqual(result.status, "verified")
        self.assertEqual(result.selected_song["id"], "no-surprises")
        searched = [call["keywords"] for call in netease.search_calls]
        self.assertEqual(searched, ["Radiohead No Surprises"])
        self.assertNotIn("Radiohead", searched[1:])

    async def test_artist_direction_repairs_underplanned_entity_with_llm_not_artist_tool(self):
        netease = FakeNetease()
        netease.results_by_query["X JAPAN Endless Rain"] = [
            {"id": "endless-rain", "name": "Endless Rain", "ar": [{"name": "X JAPAN"}]},
        ]
        llm = FakeLLM([
            '{"search_queries":["xjapan"]}',
            '{"picks":[{"artist":"X JAPAN","title":"Endless Rain","query":"X JAPAN Endless Rain","reason":"代表性抒情摇滚方向"}]}',
            '{"chosen_id":"endless-rain","confidence":0.93}',
        ])
        agent = SearchVerifyAgent(llm, netease, AlwaysPlayableResolver())

        result = await agent.verify(
            {
                "type": "artist_direction",
                "primary_entities": [{"role": "music_entity", "name": "xjapan"}],
                "style_hint": "xjapan",
                "search_goals": ["xjapan"],
                "must_not_search_literal_user_sentence": True,
            },
            raw_user_text="来点xjapan",
        )

        self.assertEqual(result.status, "verified")
        self.assertEqual(result.selected_song["id"], "endless-rain")
        self.assertEqual([call["keywords"] for call in netease.search_calls], ["X JAPAN Endless Rain"])
        self.assertEqual(len(llm.calls), 3)
        self.assertIn("second-pass", llm.calls[1]["prompt"])
        self.assertNotIn("artist_top_song", llm.calls[1]["prompt"])

    async def test_artist_work_direction_repairs_bare_performer_composer_into_specific_work(self):
        netease = FakeNetease()
        netease.results_by_query["Krystian Zimerman Chopin Piano Concerto No. 1"] = [
            {
                "id": "zimerman-concerto",
                "name": "Piano Concerto No. 1 in E Minor, Op. 11",
                "ar": [{"name": "Krystian Zimerman"}],
                "al": {"name": "Chopin: Piano Concertos"},
            },
        ]
        llm = FakeLLM([
            '{"search_queries":["齐默尔曼 肖邦"]}',
            '{"picks":[{"artist":"Krystian Zimerman","title":"Chopin Piano Concerto No. 1","query":"Krystian Zimerman Chopin Piano Concerto No. 1","reason":"把演奏家和作曲家方向落实到可播作品"}]}',
            '{"chosen_id":"zimerman-concerto","confidence":0.91}',
            '{"matches":true,"confidence":0.9,"reason":"齐默尔曼 refers to Krystian Zimerman."}',
        ])
        agent = SearchVerifyAgent(llm, netease, AlwaysPlayableResolver())

        result = await agent.verify(
            {
                "type": "artist_work_direction",
                "primary_entities": [
                    {"role": "performer", "name": "齐默尔曼"},
                    {"role": "work", "name": "肖邦"},
                ],
                "work_hint": "肖邦",
                "style_hint": "齐默尔曼 肖邦",
                "search_goals": ["齐默尔曼 肖邦"],
                "must_not_search_literal_user_sentence": True,
            },
            raw_user_text="我要听齐默尔曼的肖邦",
        )

        self.assertEqual(result.status, "verified")
        self.assertEqual(result.selected_song["id"], "zimerman-concerto")
        self.assertEqual(
            [call["keywords"] for call in netease.search_calls],
            ["Krystian Zimerman Chopin Piano Concerto No. 1"],
        )

    async def test_underplanned_repair_failure_does_not_search_bare_entity(self):
        netease = FakeNetease()
        llm = FakeLLM([
            '{"search_queries":["xjapan"]}',
            '{"search_queries":["xjapan"],"picks":[]}',
            '{"chosen_id":"","confidence":0.0}',
        ])
        agent = SearchVerifyAgent(llm, netease, AlwaysPlayableResolver())

        result = await agent.verify(
            {
                "type": "artist_direction",
                "primary_entities": [{"role": "music_entity", "name": "xjapan"}],
                "style_hint": "xjapan",
                "search_goals": ["xjapan"],
            },
            raw_user_text="来点xjapan",
        )

        self.assertEqual(result.status, "not_found")
        self.assertEqual(netease.search_calls, [])

    async def test_artist_direction_repairs_generic_artist_descriptor_queries(self):
        netease = FakeNetease()
        netease.results_by_query["Linkin Park Leave Out All The Rest"] = [
            {"id": "leave-out", "name": "Leave Out All The Rest", "ar": [{"name": "Linkin Park"}]},
        ]
        llm = FakeLLM([
            '{"search_queries":["Linkin Park 不吵 推荐","Linkin Park softer songs"]}',
            '{"picks":[{"artist":"Linkin Park","title":"Leave Out All The Rest","query":"Linkin Park Leave Out All The Rest","reason":"更柔和的 Linkin Park"}]}',
            '{"chosen_id":"leave-out","confidence":0.91}',
        ])
        agent = SearchVerifyAgent(llm, netease, AlwaysPlayableResolver())

        result = await agent.verify(
            {
                "type": "artist_direction",
                "primary_entities": [{"role": "artist", "name": "Linkin Park"}],
                "work_hint": "calmer, less loud tracks",
                "style_hint": "Linkin Park but not too loud",
                "negative_constraints": ["不要太吵"],
                "search_goals": ["Linkin Park", "Linkin Park 不吵 推荐"],
            },
            raw_user_text="来点林肯公园但别太吵",
        )

        self.assertEqual(result.status, "verified")
        self.assertEqual(result.selected_song["id"], "leave-out")
        self.assertEqual(
            [call["keywords"] for call in netease.search_calls],
            ["Linkin Park Leave Out All The Rest"],
        )

    async def test_concrete_scene_track_can_be_locally_verified_when_judge_is_uncertain(self):
        netease = FakeNetease()
        netease.results_by_query["Joji Slow Dancing in the Dark"] = [
            {"id": "joji", "name": "Slow Dancing in the Dark", "ar": [{"name": "Joji"}]},
        ]
        llm = FakeLLM([
            '{"search_queries":["Joji Slow Dancing in the Dark"]}',
            '{"chosen_id":"","confidence":0.0}',
        ])
        resolver = RecordingResolver({"joji"})
        agent = SearchVerifyAgent(llm, netease, resolver)

        result = await agent.verify(
            {
                "type": "scene_genre_direction",
                "style_hint": "晚上、放松、舒缓、非炸裂",
                "search_goals": ["Joji Slow Dancing in the Dark"],
            }
        )

        self.assertEqual(result.status, "verified")
        self.assertEqual(result.selected_song["id"], "joji")
        self.assertEqual(result.verification["risk"], "local_metadata_match")
        self.assertEqual(result.used_query, "Joji Slow Dancing in the Dark")

    async def test_concrete_query_does_not_locally_verify_unmatched_first_candidate(self):
        netease = FakeNetease()
        netease.results_by_query["Joji Slow Dancing in the Dark"] = [
            {"id": "wrong", "name": "17岁", "ar": [{"name": "刘德华"}]},
        ]
        llm = FakeLLM([
            '{"search_queries":["Joji Slow Dancing in the Dark"]}',
            '{"chosen_id":"","confidence":0.0}',
        ])
        resolver = RecordingResolver({"wrong"})
        agent = SearchVerifyAgent(llm, netease, resolver)

        result = await agent.verify(
            {
                "type": "scene_genre_direction",
                "style_hint": "晚上、放松、舒缓、非炸裂",
                "search_goals": ["Joji Slow Dancing in the Dark"],
            }
        )

        self.assertEqual(result.status, "not_found")
        self.assertIsNone(result.selected_song)
        self.assertEqual(resolver.calls, [])

    async def test_artist_direction_does_not_fallback_to_wrong_artist_when_judge_is_uncertain(self):
        netease = FakeNetease()
        netease.results_by_query["Radiohead"] = [
            {"id": "lau-17", "name": "17岁", "ar": [{"name": "刘德华"}]},
        ]
        llm = FakeLLM([
            '{"search_queries":["Radiohead"]}',
            '{"chosen_id":"","confidence":0.0}',
        ])
        resolver = RecordingResolver({"lau-17"})
        agent = SearchVerifyAgent(llm, netease, resolver)

        result = await agent.verify(
            {
                "type": "artist_direction",
                "primary_entities": [],
                "search_goals": ["Radiohead"],
            },
            raw_user_text="来点radiohead",
        )

        self.assertEqual(result.status, "not_found")
        self.assertIsNone(result.selected_song)
        self.assertEqual(resolver.calls, [])

    async def test_high_confidence_wrong_artist_choice_is_rejected_for_entity_task(self):
        netease = FakeNetease()
        netease.results_by_query["Radiohead"] = [
            {"id": "lau-17", "name": "17岁", "ar": [{"name": "刘德华"}]},
        ]
        llm = FakeLLM([
            '{"search_queries":["Radiohead"]}',
            '{"chosen_id":"lau-17","confidence":0.99}',
        ])
        resolver = RecordingResolver({"lau-17"})
        agent = SearchVerifyAgent(llm, netease, resolver)

        result = await agent.verify(
            {
                "type": "artist_direction",
                "primary_entities": [{"role": "artist", "name": "Radiohead"}],
                "search_goals": ["Radiohead"],
            },
            raw_user_text="来点radiohead",
        )

        self.assertEqual(result.status, "not_found")
        self.assertIsNone(result.selected_song)
        self.assertEqual(resolver.calls, [])

    async def test_entity_consistency_can_accept_llm_verified_translation_without_alias_cache(self):
        netease = FakeNetease()
        netease.results_by_query["Radiohead No Surprises"] = [
            {"id": "no-surprises", "name": "No Surprises", "ar": [{"name": "Radiohead"}]},
        ]
        llm = FakeLLM([
            '{"search_queries":[],"picks":[{"title":"No Surprises","artist":"Radiohead","query":"Radiohead No Surprises"}]}',
            '{"chosen_id":"no-surprises","confidence":0.93,"matched_entities":["收音机头","Radiohead"]}',
            '{"matches":true,"confidence":0.92,"reason":"收音机头 is the Chinese name for Radiohead."}',
        ])
        resolver = RecordingResolver({"no-surprises"})
        agent = SearchVerifyAgent(llm, netease, resolver)

        result = await agent.verify(
            {
                "type": "artist_direction",
                "primary_entities": [{"role": "music_entity", "name": "收音机头"}],
                "style_hint": "收音机头",
                "search_goals": ["收音机头"],
            },
            raw_user_text="能不能放点收音机头的",
        )

        self.assertEqual(result.status, "verified")
        self.assertEqual(result.selected_song["id"], "no-surprises")
        self.assertEqual(len(llm.calls), 3)
        self.assertIn("same intended music entity", llm.calls[2]["prompt"])

    async def test_invalid_chosen_id_and_bad_confidence_does_not_queue_first_candidate(self):
        netease = FakeNetease()
        netease.results_by_query["Radiohead Creep"] = [
            {"id": "wrong", "name": "17岁", "ar": [{"name": "刘德华"}]},
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

    async def test_accompaniment_request_allows_backing_but_filters_cover_and_ktv(self):
        netease = FakeNetease()
        netease.results_by_query["Creep backing track"] = [
            {"id": "backing", "name": "Creep backing track", "ar": [{"name": "Session Band"}]},
            {"id": "cover", "name": "Creep cover", "ar": [{"name": "Bedroom Singer"}]},
            {"id": "karaoke", "name": "Creep karaoke", "ar": [{"name": "Radiohead"}]},
        ]
        llm = FakeLLM([
            '{"search_queries":["Creep backing track"]}',
            '{"chosen_id":"backing","confidence":0.9}',
        ])
        agent = SearchVerifyAgent(llm, netease, AlwaysPlayableResolver())

        result = await agent.verify({"style_hint": "backing track", "search_goals": ["Creep backing track"]})

        self.assertEqual(result.status, "verified")
        judgement_prompt = llm.calls[1]["prompt"]
        self.assertIn('"id": "backing"', judgement_prompt)
        self.assertNotIn('"id": "cover"', judgement_prompt)
        self.assertNotIn('"id": "karaoke"', judgement_prompt)

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

    async def test_default_recovery_option_fields_are_bounded(self):
        long_text = "x" * 400
        netease = FakeNetease()
        llm = FakeLLM([
            '{"search_queries":["No playable version"]}',
            '{"chosen_id":"","confidence":0.0}',
        ])
        agent = SearchVerifyAgent(llm, netease, FakeResolver())

        result = await agent.verify(
            {
                "primary_entities": [
                    {"role": "artist", "name": long_text},
                    {"role": "composer", "name": long_text},
                ],
                "work_hint": long_text,
                "style_hint": long_text,
            }
        )

        self.assertEqual(result.status, "not_found")
        self.assertLessEqual(len(result.recovery_options), 3)
        self.assertLessEqual(len(result.recovery_options[0]["type"]), 240)
        self.assertLessEqual(len(result.recovery_options[0]["task"]), 240)
        self.assertLessEqual(len(result.recovery_options[0]["reason"]), 240)
