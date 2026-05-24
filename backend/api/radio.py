from pathlib import Path

from fastapi import APIRouter
from fastapi.responses import FileResponse

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


@router.get("/tts/{hash}")
async def get_tts(hash: str):
    path = f"data/tts_cache/{hash}.wav"
    if Path(path).exists():
        return FileResponse(path, media_type="audio/wav")
    return {"error": "not found"}, 404


@router.get("/track/url")
async def get_track_url(id: str):
    url = await netease.song_url(id)
    return {"url": url}
