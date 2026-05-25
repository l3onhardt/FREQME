from dataclasses import dataclass


@dataclass
class AudioResolution:
    ok: bool
    song_id: str
    url: str = ""
    source: str = ""
    content_type: str = ""
    reason: str = ""

    @property
    def proxy_url(self) -> str:
        return f"/api/radio/audio/{self.song_id}" if self.ok and self.song_id else ""


class AudioResolver:
    def __init__(self, netease, store):
        self.netease = netease
        self.store = store

    async def resolve(self, song: dict, uid: str | None = None) -> AudioResolution:
        song_id = self._song_id(song)
        if not song_id:
            return AudioResolution(False, "", reason="missing_song_id")

        cached = await self.store.get_audio_resolution(song_id)
        if cached and cached.get("url"):
            return AudioResolution(
                True,
                song_id,
                cached["url"],
                cached.get("source", "cache"),
                cached.get("content_type", ""),
            )

        direct = await self._try_song_url(song_id, "song_url")
        if direct.ok:
            await self._cache(direct)
            return direct

        return AudioResolution(False, song_id, source="song_url", reason=direct.reason or "empty_url")

    async def resolve_with_candidates(
        self,
        song: dict,
        uid: str | None = None,
    ) -> AudioResolution:
        first = await self.resolve(song, uid=uid)
        if first.ok:
            return first

        query = self._query(song)
        if query:
            for candidate in await self.netease.search(query, limit=5):
                candidate_id = self._song_id(candidate)
                if not candidate_id or candidate_id == self._song_id(song):
                    continue
                candidate_resolution = await self._try_song_url(candidate_id, "search_candidate")
                if candidate_resolution.ok:
                    await self._cache(candidate_resolution)
                    return candidate_resolution

        await self.store.log_playback_event(
            "url_failed",
            song_id=self._song_id(song),
            uid=uid,
            reason=first.reason or "empty_url",
        )
        return first

    async def _try_song_url(self, song_id: str, source: str) -> AudioResolution:
        try:
            url = await self.netease.song_url(song_id)
        except Exception:
            return AudioResolution(False, song_id, source=source, reason="timeout")
        if not url:
            return AudioResolution(False, song_id, source=source, reason="empty_url")
        return AudioResolution(True, song_id, url, source, "audio/mpeg")

    async def _cache(self, resolved: AudioResolution) -> None:
        await self.store.save_audio_resolution(
            resolved.song_id,
            resolved.url,
            resolved.source,
            resolved.content_type,
        )

    def _song_id(self, song: dict | None) -> str:
        if not isinstance(song, dict):
            return ""
        value = song.get("id")
        return str(value).strip() if value is not None else ""

    def _artist_name(self, song: dict | None) -> str:
        if not isinstance(song, dict):
            return ""
        artist = song.get("artist")
        if isinstance(artist, str) and artist.strip():
            return artist.strip()
        for key in ("ar", "artists"):
            artists = song.get(key)
            if isinstance(artists, list) and artists:
                first = artists[0]
                if isinstance(first, dict):
                    name = first.get("name")
                    if isinstance(name, str):
                        return name.strip()
        return ""

    def _query(self, song: dict | None) -> str:
        if not isinstance(song, dict):
            return ""
        name = str(song.get("name") or "").strip()
        artist = self._artist_name(song)
        return f"{artist} {name}".strip()
