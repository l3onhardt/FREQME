import json

from fastapi import WebSocket, WebSocketDisconnect

from backend.api import auth
from backend.engines.dj import should_generate_segue
from backend.engines.playback_queue import PlaybackQueue

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


async def ws_handler(websocket: WebSocket):
    await websocket.accept()
    uid = None
    scene = "日常"
    profile = {}
    user_settings = {}
    current_song = None
    current_song_id = None
    session_id = None
    track_index = 0
    logged_track_ids = set()
    scheduler_state = scheduler.new_session_state() if scheduler else None
    playback_queue = PlaybackQueue(prewarm_depth=3)

    def current_voice_preset() -> str:
        return user_settings.get("voice_preset", "silver_female")

    async def remember_current_song(song: dict):
        nonlocal current_song, current_song_id, track_index
        current_song = song
        current_song_id = str(song.get("id"))
        track_index += 1
        try:
            info = _track_info(song)
            if info["id"] not in logged_track_ids:
                await store.log_track(
                    info["id"],
                    info["name"],
                    info["artist"],
                    "scheduler",
                    uid=str(uid) if uid else None,
                )
                await store.log_playback_event(
                    "started",
                    song_id=info["id"],
                    uid=str(uid) if uid else None,
                )
                logged_track_ids.add(info["id"])
        except Exception:
            pass

    async def send_track(song: dict, url: str):
        await websocket.send_json({
            "type": "play_track",
            "track": _track_info(song),
            "url": url,
        })
        await remember_current_song(song)

    async def fill_queue(max_items: int | None = None):
        added_count = 0
        while playback_queue.prewarm_needed() > 0:
            if max_items is not None and added_count >= max_items:
                break
            try:
                song = await scheduler.pick_next(
                    current_song_id,
                    profile=profile,
                    user_settings=user_settings,
                    session_state=scheduler_state,
                    uid=str(uid) if uid else None,
                )
            except Exception:
                break
            if not song:
                break
            try:
                prepared = await _prepare_queue_item(
                    audio_resolver,
                    song,
                    str(uid) if uid else None,
                )
            except Exception:
                continue
            if not prepared:
                continue
            prepared_song, prepared_url = prepared
            playback_queue.add_ready(
                prepared_song,
                prepared_url,
                prepared_song.get("selection_reason", {}),
            )
            added_count += 1

    async def send_prepared_next(previous_event: str = "played"):
        nonlocal current_song, current_song_id
        await fill_queue()
        item = playback_queue.promote_next(previous_event=previous_event)
        if not item:
            await websocket.send_json({
                "type": "error",
                "message": "暂无更多歌曲，请稍后再试",
            })
            return

        next_song = item.song
        segue = None
        tts_hash_val = ""
        if previous_event == "skipped" or should_generate_segue(track_index):
            try:
                prev_info = current_song or {}
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
                segue = None
                tts_hash_val = ""

        if segue:
            await websocket.send_json({
                "type": "segue",
                "text": segue,
                "tts_ready": bool(tts_hash_val),
                "tts_hash": tts_hash_val,
                "next_track": _track_info(next_song),
                "url": item.url,
            })
            await remember_current_song(next_song)
            try:
                compressor.add_round({
                    "round": 0,
                    "type": "segue",
                    "speaker": "memo",
                    "text": segue,
                    "song": _track_info(next_song),
                    "timestamp": "",
                })
            except Exception:
                pass
        else:
            await send_track(next_song, item.url)

        await fill_queue()

    try:
        async for msg_text in websocket.iter_text():
            msg = json.loads(msg_text)
            msg_type = msg.get("type")

            if msg_type == "handshake":
                uid = msg.get("uid")
                if not await _uid_matches_active_login(uid):
                    await websocket.send_json({
                        "type": "error",
                        "message": "登录账号和当前电台用户不一致，请重新登录。",
                    })
                    return
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

                await fill_queue(max_items=1)
                item = playback_queue.promote_next()
                if item:
                    await send_track(item.song, item.url)
                    await fill_queue()

            elif msg_type == "track_ended":
                await send_prepared_next(previous_event="played")

            elif msg_type == "skip":
                playback_queue.mark_current("skipped")
                try:
                    if current_song_id:
                        await store.log_playback_event(
                            "skipped",
                            song_id=current_song_id,
                            uid=str(uid) if uid else None,
                        )
                except Exception:
                    pass
                await send_prepared_next(previous_event="skipped")

    except WebSocketDisconnect:
        if session_id and store:
            try:
                await store.end_session(session_id, 0, "", "用户断开")
            except Exception:
                pass


async def _prepare_queue_item(audio_resolver_obj, song: dict, uid: str | None):
    if not audio_resolver_obj:
        url = await scheduler.get_song_url(song)
        return song, url
    resolved = await audio_resolver_obj.resolve_with_candidates(song, uid=uid)
    if not resolved.ok:
        return None
    return song, resolved.proxy_url


def _track_info(song: dict) -> dict:
    return {
        "id": str(song.get("id")),
        "name": song.get("name", ""),
        "artist": _artist_name(song),
    }


def _artist_name(song: dict | None) -> str:
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
        elif isinstance(artists, dict):
            name = artists.get("name")
            if isinstance(name, str):
                return name.strip()
    return ""


async def _uid_matches_active_login(uid) -> bool:
    netease = getattr(auth, "netease", None)
    if not netease or not uid:
        return True
    try:
        status = await netease.login_status()
    except Exception:
        return False
    profile = auth._extract_profile(status) if isinstance(status, dict) else {}
    active_uid = profile.get("userId")
    return bool(active_uid) and str(active_uid) == str(uid)
