import unittest

from backend.engines.scheduler import StreamScheduler


class FakeNetease:
    def __init__(self):
        self.similar = []
        self.daily = []
        self.fm = []
        self.search_results = []
        self.search_calls = []
        self.raw_similar = None
        self.raw_daily = None
        self.raw_fm = None
        self.raise_similar = False
        self.raise_daily = False
        self.raise_fm = False
        self.urls = {}

    async def simi_song(self, song_id):
        if self.raise_similar:
            raise RuntimeError("similar unavailable")
        if self.raw_similar is not None:
            return self.raw_similar
        return list(self.similar)

    async def recommend_songs(self):
        if self.raise_daily:
            raise RuntimeError("daily unavailable")
        if self.raw_daily is not None:
            return self.raw_daily
        return list(self.daily)

    async def personal_fm(self):
        if self.raise_fm:
            raise RuntimeError("fm unavailable")
        if self.raw_fm is not None:
            return self.raw_fm
        return list(self.fm)

    async def search(self, keywords, limit=5):
        self.search_calls.append({"keywords": keywords, "limit": limit})
        return list(self.search_results)

    async def song_url(self, song_id):
        return self.urls.get(str(song_id), "")


class FakeStore:
    def __init__(self, recent=None):
        self.recent = [str(song_id) for song_id in (recent or [])]
        self.calls = []

    async def get_recent_tracks(self, limit=100, uid=None):
        self.calls.append({"limit": limit, "uid": uid})
        return self.recent[:limit]


class RaisingRecentStore(FakeStore):
    async def get_recent_tracks(self, limit=100, uid=None):
        raise RuntimeError("recent unavailable")


class NonListRecentStore(FakeStore):
    async def get_recent_tracks(self, limit=100, uid=None):
        return {"fallback-ok": True}


