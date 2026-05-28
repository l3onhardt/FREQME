import unittest

from backend.adapters.netease import NeteaseAdapter


class FakeResponse:
    def __init__(self, data):
        self.data = data

    def json(self):
        return self.data


class FakeClient:
    def __init__(self, responses):
        self.responses = list(responses)
        self.calls = []

    async def get(self, url, params=None, timeout=None):
        self.calls.append({"url": url, "params": params, "timeout": timeout})
        response = self.responses.pop(0)
        if isinstance(response, Exception):
            raise response
        return FakeResponse(response)

    async def aclose(self):
        pass


class NeteaseAdapterTests(unittest.IsolatedAsyncioTestCase):
    async def test_search_prefers_cloudsearch_and_normalizes_artists_album(self):
        client = FakeClient([
            {
                "result": {
                    "songs": [
                        {
                            "id": 1,
                            "name": "No Surprises",
                            "artists": [{"name": "Radiohead"}],
                            "album": {"name": "OK Computer"},
                        }
                    ]
                }
            }
        ])
        adapter = NeteaseAdapter(client=client)

        songs = await adapter.search("Radiohead No Surprises", limit=3)

        self.assertEqual(client.calls[0]["url"].rsplit("/", 1)[-1], "cloudsearch")
        self.assertEqual(client.calls[0]["params"]["limit"], 3)
        self.assertEqual(songs[0]["ar"], [{"name": "Radiohead"}])
        self.assertEqual(songs[0]["al"], {"name": "OK Computer"})

    async def test_search_falls_back_to_legacy_search_when_cloudsearch_is_empty(self):
        client = FakeClient([
            {"result": {"songs": []}},
            {
                "result": {
                    "songs": [
                        {
                            "id": 2,
                            "name": "Creep",
                            "artists": [{"name": "Radiohead"}],
                            "album": {"name": "Pablo Honey"},
                        }
                    ]
                }
            },
        ])
        adapter = NeteaseAdapter(client=client)

        songs = await adapter.search("Radiohead Creep", limit=4)

        called_paths = [call["url"].rsplit("/", 1)[-1] for call in client.calls]
        self.assertEqual(called_paths, ["cloudsearch", "search"])
        self.assertEqual(songs[0]["name"], "Creep")
        self.assertEqual(songs[0]["ar"][0]["name"], "Radiohead")

if __name__ == "__main__":
    unittest.main()
