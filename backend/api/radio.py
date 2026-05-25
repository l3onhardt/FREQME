from pathlib import Path

import httpx
from fastapi import APIRouter, Header
from fastapi.responses import JSONResponse
from fastapi.responses import FileResponse
from fastapi.responses import StreamingResponse

from backend.core.config import get_settings
from backend.api import auth

router = APIRouter(prefix="/api/radio", tags=["radio"])

netease = None
llm = None
tts = None
profile_engine = None
dj_engine = None
scheduler = None
store = None
bus = None
compressor = None
audio_resolver = None


@router.post("/start")
async def start_radio(uid: int):
    try:
        profile = await store.get_profile(str(uid))
    except Exception:
        profile = None

    if not profile:
        try:
            profile = await profile_engine.analyze(uid)
        except Exception:
            profile = {
                "personality": {"traits": []},
                "dj_style_suggestion": "温暖自然",
            }

    scene = dj_engine.detect_scene(480)
    try:
        intro = await dj_engine.generate_intro(profile, scene)
    except Exception:
        intro = "嗨，晚上好。电台已经打开，今天想和你分享一些我找到的音乐。"

    return {"profile": profile, "scene": scene, "intro": intro}


@router.get("/profile/{uid}")
async def get_profile(uid: int):
    return await store.get_profile(str(uid)) or {}


@router.get("/onboarding/{uid}")
async def get_onboarding(uid: int):
    if not await _uid_matches_active_login(uid):
        return JSONResponse({"error": "forbidden"}, status_code=403)

    profile = await store.get_profile(str(uid)) or {}
    settings = await store.get_user_settings(str(uid))
    return {
        "profile_ready": bool(profile),
        "profile": profile,
        "settings": settings,
        "onboarded": bool(settings),
    }


@router.post("/onboarding/{uid}")
async def save_onboarding(uid: int, payload: dict):
    if not await _uid_matches_active_login(uid):
        return JSONResponse({"error": "forbidden"}, status_code=403)

    if not isinstance(payload, dict):
        payload = {}

    allowed_presets = {"silver_female", "warm_male"}
    voice_preset = payload.get("voice_preset") or "silver_female"
    if voice_preset not in allowed_presets:
        voice_preset = "silver_female"

    allowed_modes = {"陪伴", "专注", "放松", "深夜情绪"}
    current_mode = payload.get("current_mode") or "陪伴"
    if current_mode not in allowed_modes:
        current_mode = "陪伴"

    settings_payload = {
        "voice_preset": voice_preset,
        "display_name": (payload.get("display_name") or "").strip()[:40],
        "music_notes": (payload.get("music_notes") or "").strip()[:500],
        "current_mode": current_mode,
    }
    await store.save_user_settings(str(uid), settings_payload)
    return {"settings": settings_payload, "onboarded": True}


@router.get("/tts/{hash}")
async def get_tts(hash: str):
    if not _is_safe_tts_hash(hash):
        return {"error": "not found"}, 404

    cache_dir = Path(get_settings().data_dir) / "tts_cache"
    path = cache_dir / f"{hash}.wav"
    if path.exists() and path.is_file():
        return FileResponse(path, media_type="audio/wav")
    return {"error": "not found"}, 404


def _is_safe_tts_hash(value: str) -> bool:
    return (
        bool(value)
        and len(value) == 32
        and all(char in "0123456789abcdefABCDEF" for char in value)
    )


async def _uid_matches_active_login(uid: int) -> bool:
    netease = getattr(auth, "netease", None)
    if not netease:
        return True
    try:
        status = await netease.login_status()
    except Exception:
        return False
    profile = auth._extract_profile(status) if isinstance(status, dict) else {}
    active_uid = profile.get("userId")
    return bool(active_uid) and str(active_uid) == str(uid)


@router.get("/track/url")
async def get_track_url(id: str):
    url = await netease.song_url(id)
    return {"url": url}


@router.get("/audio/{song_id}")
async def get_audio_proxy(
    song_id: str,
    range_header: str | None = Header(default=None, alias="Range"),
):
    if not audio_resolver:
        return JSONResponse({"error": "audio resolver unavailable"}, status_code=503)

    resolved = await audio_resolver.resolve_with_candidates({"id": song_id})
    if not resolved.ok or not resolved.url:
        return JSONResponse({"error": resolved.reason or "audio unavailable"}, status_code=404)

    client = httpx.AsyncClient(timeout=30.0, follow_redirects=True, trust_env=False)
    try:
        headers = {}
        if range_header:
            headers["range"] = range_header
        request = client.build_request("GET", resolved.url, headers=headers)
        upstream = await client.send(request, stream=True)
        if upstream.status_code >= 400:
            await client.aclose()
            return JSONResponse(
                {"error": f"upstream {upstream.status_code}"},
                status_code=502,
            )
        media_type = (
            upstream.headers.get("content-type")
            or resolved.content_type
            or "audio/mpeg"
        )

        async def body():
            try:
                async for chunk in upstream.aiter_bytes():
                    yield chunk
            finally:
                await upstream.aclose()
                await client.aclose()

        response_headers = {"Cache-Control": "public, max-age=3600"}
        for header_name in ("accept-ranges", "content-range", "content-length"):
            header_value = upstream.headers.get(header_name)
            if header_value:
                response_headers[header_name.title()] = header_value

        return StreamingResponse(
            body(),
            status_code=upstream.status_code,
            media_type=media_type,
            headers=response_headers,
        )
    except Exception as error:
        await client.aclose()
        return JSONResponse({"error": str(error)}, status_code=502)
