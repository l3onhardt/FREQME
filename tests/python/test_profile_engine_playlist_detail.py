import json
import unittest

from backend.engines.profile import ProfileEngine


class FakeNetease:
    def __init__(self):
        self.detail_calls = []

    async def user_playlist(self, uid):
        return [
            {"id": 101, "name": "我的年度循环"},
            {"id": 202, "name": "夜晚歌单"},
        ]

    async def playlist_detail(self, playlist_id):
        self.detail_calls.append(playlist_id)
        details = {
            101: {
                "playlist": {
                    "tracks": [
                        {
                            "id": 3001,
                            "name": "晴天",
                            "ar": [{"name": "周杰伦"}],
                        },
                        {
                            "id": "3002",
                            "name": "The Scientist",
                            "artists": [{"name": "Coldplay"}],
                        },
                        {
                            "name": "Missing Playlist Id",
                            "artists": [{"name": "Invalid Artist"}],
                        },
                    ]
                }
            },
            202: {
                "playlist": {
                    "tracks": [
                        {
                            "id": 3003,
                            "name": "匿名的好友",
                            "ar": [],
                        }
                    ]
                }
            },
        }
        return details[playlist_id]

    async def user_record(self, uid):
        return {
            "weekData": [
                {
                    "song": {
                        "id": 4001,
                        "name": "晚安",
                        "ar": [{"name": "颜人中"}],
                    }
                },
                {
                    "song": {
                        "id": 4002,
                        "name": "Blue",
                        "artists": [{"name": "Yung Kai"}],
                    }
                },
                {
                    "song": {
                        "name": "Missing Recent Id",
                        "artists": [{"name": "Invalid Artist"}],
                    }
                },
            ]
        }

    async def like_list(self, uid):
        return [3001, "4002"]


class FakeLLM:
    def __init__(self):
        self.prompts = []

    async def chat(self, prompt, max_tokens=800):
        self.prompts.append(prompt)
        return json.dumps(
            {
                "music_dna": {
                    "genres": {"华语流行": 0.8},
                    "era_bias": "近年",
                    "energy_level": "中",
                    "language_bias": {"中文": 0.8},
                    "vocal_preference": "人声",
                },
                "personality": {
                    "mbti_guess": "INFP",
                    "traits": ["怀旧"],
                    "emotional_resonance": "温柔",
                },
                "listening_pattern": {
                    "peak_hours": ["night"],
                    "avg_session_guess": "30",
                },
                "dj_style_suggestion": "像熟悉你的朋友一样自然",
            },
            ensure_ascii=False,
        )


class FakeStore:
    def __init__(self):
        self.saved_profiles = []

    async def get_user_settings(self, uid):
        return {"music_notes": "最近想听安静、熟悉一点的歌。"}

    async def save_profile(self, uid, profile):
        self.saved_profiles.append((uid, profile))


class MalformedTrackNetease(FakeNetease):
    async def user_playlist(self, uid):
        return [{"id": 303, "name": "Malformed"}]

    async def playlist_detail(self, playlist_id):
        self.detail_calls.append(playlist_id)
        return {
            "playlist": {
                "tracks": [
                    None,
                    {"id": "", "name": "Empty Id", "ar": [{"name": "Nobody"}]},
                    {"id": 5001, "name": "Ar None", "ar": [None]},
                    {"id": 5002, "name": "Ar String", "ar": ["A"]},
                    {"id": 5003, "name": "Artists Dict", "artists": {"name": "Solo"}},
                    {"id": 5004, "name": "Artists String", "artists": "Solo"},
                ]
            }
        }

    async def user_record(self, uid):
        return {"weekData": []}

    async def like_list(self, uid):
        return []


class RaisingRecordNetease(FakeNetease):
    async def user_record(self, uid):
        raise RuntimeError("record unavailable")


class NonDictRecordNetease(FakeNetease):
    async def user_record(self, uid):
        return ["not", "a", "dict"]


class RaisingLikeListNetease(FakeNetease):
    async def like_list(self, uid):
        raise RuntimeError("likes unavailable")


class RaisingSettingsStore(FakeStore):
    async def get_user_settings(self, uid):
        raise RuntimeError("settings unavailable")


