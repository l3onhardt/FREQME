import unittest

from backend.engines.audio_resolver import AudioResolver


class FakeNetease:
    def __init__(self):
        self.urls = {}
        self.search_results = []

    async def song_url(self, song_id):
        return self.urls.get(str(song_id), "")

    async def search(self, keywords, limit=5):
        return self.search_results[:limit]


class FakeStore:
    def __init__(self):
        self.cache = {}
        self.events = []

    async def get_audio_resolution(self, song_id):
        return self.cache.get(str(song_id))

    async def save_audio_resolution(self, song_id, url, source, content_type=""):
        self.cache[str(song_id)] = {
            "song_id": str(song_id),
            "url": url,
            "source": source,
            "content_type": content_type,
        }

    async def log_playback_event(self, event_type, song_id=None, uid=None, reason=""):
        self.events.append({
            "event_type": event_type,
            "song_id": song_id,
            "uid": uid,
            "reason": reason,
        })


class AudioResolverTests(unittest.IsolatedAsyncioTestCase):
    async def test_uses_cached_resolution_first(self):
        netease = FakeNetease()
        store = FakeStore()
        store.cache["42"] = {
            "song_id": "42",
            "url": "https://cached.test/a.mp3",
            "source": "cache",
        }
        resolver = AudioResolver(netease, store)

        resolved = await resolver.resolve({"id": "42", "name": "A", "artist": "B"})

        self.assertEqual(resolved.url, "https://cached.test/a.mp3")
        self.assertEqual(resolved.source, "cache")

    async def test_falls_back_to_search_candidate_when_primary_is_empty(self):
        netease = FakeNetease()
        netease.urls = {"1": "", "2": "https://cdn.test/2.mp3"}
        netease.search_results = [{"id": "2", "name": "Song", "ar": [{"name": "Artist"}]}]
        store = FakeStore()
        resolver = AudioResolver(netease, store)

        resolved = await resolver.resolve_with_candidates(
            {"id": "1", "name": "Song", "ar": [{"name": "Artist"}]},
        )

        self.assertEqual(resolved.song_id, "2")
        self.assertEqual(resolved.url, "https://cdn.test/2.mp3")
        self.assertEqual(resolved.source, "search_candidate")

    async def test_rejects_search_candidate_with_different_title_and_artist(self):
        netease = FakeNetease()
        netease.urls = {"1": "", "2": "https://cdn.test/2.mp3"}
        netease.search_results = [{"id": "2", "name": "13", "ar": [{"name": "默樂隊"}]}]
        store = FakeStore()
        resolver = AudioResolver(netease, store)

        resolved = await resolver.resolve_with_candidates(
            {"id": "1", "name": "MY LEVEL (EGOTRIP)", "ar": [{"name": "Eliminate"}]},
            uid="u1",
        )

        self.assertFalse(resolved.ok)
        self.assertEqual(store.events[-1]["event_type"], "url_failed")
        self.assertEqual(store.events[-1]["reason"], "empty_url")

    async def test_allows_search_candidate_with_same_title_and_artist(self):
        netease = FakeNetease()
        netease.urls = {"1": "", "2": "https://cdn.test/2.mp3"}
        netease.search_results = [
            {
                "id": "2",
                "name": "MY LEVEL (EGOTRIP)",
                "ar": [{"name": "Eliminate"}],
            }
        ]
        store = FakeStore()
        resolver = AudioResolver(netease, store)

        resolved = await resolver.resolve_with_candidates(
            {"id": "1", "name": "MY LEVEL (EGOTRIP)", "ar": [{"name": "Eliminate"}]},
        )

        self.assertTrue(resolved.ok)
        self.assertEqual(resolved.song_id, "2")
        self.assertEqual(resolved.source, "search_candidate")

    async def test_falls_back_when_primary_is_unresolved_netease_outer_url(self):
        netease = FakeNetease()
        netease.urls = {
            "1": "https://music.163.com/song/media/outer/url?id=1.mp3",
            "2": "https://cdn.test/2.mp3",
        }
        netease.search_results = [{"id": "2", "name": "Song", "ar": [{"name": "Artist"}]}]
        store = FakeStore()
        resolver = AudioResolver(netease, store)

        resolved = await resolver.resolve_with_candidates(
            {"id": "1", "name": "Song", "ar": [{"name": "Artist"}]},
        )

        self.assertEqual(resolved.song_id, "2")
        self.assertEqual(resolved.url, "https://cdn.test/2.mp3")
        self.assertEqual(resolved.source, "search_candidate")

    async def test_ignores_cached_unresolved_netease_outer_url(self):
        netease = FakeNetease()
        netease.urls = {
            "1": "https://music.163.com/song/media/outer/url?id=1.mp3",
            "2": "https://cdn.test/2.mp3",
        }
        netease.search_results = [{"id": "2", "name": "Song", "ar": [{"name": "Artist"}]}]
        store = FakeStore()
        store.cache["1"] = {
            "song_id": "1",
            "url": "https://music.163.com/song/media/outer/url?id=1.mp3",
            "source": "cache",
        }
        resolver = AudioResolver(netease, store)

        resolved = await resolver.resolve_with_candidates(
            {"id": "1", "name": "Song", "ar": [{"name": "Artist"}]},
        )

        self.assertEqual(resolved.song_id, "2")
        self.assertEqual(resolved.url, "https://cdn.test/2.mp3")
        self.assertEqual(resolved.source, "search_candidate")

    async def test_logs_failure_when_no_candidate_resolves(self):
        netease = FakeNetease()
        netease.urls = {"1": ""}
        store = FakeStore()
        resolver = AudioResolver(netease, store)

        resolved = await resolver.resolve_with_candidates({"id": "1", "name": "Song"}, uid="u1")

        self.assertFalse(resolved.ok)
        self.assertEqual(store.events[-1]["event_type"], "url_failed")
        self.assertEqual(store.events[-1]["reason"], "empty_url")

    async def test_treats_adapter_outer_url_fallback_as_unplayable(self):
        netease = FakeNetease()
        netease.urls = {
            "1": "https://music.163.com/song/media/outer/url?id=1.mp3",
        }
        store = FakeStore()
        resolver = AudioResolver(netease, store)

        resolved = await resolver.resolve_with_candidates(
            {"id": "1", "name": "Song", "ar": [{"name": "Artist"}]},
            uid="u1",
        )

        self.assertFalse(resolved.ok)
        self.assertEqual(store.events[-1]["reason"], "unplayable_url")
