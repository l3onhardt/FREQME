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

        self.assertEqual(len(store.saved_profiles), 1)
        saved_uid, saved_profile = store.saved_profiles[0]
        self.assertEqual(saved_uid, "42")
        self.assertEqual(saved_profile["anchor_tracks"], profile["anchor_tracks"])
        self.assertEqual(saved_profile["recent_tracks"], profile["recent_tracks"])
        self.assertEqual(saved_profile["liked_track_ids"], profile["liked_track_ids"])


if __name__ == "__main__":
    unittest.main()
