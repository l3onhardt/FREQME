import asyncio
import unittest

from backend.engines.song_request_agent import SongRequestAgent


class FakeLLM:
    def __init__(self, responses):
        self.responses = list(responses)
        self.calls = []

    async def chat(self, prompt, max_tokens=300, system=None):
        self.calls.append({
            "prompt": prompt,
            "max_tokens": max_tokens,
            "system": system,
        })
        return self.responses.pop(0)


class FakeNetease:
    def __init__(self):
        self.search_calls = []
        self.results_by_query = {}

    async def search(self, keywords, limit=5):
        self.search_calls.append({"keywords": keywords, "limit": limit})
        return list(self.results_by_query.get(keywords, []))


class SlowFirstLLM:
    def __init__(self):
        self.calls = []

    async def chat(self, prompt, max_tokens=300, system=None):
        self.calls.append({
            "prompt": prompt,
            "max_tokens": max_tokens,
            "system": system,
        })
        if len(self.calls) == 1:
            await asyncio.sleep(0.2)
            return '{"interpreted_request":"too late","search_queries":["too late"]}'
        if "搜索改写器" in str(system):
            return "Yundi Li Prokofiev Piano Concerto No.2"
        return '{"chosen_index":0,"chosen_id":"116949","dj_intro":"我给你接这个版本。"}'