class ProfileEnginePlaylistDetailTest(unittest.IsolatedAsyncioTestCase):
    async def test_analyze_uses_playlist_details_and_persists_music_anchors(self):
        netease = FakeNetease()
        llm = FakeLLM()
        store = FakeStore()
        engine = ProfileEngine(netease, llm, store)

        profile = await engine.analyze(42)

        self.assertEqual(netease.detail_calls, [101, 202])
        self.assertIn("最近想听安静、熟悉一点的歌。", llm.prompts[0])
        self.assertIn("晴天", llm.prompts[0])
        self.assertIn("The Scientist", llm.prompts[0])

        self.assertEqual(
            profile["anchor_tracks"],
            [
                {
                    "id": "3001",
                    "name": "晴天",
                    "artist": "周杰伦",
                    "source": "playlist",
                },
                {
                    "id": "3002",
                    "name": "The Scientist",
                    "artist": "Coldplay",
                    "source": "playlist",
                },
                {
                    "id": "3003",
                    "name": "匿名的好友",
                    "artist": "",
                    "source": "playlist",
                },
            ],
        )
        self.assertEqual(
            profile["recent_tracks"],
            [
                {
                    "id": "4001",
                    "name": "晚安",
                    "artist": "颜人中",
                    "source": "recent",
                },
                {
                    "id": "4002",
                    "name": "Blue",
                    "artist": "Yung Kai",
                    "source": "recent",
                },
            ],
        )
        self.assertEqual(profile["liked_track_ids"], ["3001", "4002"])
        self.assertNotIn("", [track["id"] for track in profile["anchor_tracks"]])
        self.assertNotIn("", [track["id"] for track in profile["recent_tracks"]])
        self.assertNotIn("Missing Playlist Id", llm.prompts[0])
        self.assertNotIn("Missing Recent Id", llm.prompts[0])

        self.assertEqual(len(store.saved_profiles), 1)
        saved_uid, saved_profile = store.saved_profiles[0]
        self.assertEqual(saved_uid, "42")
        self.assertEqual(saved_profile["anchor_tracks"], profile["anchor_tracks"])
        self.assertEqual(saved_profile["recent_tracks"], profile["recent_tracks"])
        self.assertEqual(saved_profile["liked_track_ids"], profile["liked_track_ids"])
        self.assertNotIn("", [track["id"] for track in saved_profile["anchor_tracks"]])
        self.assertNotIn("", [track["id"] for track in saved_profile["recent_tracks"]])

    async def test_malformed_playlist_tracks_do_not_break_analysis_or_make_bad_anchors(self):
        netease = MalformedTrackNetease()
        llm = FakeLLM()
        store = FakeStore()
        engine = ProfileEngine(netease, llm, store)

        profile = await engine.analyze(42)

        self.assertEqual(netease.detail_calls, [303])
        self.assertEqual(
            profile["anchor_tracks"],
            [
                {"id": "5001", "name": "Ar None", "artist": "", "source": "playlist"},
                {"id": "5002", "name": "Ar String", "artist": "", "source": "playlist"},
                {"id": "5003", "name": "Artists Dict", "artist": "Solo", "source": "playlist"},
                {"id": "5004", "name": "Artists String", "artist": "", "source": "playlist"},
            ],
        )
        self.assertEqual(store.saved_profiles[0][1]["anchor_tracks"], profile["anchor_tracks"])
        self.assertNotIn("", [track["id"] for track in profile["anchor_tracks"]])
        self.assertNotIn("Empty Id", llm.prompts[0])

    async def test_user_record_exception_leaves_recent_empty_and_still_saves_profile(self):
        store = FakeStore()
        engine = ProfileEngine(RaisingRecordNetease(), FakeLLM(), store)

        profile = await engine.analyze(42)

        self.assertEqual(profile["recent_tracks"], [])
        self.assertEqual(store.saved_profiles[0][1]["recent_tracks"], [])

    async def test_user_record_non_dict_leaves_recent_empty_and_still_saves_profile(self):
        store = FakeStore()
        engine = ProfileEngine(NonDictRecordNetease(), FakeLLM(), store)

        profile = await engine.analyze(42)

        self.assertEqual(profile["recent_tracks"], [])
        self.assertEqual(store.saved_profiles[0][1]["recent_tracks"], [])

    async def test_like_list_exception_leaves_liked_ids_empty_and_still_saves_profile(self):
        store = FakeStore()
        engine = ProfileEngine(RaisingLikeListNetease(), FakeLLM(), store)

        profile = await engine.analyze(42)

        self.assertEqual(profile["liked_track_ids"], [])
        self.assertEqual(store.saved_profiles[0][1]["liked_track_ids"], [])

    async def test_user_settings_exception_uses_empty_notes_and_still_saves_profile(self):
        llm = FakeLLM()
        store = RaisingSettingsStore()
        engine = ProfileEngine(FakeNetease(), llm, store)

        profile = await engine.analyze(42)

        self.assertIn("anchor_tracks", profile)
        self.assertEqual(len(store.saved_profiles), 1)
        self.assertNotIn("最近想听", llm.prompts[0])


if __name__ == "__main__":
    unittest.main()