class SchedulerPersonalizedPickTests(unittest.IsolatedAsyncioTestCase):
    def make_scheduler(self, netease=None, store=None):
        return StreamScheduler(netease or FakeNetease(), store or FakeStore(), bus=None)

    def profile_with_anchors(self, *tracks):
        return {"anchor_tracks": list(tracks)}

    async def test_first_pick_prefers_profile_anchor_with_familiar_reason(self):
        scheduler = self.make_scheduler()
        profile = self.profile_with_anchors(
            {"id": "anchor-1", "name": "Anchor One", "artist": "Anchor Artist"}
        )

        song = await scheduler.pick_next(profile=profile)

        self.assertEqual(song["id"], "anchor-1")
        self.assertEqual(song["name"], "Anchor One")
        self.assertEqual(song["ar"][0]["name"], "Anchor Artist")
        self.assertEqual(song["selection_reason"]["type"], "familiar_anchor")
        self.assertIn("Anchor One", song["selection_reason"]["text"])

    async def test_request_intent_searches_before_profile_anchor_and_keeps_short_term_direction(self):
        netease = FakeNetease()
        netease.search_results = [
            {"id": "request-1", "name": "Night Drive", "ar": [{"name": "City Singer"}]},
        ]
        scheduler = self.make_scheduler(netease=netease)
        state = scheduler.new_session_state()
        profile = self.profile_with_anchors(
            {"id": "anchor-1", "name": "Anchor One", "artist": "Anchor Artist"}
        )

        song = await scheduler.pick_next(
            profile=profile,
            user_settings={
                "listening_intent": {
                    "raw_text": "想听夜路上放空的歌",
                    "keywords": "夜路 放空",
                    "mood": "城市夜行",
                }
            },
            session_state=state,
        )

        self.assertEqual(song["id"], "request-1")
        self.assertEqual(netease.search_calls[0]["keywords"], "夜晚 放空 开车")
        self.assertEqual(song["selection_reason"]["type"], "request_intent")
        self.assertIn("想听夜路上放空的歌", song["selection_reason"]["text"])
        self.assertEqual(state.intent_picks_remaining, 3)

    async def test_request_intent_falls_back_to_normal_flow_when_search_has_no_candidates(self):
        netease = FakeNetease()
        scheduler = self.make_scheduler(netease=netease)
        profile = self.profile_with_anchors(
            {"id": "anchor-1", "name": "Anchor One", "artist": "Anchor Artist"}
        )

        song = await scheduler.pick_next(
            profile=profile,
            user_settings={"listening_intent": {"raw_text": "想听海边", "keywords": "海边"}},
        )

        self.assertEqual(song["id"], "anchor-1")
        self.assertEqual(netease.search_calls[0]["keywords"], "海边")
        self.assertEqual(song["selection_reason"]["type"], "familiar_anchor")

    async def test_request_intent_turns_emo_sentence_into_focused_search_terms(self):
        netease = FakeNetease()
        netease.search_results = [
            {"id": "emo-1", "name": "Sad Song", "ar": [{"name": "Soft Singer"}]},
        ]
        scheduler = self.make_scheduler(netease=netease)

        song = await scheduler.pick_next(
            profile={},
            user_settings={
                "listening_intent": {
                    "raw_text": "我不是很开心，放点emo的",
                    "keywords": "我不是很开心，放点emo的",
                }
            },
            session_state=scheduler.new_session_state(),
        )

        self.assertEqual(song["id"], "emo-1")
        self.assertEqual(netease.search_calls[0]["keywords"], "emo 伤感 不开心")

    async def test_request_intent_does_not_search_raw_i_want_sentence(self):
        netease = FakeNetease()
        scheduler = self.make_scheduler(netease=netease)
        scheduler._fallback_queue = [
            {"id": "fallback-ok", "name": "Fallback OK", "ar": [{"name": "Fallback Artist"}]}
        ]

        song = await scheduler.pick_next(
            profile={},
            user_settings={
                "listening_intent": {
                    "raw_text": "我想听李云迪的普2",
                    "keywords": "我想听李云迪的普2",
                }
            },
            session_state=scheduler.new_session_state(),
        )

        self.assertEqual(song["id"], "fallback-ok")
        self.assertNotIn(
            "我想听李云迪的普2",
            [call["keywords"] for call in netease.search_calls],
        )

    async def test_brain_negative_feedback_prefers_profile_candidate_without_search(self):
        netease = FakeNetease()
        scheduler = self.make_scheduler(netease=netease)
        state = scheduler.new_session_state()
        profile = self.profile_with_anchors(
            {
                "id": "anchor-cn",
                "name": "中文歌",
                "artist": "华语歌手",
                "language": "中文",
            },
            {
                "id": "anchor-en",
                "name": "Exit Music",
                "artist": "Radiohead",
                "language": "英文",
            },
        )

        song = await scheduler.pick_next(
            profile=profile,
            user_settings={
                "radio_brain": {
                    "decision": {
                        "intent_type": "negative_feedback",
                        "raw_text": "能不能不要放这些中文歌了",
                        "candidate_strategy": "profile_first",
                        "allow_search": False,
                        "avoid_languages": ["中文"],
                        "avoid_styles": ["华语流行", "热门流行", "口水歌"],
                        "duration_tracks": 5,
                    }
                }
            },
            session_state=state,
        )

        self.assertEqual(song["id"], "anchor-en")
        self.assertEqual(song["selection_reason"]["type"], "radio_brain_profile")
        self.assertEqual(netease.search_calls, [])

    async def test_recent_or_session_played_anchors_are_skipped_before_discovery(self):
        netease = FakeNetease()
        netease.similar = [
            {"id": "similar-1", "name": "Similar One", "ar": [{"name": "New Artist"}]}
        ]
        store = FakeStore(recent=["anchor-db"])
        scheduler = self.make_scheduler(netease=netease, store=store)
        state = scheduler.new_session_state()
        state.played_song_ids.add("anchor-session")
        profile = self.profile_with_anchors(
            {"id": "anchor-db", "name": "DB Anchor", "artist": "Known Artist"},
            {"id": "anchor-session", "name": "Session Anchor", "artist": "Known Artist"},
        )

        song = await scheduler.pick_next(
            "current-1",
            profile=profile,
            session_state=state,
            uid="42",
        )

        self.assertEqual(song["id"], "similar-1")
        self.assertEqual(song["selection_reason"]["type"], "discovery_similar")
        self.assertEqual(store.calls[0]["uid"], "42")

    async def test_discovery_pools_all_return_selection_reason_types(self):
        profile = self.profile_with_anchors(
            {"id": "anchor-db", "name": "DB Anchor", "artist": "Known Artist"}
        )

        similar_netease = FakeNetease()
        similar_netease.similar = [{"id": "sim", "name": "Sim", "ar": [{"name": "A"}]}]
        similar_song = await self.make_scheduler(
            netease=similar_netease,
            store=FakeStore(recent=["anchor-db"]),
        ).pick_next("current", profile=profile)
        self.assertEqual(similar_song["selection_reason"]["type"], "discovery_similar")

        daily_netease = FakeNetease()
        daily_netease.daily = [{"id": "daily", "name": "Daily", "ar": [{"name": "B"}]}]
        daily_song = await self.make_scheduler(
            netease=daily_netease,
            store=FakeStore(recent=["anchor-db"]),
        ).pick_next("current", profile=profile)
        self.assertEqual(daily_song["selection_reason"]["type"], "daily_personal")

        fm_netease = FakeNetease()
        fm_netease.fm = [{"id": "fm", "name": "FM", "ar": [{"name": "C"}]}]
        fm_song = await self.make_scheduler(
            netease=fm_netease,
            store=FakeStore(recent=["anchor-db"]),
        ).pick_next("current", profile=profile)
        self.assertEqual(fm_song["selection_reason"]["type"], "personal_fm")

        fallback_netease = FakeNetease()
        fallback_netease.raise_similar = True
        fallback_netease.raise_daily = True
        fallback_netease.raise_fm = True
        fallback_song = await self.make_scheduler(
            netease=fallback_netease,
            store=FakeStore(recent=["anchor-db"]),
        ).pick_next("current", profile=profile)
        self.assertEqual(fallback_song["selection_reason"]["type"], "fallback")

    async def test_recent_artist_repeat_is_avoided_when_possible(self):
        netease = FakeNetease()
        netease.similar = [
            {"id": "same-artist", "name": "Same Artist Song", "ar": [{"name": "Recent Artist"}]},
            {"id": "fresh-artist", "name": "Fresh Artist Song", "ar": [{"name": "Fresh Artist"}]},
        ]
        profile = {
            "anchor_tracks": [{"id": "anchor-db", "name": "Anchor", "artist": "Recent Artist"}],
            "recent_tracks": [{"id": "recent-profile", "name": "Recent", "artist": "Recent Artist"}],
        }

        song = await self.make_scheduler(
            netease=netease,
            store=FakeStore(recent=["anchor-db"]),
        ).pick_next("current", profile=profile)

        self.assertEqual(song["id"], "fresh-artist")
        self.assertEqual(song["selection_reason"]["type"], "discovery_similar")

    async def test_song_url_behavior_returns_empty_when_netease_has_no_real_url(self):
        netease = FakeNetease()
        scheduler = self.make_scheduler(netease=netease)

        url = await scheduler.get_song_url({"id": "song-1"})

        self.assertEqual(url, "")

    async def test_fallback_pool_avoids_recent_artist_across_queue_candidates(self):
        netease = FakeNetease()
        scheduler = self.make_scheduler(netease=netease)
        scheduler._fallback_queue = [
            {
                "id": "fallback-same",
                "name": "Fallback Same Artist",
                "ar": [{"name": "Recent Artist"}],
            },
            {
                "id": "fallback-fresh",
                "name": "Fallback Fresh Artist",
                "ar": [{"name": "Fresh Artist"}],
            },
        ]
        state = scheduler.new_session_state()
        state.artist_names.append("Recent Artist")

        song = await scheduler.pick_next("current", profile={}, session_state=state)

        self.assertEqual(song["id"], "fallback-fresh")
        self.assertEqual(song["selection_reason"]["type"], "fallback")
        self.assertEqual(
            [queued["id"] for queued in scheduler._fallback_queue],
            ["fallback-same"],
        )

    async def test_similar_pool_does_not_pick_current_song_id_again(self):
        netease = FakeNetease()
        netease.similar = [
            {"id": "current", "name": "Current Song", "ar": [{"name": "Same Artist"}]},
            {"id": "fresh", "name": "Fresh Song", "ar": [{"name": "Fresh Artist"}]},
        ]
        scheduler = self.make_scheduler(netease=netease)

        song = await scheduler.pick_next("current", profile={})

        self.assertEqual(song["id"], "fresh")
        self.assertEqual(song["selection_reason"]["type"], "discovery_similar")

    async def test_session_state_isolated_between_independent_sessions(self):
        scheduler = self.make_scheduler()
        session_a = scheduler.new_session_state()
        session_b = scheduler.new_session_state()
        profile = self.profile_with_anchors(
            {"id": "anchor-1", "name": "Anchor One", "artist": "Anchor Artist"}
        )

        song_a = await scheduler.pick_next(profile=profile, session_state=session_a)
        song_b = await scheduler.pick_next(profile=profile, session_state=session_b)

        self.assertEqual(song_a["id"], "anchor-1")
        self.assertEqual(song_b["id"], "anchor-1")

    async def test_recent_track_lookup_failure_still_picks_fallback(self):
        netease = FakeNetease()
        scheduler = self.make_scheduler(netease=netease, store=RaisingRecentStore())
        scheduler._fallback_queue = [
            {"id": "fallback-ok", "name": "Fallback OK", "ar": [{"name": "Fallback Artist"}]}
        ]

        song = await scheduler.pick_next("current", profile={})

        self.assertEqual(song["id"], "fallback-ok")
        self.assertEqual(song["selection_reason"]["type"], "fallback")

    async def test_non_list_recent_track_result_is_ignored_without_excluding_songs(self):
        netease = FakeNetease()
        scheduler = self.make_scheduler(netease=netease, store=NonListRecentStore())
        scheduler._fallback_queue = [
            {"id": "fallback-ok", "name": "Fallback OK", "ar": [{"name": "Fallback Artist"}]}
        ]

        song = await scheduler.pick_next("current", profile={})

        self.assertEqual(song["id"], "fallback-ok")
        self.assertEqual(song["selection_reason"]["type"], "fallback")

    async def test_non_list_netease_pools_are_ignored_without_crashing(self):
        netease = FakeNetease()
        netease.raw_similar = {"id": "not-a-list"}
        netease.raw_daily = "not-a-list"
        netease.raw_fm = {"data": []}
        scheduler = self.make_scheduler(netease=netease)
        scheduler._fallback_queue = [
            {"id": "fallback-ok", "name": "Fallback OK", "ar": [{"name": "Fallback Artist"}]}
        ]

        song = await scheduler.pick_next("current", profile={})

        self.assertEqual(song["id"], "fallback-ok")
        self.assertEqual(song["selection_reason"]["type"], "fallback")

    async def test_non_list_profile_recent_tracks_are_ignored_without_crashing(self):
        netease = FakeNetease()
        netease.raw_similar = {"id": "not-a-list"}
        netease.raw_daily = "not-a-list"
        netease.raw_fm = "not-a-list"
        scheduler = self.make_scheduler(netease=netease)
        scheduler._fallback_queue = [
            {"id": "fallback-ok", "name": "Fallback OK", "ar": [{"name": "Fallback Artist"}]}
        ]
        profile = {"recent_tracks": {"id": "x", "artist": "A"}}

        song = await scheduler.pick_next("current", profile=profile)

        self.assertEqual(song["id"], "fallback-ok")
        self.assertEqual(song["selection_reason"]["type"], "fallback")


if __name__ == "__main__":
    unittest.main()
