import unittest

from backend.engines.scheduler import StreamScheduler


class FakeNetease:
    def __init__(self):
        self.similar = []
        self.daily = []
        self.fm = []
        self.raise_similar = False
        self.raise_daily = False
        self.raise_fm = False
        self.urls = {}

    async def simi_song(self, song_id):
        if self.raise_similar:
            raise RuntimeError("similar unavailable")
        return list(self.similar)

    async def recommend_songs(self):
        if self.raise_daily:
            raise RuntimeError("daily unavailable")
        return list(self.daily)

    async def personal_fm(self):
        if self.raise_fm:
            raise RuntimeError("fm unavailable")
        return list(self.fm)

    async def song_url(self, song_id):
        return self.urls.get(str(song_id), "")


class FakeStore:
    def __init__(self, recent=None):
        self.recent = [str(song_id) for song_id in (recent or [])]

    async def get_recent_tracks(self, limit=100):
        return self.recent[:limit]


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

    async def test_recent_or_session_played_anchors_are_skipped_before_discovery(self):
        netease = FakeNetease()
        netease.similar = [
            {"id": "similar-1", "name": "Similar One", "ar": [{"name": "New Artist"}]}
        ]
        scheduler = self.make_scheduler(netease=netease, store=FakeStore(recent=["anchor-db"]))
        scheduler._played_this_session.add("anchor-session")
        profile = self.profile_with_anchors(
            {"id": "anchor-db", "name": "DB Anchor", "artist": "Known Artist"},
            {"id": "anchor-session", "name": "Session Anchor", "artist": "Known Artist"},
        )

        song = await scheduler.pick_next("current-1", profile=profile)

        self.assertEqual(song["id"], "similar-1")
        self.assertEqual(song["selection_reason"]["type"], "discovery_similar")

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

    async def test_song_url_behavior_still_falls_back_to_outer_url(self):
        netease = FakeNetease()
        scheduler = self.make_scheduler(netease=netease)

        url = await scheduler.get_song_url({"id": "song-1"})

        self.assertEqual(
            url,
            "https://music.163.com/song/media/outer/url?id=song-1.mp3",
        )

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
        scheduler._artists_this_session.append("Recent Artist")

        song = await scheduler.pick_next("current", profile={})

        self.assertEqual(song["id"], "fallback-fresh")
        self.assertEqual(song["selection_reason"]["type"], "fallback")
        self.assertEqual(
            [queued["id"] for queued in scheduler._fallback_queue],
            ["fallback-same"],
        )


if __name__ == "__main__":
    unittest.main()
