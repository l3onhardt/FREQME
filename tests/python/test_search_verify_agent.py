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
