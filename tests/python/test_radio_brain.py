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

    def test_rejection_of_current_results_is_negative_feedback_not_song_search(self):
        brain = RadioBrain()

        decision = brain.interpret_user_text(
            "不是，不是这些",
            profile=sample_profile(),
            user_settings={},
        )

        self.assertEqual(decision.intent_type, "negative_feedback")
        self.assertFalse(decision.allow_search)
        self.assertEqual(decision.candidate_strategy, "profile_first")
        self.assertIn("不是这些", decision.ack_text)

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

    def test_correction_with_composer_name_routes_to_specific_agent(self):
        brain = RadioBrain()

        decision = brain.interpret_user_text(
            "我说的是普罗科菲耶夫",
            profile=sample_profile(),
            user_settings={},
        )

        self.assertEqual(decision.intent_type, "specific_song")
        self.assertTrue(decision.allow_search)
        self.assertEqual(decision.search_text, "我说的是普罗科菲耶夫")
        self.assertNotIn("往", decision.ack_text)

    def test_bare_composer_or_artist_name_routes_to_specific_agent(self):
        brain = RadioBrain()

        decision = brain.interpret_user_text(
            "普罗科菲耶夫",
            profile=sample_profile(),
            user_settings={},
        )

        self.assertEqual(decision.intent_type, "specific_song")
        self.assertTrue(decision.allow_search)

    def test_possessive_artist_fragment_routes_to_artist_direction(self):
        brain = RadioBrain()

        decision = brain.interpret_user_text(
            "linkin park的",
            profile=sample_profile(),
            user_settings={},
        )

        self.assertEqual(decision.intent_type, "artist_direction")
        self.assertTrue(decision.allow_search)
        self.assertFalse(decision.search_raw_text)
        self.assertEqual(decision.prefer_artists, ["Linkin Park"])
        self.assertEqual(decision.semantic_queries[0], "Linkin Park")
        self.assertNotIn("换个说法", decision.ack_text)

    def test_misspelled_english_artist_fragment_routes_to_artist_direction(self):
        brain = RadioBrain()

        decision = brain.interpret_user_text(
            "linkin parl",
            profile=sample_profile(),
            user_settings={},
        )

        self.assertEqual(decision.intent_type, "artist_direction")
        self.assertTrue(decision.allow_search)
        self.assertFalse(decision.search_raw_text)
        self.assertEqual(decision.prefer_artists, ["Linkin Parl"])
        self.assertEqual(decision.semantic_queries, [])
        self.assertIn("校正", decision.ack_text)
        self.assertNotIn("Linkin Parl", decision.ack_text)
        self.assertNotIn("换个说法", decision.ack_text)

    def test_afternoon_rnb_is_taste_direction_with_clear_style(self):
        brain = RadioBrain()

        decision = brain.interpret_user_text(
            "来点下午听的rnb",
            profile=sample_profile(),
            user_settings={"local_time_block": "afternoon"},
        )

        self.assertEqual(decision.intent_type, "taste_direction")
        self.assertFalse(decision.allow_search)
        self.assertIn("R&B", decision.prefer_styles)
        self.assertIn("下午", decision.prefer_styles)
        self.assertIn("R&B", decision.ack_text)
        self.assertNotIn("没找到", decision.ack_text)

    def test_high_energy_electronic_request_builds_semantic_plan_not_raw_search(self):
        brain = RadioBrain()

        decision = brain.interpret_user_text(
            "我想听点炸场电音",
            profile=sample_profile(),
            user_settings={"local_time_block": "afternoon", "weather_hint": "晴"},
        )
        plan = decision.to_dict()

        self.assertEqual(decision.intent_type, "taste_direction")
        self.assertIn("电子", decision.prefer_styles)
        self.assertIn("EDM", decision.prefer_styles)
        self.assertEqual(plan.get("energy"), "high")
        self.assertEqual(plan.get("use_case"), "lift_energy")
        self.assertEqual(plan.get("semantic_queries", [])[0], "电子 舞曲 高能")
        self.assertNotIn("我想听点炸场电音", plan.get("semantic_queries", []))
        self.assertFalse(plan.get("search_raw_text", True))
        self.assertIn("电子", decision.ack_text)
        self.assertNotIn("没找到", decision.ack_text)

    def test_late_night_emo_request_has_clear_scene_and_not_generic_ack(self):
        brain = RadioBrain()

        decision = brain.interpret_user_text(
            "来点半夜emo的歌",
            profile=sample_profile(),
            user_settings={"local_time_block": "late_night"},
        )
        plan = decision.to_dict()

        self.assertEqual(decision.intent_type, "taste_direction")
        self.assertIn("emo", decision.prefer_styles)
        self.assertIn("深夜", decision.prefer_styles)
        self.assertEqual(plan.get("energy"), "low")
        self.assertEqual(plan.get("use_case"), "late_night_emo")
        self.assertIn("emo 深夜", plan.get("semantic_queries", []))
        self.assertIn("半夜", decision.ack_text)
        self.assertNotIn("往“来点半夜emo的歌”这个方向接", decision.ack_text)

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

    def test_negative_feedback_creates_profile_learning_patch(self):
        brain = RadioBrain()
        profile = sample_profile()
        decision = brain.interpret_user_text(
            "能不能不要放这些中文歌了",
            profile=profile,
            user_settings={},
        )

        updated = brain.apply_learning_signal(
            profile,
            {
                "event_type": "negative_feedback",
                "decision": decision.to_dict(),
                "song": {"id": "current", "name": "中文歌", "artist": "华语歌手"},
            },
        )

        learned = updated["radio_brain"]["learned_preferences"]
        self.assertIn("中文", learned["avoid_languages"])
        self.assertIn("华语流行", learned["avoid_styles"])
        self.assertEqual(learned["negative_feedback_count"], 1)
        self.assertEqual(learned["last_feedback"], "能不能不要放这些中文歌了")

    def test_distilled_taste_reads_learned_preferences(self):
        brain = RadioBrain()
        profile = sample_profile()
        profile["radio_brain"] = {
            "learned_preferences": {
                "avoid_languages": ["中文"],
                "avoid_styles": ["华语流行", "口水歌"],
                "negative_feedback_count": 3,
            }
        }

        taste = brain.distill_taste(profile)

        self.assertIn("中文", taste.avoided_languages)
        self.assertIn("华语流行", taste.avoided_styles)

    def test_ranker_respects_learned_avoidance_without_new_feedback(self):
        brain = RadioBrain()
        profile = sample_profile()
        profile["radio_brain"] = {
            "learned_preferences": {
                "avoid_languages": ["中文"],
                "avoid_styles": ["华语流行"],
            }
        }
        taste = brain.distill_taste(profile)

        ranked = brain.rank_candidates(
            [
                {"id": "cn", "name": "中文歌", "artist": "华语歌手", "language": "中文"},
                {"id": "en", "name": "Exit Music", "artist": "Radiohead", "language": "英文"},
            ],
            taste,
            None,
        )

        self.assertEqual(ranked[0]["id"], "en")

    def test_skip_signal_records_recently_skipped_track(self):
        brain = RadioBrain()

        updated = brain.apply_learning_signal(
            sample_profile(),
            {
                "event_type": "skipped",
                "song": {"id": "skip-1", "name": "Skipped Song", "artist": "A"},
            },
        )

        learned = updated["radio_brain"]["learned_preferences"]
        self.assertEqual(learned["skip_count"], 1)
        self.assertEqual(learned["skipped_track_ids"][0], "skip-1")

    def test_ranker_deprioritizes_learned_skipped_tracks(self):
        brain = RadioBrain()
        profile = sample_profile()
        profile["radio_brain"] = {
            "learned_preferences": {
                "skipped_track_ids": ["skip-1"],
            }
        }
        taste = brain.distill_taste(profile)

        ranked = brain.rank_candidates(
            [
                {"id": "skip-1", "name": "Skipped Song", "artist": "A", "language": "英文"},
                {"id": "fresh", "name": "Fresh Song", "artist": "B", "language": "英文"},
            ],
            taste,
            None,
        )

        self.assertEqual(ranked[0]["id"], "fresh")


if __name__ == "__main__":
    unittest.main()
