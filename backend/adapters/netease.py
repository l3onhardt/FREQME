import httpx

from backend.core.config import get_settings

settings = get_settings()
BASE = f"http://127.0.0.1:{settings.netease_bridge_port}"


class NeteaseAdapter:
    def __init__(self, client=None):
        self.client = client or httpx.AsyncClient(timeout=30.0, trust_env=False)

    async def qr_key(self) -> dict:
        try:
            r = await self.client.get(f"{BASE}/login/qr/key", timeout=8.0)
            return r.json()
        except Exception:
            return {"code": -1, "message": "网抑云桥接未就绪"}

    async def qr_create(self, key: str) -> dict:
        try:
            r = await self.client.get(f"{BASE}/login/qr/create", params={"key": key}, timeout=8.0)
            return r.json()
        except Exception:
            return {"code": -1, "message": "网抑云桥接未就绪"}

    async def qr_check(self, key: str) -> dict:
        try:
            r = await self.client.get(f"{BASE}/login/qr/check", params={"key": key}, timeout=8.0)
            return r.json()
        except Exception:
            return {"code": -1, "message": "网抑云桥接未就绪"}

    async def user_playlist(self, uid: int) -> list[dict]:
        try:
            r = await self.client.get(f"{BASE}/user/playlist", params={"uid": uid}, timeout=10.0)
            data = r.json()
            return data.get("playlist", []) if isinstance(data, dict) else data
        except Exception:
            return []

    async def playlist_detail(self, playlist_id: int | str) -> dict:
        try:
            r = await self.client.get(
                f"{BASE}/playlist/detail", params={"id": playlist_id}, timeout=10.0
            )
            return r.json()
        except Exception:
            return {}

    async def user_record(self, uid: int) -> dict:
        try:
            r = await self.client.get(f"{BASE}/user/record", params={"uid": uid}, timeout=10.0)
            return r.json()
        except Exception:
            return {}

    async def recommend_songs(self) -> list[dict]:
        try:
            r = await self.client.get(f"{BASE}/recommend/songs", timeout=10.0)
            return r.json().get("data", {}).get("dailySongs", [])
        except Exception:
            return []

    async def personal_fm(self) -> list[dict]:
        try:
            r = await self.client.get(f"{BASE}/personal_fm", timeout=10.0)
            return r.json().get("data", [])
        except Exception:
            return []

    async def simi_song(self, song_id: str) -> list[dict]:
        try:
            r = await self.client.get(f"{BASE}/simi/song", params={"id": song_id}, timeout=10.0)
            return r.json().get("songs", [])
        except Exception:
            return []

    async def song_url(self, song_id: str) -> str:
        try:
            r = await self.client.get(f"{BASE}/song/url", params={"id": song_id}, timeout=8.0)
            data = r.json().get("data", [])
            if data and data[0].get("url"):
                return data[0]["url"]
        except Exception:
            pass
        return ""

    async def search(self, keywords: str, limit: int = 5) -> list[dict]:
        songs = await self._search_endpoint("cloudsearch", keywords, limit)
        if songs:
            return songs
        return await self._search_endpoint("search", keywords, limit)

    async def _search_endpoint(self, endpoint: str, keywords: str, limit: int) -> list[dict]:
        try:
            r = await self.client.get(
                f"{BASE}/{endpoint}",
                params={"keywords": keywords, "limit": limit},
                timeout=10.0,
            )
            data = r.json()
            result = data.get("result", {}) if isinstance(data, dict) else {}
            songs = result.get("songs", []) if isinstance(result, dict) else []
            return [self._normalize_search_song(song) for song in songs if isinstance(song, dict)]
        except Exception:
            return []

    def _normalize_search_song(self, song: dict) -> dict:
        normalized = dict(song)
        if "ar" not in normalized and isinstance(normalized.get("artists"), list):
            normalized["ar"] = normalized.get("artists")
        if "al" not in normalized and isinstance(normalized.get("album"), dict):
            normalized["al"] = normalized.get("album")
        return normalized

    async def like_list(self, uid: int) -> list[int]:
        try:
            r = await self.client.get(f"{BASE}/like/list", params={"uid": uid}, timeout=10.0)
            return r.json().get("ids", [])
        except Exception:
            return []

    async def login_status(self) -> dict:
        try:
            r = await self.client.get(f"{BASE}/login/status", timeout=8.0)
            return r.json()
        except Exception:
            return {"data": {"code": 200, "account": None, "profile": None}}

    async def login_refresh(self) -> dict:
        try:
            r = await self.client.get(f"{BASE}/login/refresh", timeout=8.0)
            return r.json()
        except Exception:
            return {"code": -1, "message": "网易云登录刷新失败"}

    async def close(self):
        await self.client.aclose()
