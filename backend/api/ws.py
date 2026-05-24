import json

from fastapi import WebSocket, WebSocketDisconnect

netease = None
llm = None
tts = None
profile_engine = None
dj_engine = None
scheduler = None
store = None
bus = None
compressor = None


async def ws_handler(websocket: WebSocket):
    await websocket.accept()
    uid = None
    scene = "日常"
    profile = {}
    user_settings = {}
    current_song = None
    current_song_id = None
    session_id = None
    logged_track_ids = set()

    def current_voice_preset() -> str:
        return user_settings.get("voice_preset", "warm_female")

    async def send_track(song: dict, url: str):
        nonlocal current_song, current_song_id
        await websocket.send_json({
            "type": "play_track",
            "track": _track_info(song),
            "url": url,
        })
        await remember_current_song(song)

    async def remember_current_song(song: dict):
        nonlocal current_song, current_song_id
        current_song = song
        current_song_id = str(song.get("id"))
        try:
            info = _track_info(song)
            if info["id"] not in logged_track_ids:
                await store.log_track(info["id"], info["name"], info["artist"], "scheduler")
                logged_track_ids.add(info["id"])
        except Exception:
            pass

    async def play_next_with_segue(prev_song_id: str | None = None):
        """Pick next song, generate segue, send to frontend."""
        nonlocal current_song, current_song_id

        next_song = await scheduler.pick_next(
            prev_song_id,
            profile=profile,
            user_settings=user_settings,
        )
        if not next_song:
            await websocket.send_json({
                "type": "error",
                "message": "暂无更多歌曲，请稍后再试",
            })
            return

        # Try to generate segue, but don't block music if it fails
        segue = None
        tts_hash_val = ""
        try:
            prev_info = current_song or ({"id": prev_song_id} if prev_song_id else {})
            segue = await dj_engine.generate_segue(
                profile,
                scene,
                prev_info,
                next_song,
                compressor,
                user_settings=user_settings,
            )
            tts_audio = await tts.synthesize(
                segue,
                scene,
                voice_preset=current_voice_preset(),
                user_settings=user_settings,
            )
            tts_hash_val = (
                tts._hash(
                    segue,
                    scene,
                    voice_preset=current_voice_preset(),
                    user_settings=user_settings,
                )
                if tts_audio
                else ""
            )
        except Exception:
            pass

        url = await scheduler.get_song_url(next_song)

        if segue:
            await websocket.send_json({
                "type": "segue",
                "text": segue,
                "tts_ready": bool(tts_hash_val),
                "tts_hash": tts_hash_val,
                "next_track": _track_info(next_song),
                "url": url,
            })
            await remember_current_song(next_song)
        else:
            # No segue generated, play directly
            await send_track(next_song, url)

        # Log to memory
        if segue:
            compressor.add_round({
                "round": 0,
                "type": "segue",
                "speaker": "memo",
                "text": segue,
                "song": _track_info(next_song),
                "timestamp": "",
            })

    try:
        async for msg_text in websocket.iter_text():
            msg = json.loads(msg_text)
            msg_type = msg.get("type")

            if msg_type == "handshake":
                uid = msg.get("uid")
                settings_payload = msg.get("settings") or {}
                stored_settings = await store.get_user_settings(str(uid)) if uid else None
                user_settings = stored_settings or settings_payload or {}
                scene = dj_engine.detect_scene(msg.get("utc_offset", 480))
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

                intro = await dj_engine.generate_intro(
                    profile,
                    scene,
                    user_settings=user_settings,
                )
                tts_audio = await tts.synthesize(
                    intro,
                    scene,
                    voice_preset=current_voice_preset(),
                    user_settings=user_settings,
                )
                tts_hash = (
                    tts._hash(
                        intro,
                        scene,
                        voice_preset=current_voice_preset(),
                        user_settings=user_settings,
                    )
                    if tts_audio
                    else ""
                )

                try:
                    session_id = await store.create_session(str(uid))
                except Exception:
                    session_id = 0

                await websocket.send_json({
                    "type": "session_start",
                    "profile": profile,
                    "scene": scene,
                    "intro_text": intro,
                    "tts_ready": bool(tts_audio),
                    "tts_hash": tts_hash,
                })

                # Pick first track
                song = await scheduler.pick_next(
                    profile=profile,
                    user_settings=user_settings,
                )
                if song:
                    url = await scheduler.get_song_url(song)
                    await send_track(song, url)

            elif msg_type == "track_ended":
                await play_next_with_segue(current_song_id)

            elif msg_type == "skip":
                await play_next_with_segue(current_song_id)

    except WebSocketDisconnect:
        if session_id and store:
            try:
                await store.end_session(session_id, 0, "", "用户断开")
            except Exception:
                pass


def _track_info(song: dict) -> dict:
    return {
        "id": str(song.get("id")),
        "name": song.get("name", ""),
        "artist": (
            song.get("ar", [{}])[0].get("name", "")
            if song.get("ar")
            else ""
        ),
    }
