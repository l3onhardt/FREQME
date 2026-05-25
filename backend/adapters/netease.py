import httpx

from backend.core.config import get_settings

settings = get_settings()
BASE = f"http://127.0.0.1:{settings.netease_bridge_port}"


class NeteaseAdapter:
    def __init__(self):
        self.client = httpx.AsyncClient(timeout=30.0, trust_env=False)

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
        return f"https://music.163.com/song/media/outer/url?id={song_id}.mp3"

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