class SongRequestAgentTests(unittest.IsolatedAsyncioTestCase):
    async def test_short_ambiguous_title_builds_candidate_pool_before_choosing(self):
        netease = FakeNetease()
        netease.results_by_query["夜曲"] = [
            {"id": "wrong-short", "name": "Вечера", "ar": [{"name": "Unknown"}]},
        ]
        netease.results_by_query["周杰伦 夜曲"] = [
            {
                "id": "jay-nocturne",
                "name": "夜曲",
                "ar": [{"name": "周杰伦"}],
                "al": {"name": "十一月的萧邦"},
            }
        ]
        netease.results_by_query["Chopin Nocturne"] = [
            {
                "id": "chopin-nocturne",
                "name": "Nocturne in E-flat major, Op.9 No.2",
                "ar": [{"name": "Arthur Rubinstein"}],
                "al": {"name": "Chopin: Nocturnes"},
            }
        ]
        llm = FakeLLM([
            '{"interpreted_request":"短标题《夜曲》，可能指周杰伦，也可能指肖邦夜曲，需要一起看候选","ambiguous":true,"search_queries":["夜曲","周杰伦 夜曲","Chopin Nocturne"]}',
            '{"chosen_index":1,"chosen_id":"jay-nocturne","interpreted_request":"周杰伦《夜曲》","selection_reason":"用户没有给古典语境，先选华语流行里最常见的《夜曲》。","dj_intro":"我先按周杰伦的《夜曲》给你接这一版。它收在《十一月的萧邦》里，旋律带一点冷光感，很适合把情绪往夜里放。"}',
        ])

        agent = SongRequestAgent(llm, netease)
        result = await agent.resolve("我想听夜曲", profile={}, user_settings={})

        self.assertTrue(result.found)
        self.assertEqual(result.song["id"], "jay-nocturne")
        self.assertEqual(
            [call["keywords"] for call in netease.search_calls],
            ["夜曲", "周杰伦 夜曲", "Chopin Nocturne"],
        )
        choose_prompt = llm.calls[1]["prompt"]
        self.assertIn("Вечера - Unknown", choose_prompt)
        self.assertIn("夜曲 - 周杰伦", choose_prompt)
        self.assertIn("Nocturne in E-flat major, Op.9 No.2 - Arthur Rubinstein", choose_prompt)

    async def test_candidate_pool_interleaves_search_intents_in_choose_prompt(self):
        netease = FakeNetease()
        netease.results_by_query["夜曲"] = [
            {"id": f"literal-{index}", "name": f"夜曲翻奏 {index}", "ar": [{"name": "字面结果"}]}
            for index in range(10)
        ]
        netease.results_by_query["周杰伦 夜曲"] = [
            {
                "id": "jay-nocturne",
                "name": "夜曲",
                "ar": [{"name": "周杰伦"}],
                "al": {"name": "十一月的萧邦"},
            }
        ]
        netease.results_by_query["Chopin Nocturne"] = [
            {
                "id": "chopin-nocturne",
                "name": "Nocturne in E-flat major, Op.9 No.2",
                "ar": [{"name": "Arthur Rubinstein"}],
            }
        ]
        llm = FakeLLM([
            '{"interpreted_request":"短标题《夜曲》需要看多个音乐指向","ambiguous":true,"search_queries":["夜曲","周杰伦 夜曲","Chopin Nocturne"]}',
            '{"chosen_id":"jay-nocturne","dj_intro":"我按周杰伦的《夜曲》来接。"}',
        ])

        agent = SongRequestAgent(llm, netease)
        result = await agent.resolve("我想听夜曲", profile={}, user_settings={})

        self.assertEqual(result.song["id"], "jay-nocturne")
        choose_prompt = llm.calls[1]["prompt"]
        self.assertIn("夜曲 - 周杰伦", choose_prompt)
        self.assertIn("Nocturne in E-flat major, Op.9 No.2 - Arthur Rubinstein", choose_prompt)

    async def test_beethoven_moonlight_request_expands_aliases_before_choosing(self):
        netease = FakeNetease()
        netease.results_by_query["月光奏鸣曲 贝多芬"] = [
            {"id": "thin-hit", "name": "月光", "ar": [{"name": "Loose Piano"}]},
        ]
        netease.results_by_query["Beethoven Moonlight Sonata"] = [
            {
                "id": "moonlight",
                "name": "Piano Sonata No.14 in C-sharp minor, Op.27 No.2: I. Adagio sostenuto",
                "ar": [{"name": "Ludwig van Beethoven"}, {"name": "Daniel Barenboim"}],
                "al": {"name": "Beethoven: Piano Sonatas"},
            }
        ]
        netease.results_by_query["Beethoven Piano Sonata No.14 Op.27 No.2"] = [
            {
                "id": "moonlight-alt",
                "name": "Piano Sonata No. 14, Op. 27 No. 2 'Moonlight'",
                "ar": [{"name": "Ludwig van Beethoven"}, {"name": "Wilhelm Kempff"}],
                "al": {"name": "Beethoven: Complete Piano Sonatas"},
            }
        ]
        llm = FakeLLM([
            '{"interpreted_request":"贝多芬《月光奏鸣曲》，即 Piano Sonata No.14 in C-sharp minor, Op.27 No.2","ambiguous":false,"search_queries":["月光奏鸣曲 贝多芬","Beethoven Moonlight Sonata","Beethoven Piano Sonata No.14 Op.27 No.2"]}',
            '{"chosen_index":1,"chosen_id":"moonlight","interpreted_request":"贝多芬《月光奏鸣曲》第一乐章","selection_reason":"英文作品名候选信息更完整，指向贝多芬第十四钢琴奏鸣曲。","dj_intro":"我按贝多芬《月光奏鸣曲》给你接第一乐章。它正式是第十四钢琴奏鸣曲，Op.27 No.2，这版先从 Adagio sostenuto 的低声部慢慢铺开。"}',
        ])

        agent = SongRequestAgent(llm, netease)
        result = await agent.resolve("我想听月光奏鸣曲，贝多芬的", profile={}, user_settings={})

        self.assertTrue(result.found)
        self.assertEqual(result.song["id"], "moonlight")
        self.assertEqual(
            [call["keywords"] for call in netease.search_calls],
            [
                "月光奏鸣曲 贝多芬",
                "Beethoven Moonlight Sonata",
                "Beethoven Piano Sonata No.14 Op.27 No.2",
            ],
        )
        choose_prompt = llm.calls[1]["prompt"]
        self.assertIn("Piano Sonata No.14 in C-sharp minor", choose_prompt)
        self.assertIn("来自搜索=Beethoven Moonlight Sonata", choose_prompt)

    async def test_interprets_imprecise_classical_request_before_search(self):
        netease = FakeNetease()
        netease.results_by_query["普罗科菲耶夫 第二钢琴协奏曲 李云迪"] = [
            {
                "id": "p2-yundi",
                "name": "Piano Concerto No. 2 in G minor",
                "ar": [{"name": "李云迪"}],
                "al": {"name": "Prokofiev Piano Concerto No. 2"},
            }
        ]
        llm = FakeLLM([
            '{"interpreted_request":"普罗科菲耶夫第二钢琴协奏曲，偏李云迪版本","search_queries":["普罗科菲耶夫 第二钢琴协奏曲 李云迪"]}',
            '{"chosen_index":0,"dj_intro":"我给你选李云迪这个版本的普罗科菲耶夫第二钢琴协奏曲。这个录音的钢琴颗粒很硬，适合现在这种想往古典里沉一下的时刻。"}',
        ])

        agent = SongRequestAgent(llm, netease)
        result = await agent.resolve(
            "放点古典，我想听李云迪的普2",
            profile={"radio_insights": {"taste_summary": "夜里会被紧一点的钢琴线条吸引。"}},
            user_settings={"region_hint": "上海", "timezone_name": "Asia/Shanghai"},
        )

        self.assertTrue(result.found)
        self.assertEqual(result.song["id"], "p2-yundi")
        self.assertEqual(
            netease.search_calls[0]["keywords"],
            "普罗科菲耶夫 第二钢琴协奏曲 李云迪",
        )
        self.assertIn("普罗科菲耶夫第二钢琴协奏曲", result.interpreted_request)
        self.assertIn("李云迪", result.dj_intro)
        self.assertIn("chosen_index", llm.calls[1]["prompt"])
        self.assertIn("Piano Concerto No. 2 in G minor - 李云迪", llm.calls[1]["prompt"])

    async def test_retries_agent_queries_until_candidates_exist(self):
        netease = FakeNetease()
        netease.results_by_query["普罗科菲耶夫 第二钢琴交响曲"] = []
        netease.results_by_query["普罗科菲耶夫 第二钢琴协奏曲"] = [
            {"id": "p2", "name": "Prokofiev: Piano Concerto No. 2", "ar": [{"name": "Vladimir Ashkenazy"}]},
        ]
        llm = FakeLLM([
            '{"interpreted_request":"用户大概率想听普罗科菲耶夫第二钢琴协奏曲","search_queries":["普罗科菲耶夫 第二钢琴交响曲","普罗科菲耶夫 第二钢琴协奏曲"]}',
            '{"chosen_index":0,"dj_intro":"你说的第二钢琴交响曲，我按更常见的普罗科菲耶夫第二钢琴协奏曲来接。这个版本线条很紧，情绪不是铺开，是往里压。"}',
        ])

        agent = SongRequestAgent(llm, netease)
        result = await agent.resolve("普罗科菲耶夫第二钢琴交响曲", profile={}, user_settings={})

        self.assertTrue(result.found)
        self.assertEqual(result.song["id"], "p2")
        self.assertEqual(
            [call["keywords"] for call in netease.search_calls],
            ["普罗科菲耶夫 第二钢琴交响曲", "普罗科菲耶夫 第二钢琴协奏曲"],
        )
        self.assertIn("第二钢琴协奏曲", result.dj_intro)

    async def test_prokofiev_yundi_request_does_not_fall_back_to_raw_i_want_search(self):
        netease = FakeNetease()
        netease.results_by_query["普罗科菲耶夫 第二钢琴协奏曲 李云迪"] = []
        netease.results_by_query["Yundi Li Prokofiev Piano Concerto No.2"] = [
            {
                "id": "116949",
                "name": "Piano Concerto No.2 in G minor, Op.16:1. Andantino",
                "ar": [
                    {"name": "李云迪"},
                    {"name": "Seiji Ozawa"},
                    {"name": "Berliner Philharmoniker"},
                ],
                "al": {"name": "Prokofiev: Piano Concerto No 2; Ravel: Piano Concerto in G Major"},
            }
        ]
        netease.results_by_query["我想听李云迪的普2"] = [
            {"id": "wrong", "name": "我想（Cover 余佳运）", "ar": [{"name": "桃德李Todd Li"}]},
        ]
        llm = FakeLLM([
            '{"interpreted_request":"李云迪演奏的普罗科菲耶夫第二钢琴协奏曲","search_queries":["普罗科菲耶夫 第二钢琴协奏曲 李云迪"]}',
            '{"interpreted_request":"李云迪、小泽征尔与柏林爱乐合作的 Prokofiev Piano Concerto No.2","search_queries":["Yundi Li Prokofiev Piano Concerto No.2"]}',
            '{"chosen_index":0,"chosen_id":"116949","dj_intro":"我给你接李云迪和小泽征尔、柏林爱乐合作的普罗科菲耶夫第二钢琴协奏曲。先从第一乐章进去，那种绷紧的钢琴线条会比一句安慰更准确。"}',
        ])

        agent = SongRequestAgent(llm, netease)
        result = await agent.resolve("我想听李云迪的普2", profile={}, user_settings={})

        self.assertTrue(result.found)
        self.assertEqual(result.song["id"], "116949")
        self.assertNotIn(
            "我想听李云迪的普2",
            [call["keywords"] for call in netease.search_calls],
        )
        self.assertIn(
            "Yundi Li Prokofiev Piano Concerto No.2",
            [call["keywords"] for call in netease.search_calls],
        )

    async def test_ignores_command_fragment_queries_from_llm(self):
        netease = FakeNetease()
        netease.results_by_query["想听"] = [
            {"id": "wrong-fragment", "name": "想听", "ar": [{"name": "Wrong Artist"}]},
        ]
        netease.results_by_query["我想听李云迪的普2"] = [
            {"id": "wrong-raw", "name": "我想", "ar": [{"name": "Wrong Artist"}]},
        ]
        netease.results_by_query["Yundi Li Prokofiev Piano Concerto No.2"] = [
            {
                "id": "116949",
                "name": "Piano Concerto No.2 in G minor, Op.16:1. Andantino",
                "ar": [{"name": "李云迪"}],
            }
        ]
        llm = FakeLLM([
            '{"interpreted_request":"李云迪演奏的普罗科菲耶夫第二钢琴协奏曲","search_queries":["想听","我想听李云迪的普2","Yundi Li Prokofiev Piano Concerto No.2"]}',
            '{"chosen_index":0,"chosen_id":"116949","dj_intro":"我给你接李云迪的普罗科菲耶夫第二钢琴协奏曲第二号。"}',
        ])

        agent = SongRequestAgent(llm, netease)
        result = await agent.resolve("我想听李云迪的普2", profile={}, user_settings={})

        searched = [call["keywords"] for call in netease.search_calls]
        self.assertEqual(result.song["id"], "116949")
        self.assertEqual(searched, ["Yundi Li Prokofiev Piano Concerto No.2"])
        self.assertNotIn("想听", searched)
        self.assertNotIn("我想听李云迪的普2", searched)

    async def test_rewrites_search_terms_when_llm_does_not_return_search_plan(self):
        netease = FakeNetease()
        netease.results_by_query["Yundi Li Prokofiev Piano Concerto No.2"] = [
            {
                "id": "116949",
                "name": "Piano Concerto No.2 in G minor, Op.16:1. Andantino",
                "ar": [
                    {"name": "李云迪"},
                    {"name": "Seiji Ozawa"},
                    {"name": "Berliner Philharmoniker"},
                ],
                "al": {"name": "Prokofiev: Piano Concerto No 2; Ravel: Piano Concerto in G Major"},
            }
        ]
        llm = FakeLLM([
            "not json",
            "Yundi Li Prokofiev Piano Concerto No.2",
            '{"chosen_index":0,"chosen_id":"116949","dj_intro":"我给你接李云迪和小泽征尔、柏林爱乐合作的 Prokofiev Piano Concerto No.2。"}',
        ])

        agent = SongRequestAgent(llm, netease)
        result = await agent.resolve("我想听李云迪的普2", profile={}, user_settings={})

        self.assertTrue(result.found)
        self.assertEqual(result.song["id"], "116949")
        self.assertEqual(
            [call["keywords"] for call in netease.search_calls],
            ["Yundi Li Prokofiev Piano Concerto No.2"],
        )
        self.assertIn("Prokofiev", result.dj_intro)

    async def test_rewrites_too_literal_user_phrase_before_searching(self):
        netease = FakeNetease()
        netease.results_by_query["李云迪 普2"] = [
            {"id": "wrong", "name": "Nocturne,Op.9,No.2", "ar": [{"name": "李云迪"}]},
        ]
        netease.results_by_query["Yundi Li Prokofiev Piano Concerto No.2"] = [
            {
                "id": "116949",
                "name": "Piano Concerto No.2 in G minor, Op.16:1. Andantino",
                "ar": [{"name": "李云迪"}],
            }
        ]
        llm = FakeLLM([
            '{"interpreted_request":"李云迪的普2","search_queries":["李云迪 普2"]}',
            "Yundi Li Prokofiev Piano Concerto No.2",
            '{"chosen_index":0,"chosen_id":"116949","dj_intro":"我给你接李云迪的普罗科菲耶夫第二钢琴协奏曲。"}',
        ])

        agent = SongRequestAgent(llm, netease)
        result = await agent.resolve("我想听李云迪的普2", profile={}, user_settings={})

        searched = [call["keywords"] for call in netease.search_calls]
        self.assertEqual(result.song["id"], "116949")
        self.assertEqual(searched, ["Yundi Li Prokofiev Piano Concerto No.2"])
        self.assertNotIn("李云迪 普2", searched)

    async def test_uses_search_rewrite_when_initial_planning_model_stalls(self):
        netease = FakeNetease()
        netease.results_by_query["Yundi Li Prokofiev Piano Concerto No.2"] = [
            {
                "id": "116949",
                "name": "Piano Concerto No.2 in G minor, Op.16:1. Andantino",
                "ar": [{"name": "李云迪"}],
            }
        ]

        agent = SongRequestAgent(SlowFirstLLM(), netease, llm_timeout_s=0.01)
        result = await asyncio.wait_for(
            agent.resolve("我想听李云迪的普2", profile={}, user_settings={}),
            timeout=0.5,
        )

        self.assertTrue(result.found)
        self.assertEqual(result.song["id"], "116949")
        self.assertEqual(
            [call["keywords"] for call in netease.search_calls],
            ["Yundi Li Prokofiev Piano Concerto No.2"],
        )

    async def test_understands_album_alias_before_searching_raw_words(self):
        netease = FakeNetease()
        netease.results_by_query["Pink Floyd The Dark Side of the Moon"] = [
            {
                "id": "dark-side",
                "name": "Speak to Me",
                "ar": [{"name": "Pink Floyd"}],
                "al": {"name": "The Dark Side of the Moon"},
            }
        ]
        netease.results_by_query["月之暗面"] = [
            {"id": "wrong", "name": "月之暗面", "ar": [{"name": "陌生艺人"}]},
        ]
        llm = FakeLLM([
            '{"interpreted_request":"Pink Floyd 的专辑 The Dark Side of the Moon","search_queries":["Pink Floyd The Dark Side of the Moon"]}',
            '{"chosen_index":0,"chosen_id":"dark-side","dj_intro":"我按 Pink Floyd 的《The Dark Side of the Moon》来接。先从 Speak to Me 进去，它不是单曲式的开场，更像整张唱片慢慢打开门。"}',
        ])

        agent = SongRequestAgent(llm, netease)
        result = await agent.resolve("我想听月之暗面", profile={}, user_settings={})

        self.assertTrue(result.found)
        self.assertEqual(result.song["id"], "dark-side")
        self.assertEqual(
            netease.search_calls[0]["keywords"],
            "Pink Floyd The Dark Side of the Moon",
        )
        self.assertNotIn("月之暗面", [call["keywords"] for call in netease.search_calls])

    async def test_rewrites_literal_alias_by_asking_llm_for_search_terms(self):
        netease = FakeNetease()
        netease.results_by_query["月之暗面"] = [
            {"id": "wrong", "name": "月之暗面", "ar": [{"name": "陌生艺人"}]},
        ]
        netease.results_by_query["Pink Floyd The Dark Side of the Moon"] = [
            {
                "id": "dark-side",
                "name": "Speak to Me",
                "ar": [{"name": "Pink Floyd"}],
                "al": {"name": "The Dark Side of the Moon"},
            }
        ]
        llm = FakeLLM([
            "Pink Floyd The Dark Side of the Moon",
            '{"chosen_index":0,"chosen_id":"dark-side","dj_intro":"我按 Pink Floyd 的 The Dark Side of the Moon 来接。"}',
        ])

        class LiteralAliasAgent(SongRequestAgent):
            async def _plan(self, request_text, profile, user_settings):
                return {
                    "interpreted_request": "月之暗面",
                    "search_queries": ["月之暗面"],
                }

        agent = LiteralAliasAgent(llm, netease)
        result = await agent.resolve("我想听月之暗面", profile={}, user_settings={})

        searched = [call["keywords"] for call in netease.search_calls]
        self.assertEqual(result.song["id"], "dark-side")
        self.assertEqual(searched[0], "Pink Floyd The Dark Side of the Moon")
        self.assertNotIn("月之暗面", searched)


if __name__ == "__main__":
    unittest.main()
