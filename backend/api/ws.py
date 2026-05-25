import asyncio
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

DEFAULT_DJ_INTRO = "晚上好，这里是今晚的私人电台。我先把第一首歌轻轻放进来，你不用急，跟着这一点光慢慢听。"
MAX_QUEUE_PREPARE_ATTEMPTS = 12


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
    played_songs = []
    logged_track_ids = set()
    scheduler_state = scheduler.new_session_state() if scheduler else None
    playback_queue = PlaybackQueue(prewarm_depth=3)
    prewarm_task = None

    def current_voice_preset() -> str:
        return user_settings.get("voice_preset", "silver_female")

    async def synthesize_intro_text(text: str) -> str:
        if not text:
            return ""
        try:
            tts_audio = await asyncio.wait_for(
                tts.synthesize(
                    text,
                    scene,
                    voice_preset=current_voice_preset(),
                    user_settings=user_settings,
                ),
                timeout=12.0,
            )
            return (
                tts._hash(
                    text,
                    scene,
                    voice_preset=current_voice_preset(),
                    user_settings=user_settings,
                )
                if tts_audio
                else ""
            )
        except Exception:
            return ""

    def should_prepare_break_for_next_song() -> bool:
        return (
            len(played_songs) >= 3
            and len(played_songs) % 3 == 0
            and not playback_queue.ready_items()
        )

    async def remember_current_song(song: dict):
        nonlocal current_song, current_song_id, track_index
        current_song = song
        current_song_id = str(song.get("id"))
        track_index += 1
        played_songs.append(song)
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
        nonlocal prewarm_task
        await websocket.send_json({
            "type": "play_track",
            "track": _track_info(song),
            "url": url,
        })
        await remember_current_song(song)
        if should_prepare_break_for_next_song():
            if prewarm_task and not prewarm_task.done():
                prewarm_task.cancel()
            prewarm_task = asyncio.create_task(fill_queue(max_items=1))
            await asyncio.sleep(0)

    async def prepare_intro():
        intro_text = ""
        tts_hash_val = ""
        try:
            intro_text = await asyncio.wait_for(
                dj_engine.generate_intro(
                    profile,
                    scene,
                    user_settings=user_settings,
                ),
                timeout=20.0,
            )
        except Exception:
            return "", ""
        if not intro_text:
            return "", ""
        tts_hash_val = await synthesize_intro_text(intro_text)
        return intro_text, tts_hash_val

    async def fill_queue(max_items: int | None = None, allow_program_break: bool = True):
        added_count = 0
        attempts = 0
        while playback_queue.prewarm_needed() > 0:
            if max_items is not None and added_count >= max_items:
                break
            if attempts >= MAX_QUEUE_PREPARE_ATTEMPTS:
                if await add_recent_playable_fallback():
                    added_count += 1
                break
            attempts += 1
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
            segue_text = ""
            tts_hash_val = ""
            if allow_program_break and should_generate_segue(
                track_index + len(playback_queue.ready_items()) + 1
            ):
                try:
                    segue_text = await dj_engine.generate_program_break(
                        profile,
                        scene,
                        played_songs,
                        prepared_song,
                        compressor,
                        user_settings=user_settings,
                    )
                except Exception:
                    segue_text = ""
                try:
                    if segue_text:
                        tts_audio = await tts.synthesize(
                            segue_text,
                            scene,
                            voice_preset=current_voice_preset(),
                            user_settings=user_settings,
                        )
                        tts_hash_val = (
                            tts._hash(
                                segue_text,
                                scene,
                                voice_preset=current_voice_preset(),
                                user_settings=user_settings,
                            )
                            if tts_audio
                            else ""
                        )
                except Exception:
                    tts_hash_val = ""
            playback_queue.add_ready(
                prepared_song,
                prepared_url,
                prepared_song.get("selection_reason", {}),
                segue_text=segue_text,
                tts_hash=tts_hash_val,
            )
            added_count += 1

    async def add_recent_playable_fallback() -> bool:
        try:
            recent_tracks = await store.get_recent_playable_tracks(
                uid=str(uid) if uid else None,
                limit=20,
            )
        except Exception:
            recent_tracks = []
        for recent_track in recent_tracks or []:
            recent_id = str((recent_track or {}).get("id") or "")
            if not recent_id or recent_id == current_song_id:
                continue
            if any(
                str(item.song.get("id")) == recent_id
                and item.status in {"playing", "ready", "prewarming"}
                for item in playback_queue.items
            ):
                continue
            prepared = await _prepare_queue_item(
                audio_resolver,
                _fallback_track_to_song(recent_track),
                str(uid) if uid else None,
            )
            if not prepared:
                continue
            prepared_song, prepared_url = prepared
            playback_queue.add_ready(
                prepared_song,
                prepared_url,
                {
                    "type": "recent_playable_fallback",
                    "text": "先接上一首刚刚确认可播的歌，让电台不断档。",
                },
            )
            return True
        return False

    async def send_prepared_next(previous_event: str = "played"):
        nonlocal current_song, current_song_id
        nonlocal prewarm_task
        if prewarm_task:
            try:
                await asyncio.wait_for(asyncio.shield(prewarm_task), timeout=0.05)
            except asyncio.TimeoutError:
                prewarm_task.cancel()
            except asyncio.CancelledError:
                pass
            prewarm_task = None
        if not playback_queue.ready_items():
            await fill_queue(max_items=1, allow_program_break=False)
        item = playback_queue.promote_next(previous_event=previous_event)
        if not item:
            await websocket.send_json({
                "type": "error",
                "message": "暂无更多歌曲，请稍后再试",
            })
            return

        next_song = item.song
        segue = item.segue_text
        tts_hash_val = item.tts_hash

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

        if not (prewarm_task and not prewarm_task.done()):
            await fill_queue(max_items=1)

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

                default_intro_task = asyncio.create_task(
                    synthesize_intro_text(DEFAULT_DJ_INTRO)
                )
                intro_task = asyncio.create_task(prepare_intro())

                try:
                    session_id = await store.create_session(str(uid))
                except Exception:
                    session_id = 0

                await websocket.send_json({
                    "type": "session_start",
                    "profile": profile,
                    "scene": scene,
                    "intro_text": DEFAULT_DJ_INTRO,
                    "tts_ready": False,
                    "tts_hash": "",
                })

                try:
                    default_tts_hash = await default_intro_task
                    await websocket.send_json({
                        "type": "intro",
                        "text": DEFAULT_DJ_INTRO,
                        "tts_ready": bool(default_tts_hash),
                        "tts_hash": default_tts_hash,
                    })
                except Exception:
                    pass

                await fill_queue(max_items=1)
                item = playback_queue.promote_next()
                if item:
                    await send_track(item.song, item.url)

                try:
                    intro, tts_hash = await intro_task
                    if intro:
                        await websocket.send_json({
                            "type": "intro",
                            "text": intro,
                            "tts_ready": bool(tts_hash),
                            "tts_hash": tts_hash,
                        })
                except Exception:
                    pass

                await fill_queue(max_items=1)

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
    prepared_song = dict(song)
    if resolved.song_id:
        prepared_song["id"] = resolved.song_id
    return prepared_song, resolved.proxy_url


def _track_info(song: dict) -> dict:
    return {
        "id": str(song.get("id")),
        "name": song.get("name", ""),
        "artist": _artist_name(song),
    }


def _fallback_track_to_song(track: dict) -> dict:
    artist = track.get("artist", "") if isinstance(track, dict) else ""
    return {
        "id": str(track.get("id", "")),
        "name": track.get("name", "") or track.get("song_name", ""),
        "artist": artist,
        "ar": [{"name": artist}] if artist else [],
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
