import unittest

from backend.engines.radio_brain import RadioBrain


def sample_profile():
    return {
        "music_dna": {
            "language_bias": {"英文": 0.7, "中文": 0.2},
            "genres": {"alternative rock": 0.8, "古典": 0.5},
            "energy_level": "中低",
        },
        "radio_insights": {
            "taste_summary": "用户偏好冷一点、没那么口水的英文和古典方向。",
            "comfort_zone": ["Radiohead", "Yundi Li", "冷感摇滚"],
            "discovery_direction": ["非中文", "更克制的器乐", "不要热门华语流行"],
        },
        "anchor_tracks": [
            {
                "id": "anchor-cn",
                "name": "中文歌",
                "artist": "华语歌手",
                "language": "中文",
                "source": "playlist",
            },
            {
                "id": "anchor-en",
                "name": "Exit Music",
                "artist": "Radiohead",
                "language": "英文",
                "source": "playlist",
            },
        ],
        "recent_tracks": [
            {
                "id": "recent-classical",
                "name": "Piano Concerto No.2",
                "artist": "Yundi Li",
                "language": "纯音乐",
                "source": "recent",
            }
        ],
    }


class RadioBrainTests(unittest.TestCase):
    def test_negative_feedback_avoids_chinese_and_disables_search(self):
        brain = RadioBrain()

        decision = brain.interpret_user_text(
            "能不能不要放这些中文歌了",
            profile=sample_profile(),
            user_settings={"timezone_name": "Asia/Hong_Kong", "region_hint": "香港"},
        )

        self.assertEqual(decision.intent_type, "negative_feedback")
        self.assertEqual(decision.candidate_strategy, "profile_first")
        self.assertIn("中文", decision.avoid_languages)
        self.assertIn("华语流行", decision.avoid_styles)
        self.assertFalse(decision.allow_search)
        self.assertGreaterEqual(decision.duration_tracks, 3)
        self.assertIn("中文", decision.ack_text)

    def test_specific_song_request_still_allows_precise_search_agent(self):
        brain = RadioBrain()

        decision = brain.interpret_user_text(
            "我想听李云迪的普2",
            profile=sample_profile(),
            user_settings={},
        )

        self.assertEqual(decision.intent_type, "specific_song")
        self.assertTrue(decision.allow_search)
        self.assertEqual(decision.candidate_strategy, "specific_search")

    def test_distills_existing_profile_into_executable_taste_model(self):
        brain = RadioBrain()

        taste = brain.distill_taste(sample_profile())

        self.assertIn("英文", taste.preferred_languages)
        self.assertIn("alternative rock", taste.preferred_styles)
        self.assertEqual([track["id"] for track in taste.comfort_tracks[:2]], ["anchor-cn", "anchor-en"])
        self.assertIn("不要热门华语流行", taste.discovery_directions)

    def test_ranker_prefers_candidates_that_satisfy_negative_feedback(self):
        brain = RadioBrain()
        taste = brain.distill_taste(sample_profile())
        decision = brain.interpret_user_text(
            "别放中文歌了",
            profile=sample_profile(),
            user_settings={},
        )

        ranked = brain.rank_candidates(
            [
                {
                    "id": "cn",
                    "name": "中文歌",
                    "ar": [{"name": "华语歌手"}],
                    "language": "中文",
                },
                {
                    "id": "en",
                    "name": "Exit Music",
                    "ar": [{"name": "Radiohead"}],
                    "language": "英文",
                    "source": "playlist",
                },
            ],
            taste,
            decision,
        )

        self.assertEqual(ranked[0]["id"], "en")


if __name__ == "__main__":
    unittest.main()
