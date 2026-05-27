import asyncio
import json
import re
import unicodedata

from fastapi import WebSocket, WebSocketDisconnect

from backend.api import auth
from backend.engines.dj import should_generate_segue
from backend.engines.playback_queue import PlaybackQueue
from backend.engines.song_request_agent import SongRequestPick

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
request_agent = None
radio_brain = None
dj_request_agent = None
search_verify_agent = None
queue_director = None
dj_memory_manager = None

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

    def clear_ready_queue() -> None:
        playback_queue.items = [
            item for item in playback_queue.items
            if item.status != "ready"
        ]

    def should_prepare_break_for_next_song() -> bool:
        return (
            len(played_songs) >= 3
            and len(played_songs) % 3 == 0
            and not playback_queue.ready_items()
        )

    def dj_playback_context() -> dict:
        return {
            "current_track": _track_info(current_song) if current_song else {},
            "recent_tracks": [_track_info(song) for song in played_songs[-10:]],
            "ready_queue": [
                _track_info(item.song) for item in playback_queue.ready_items()
            ],
            "scene": scene,
        }

    def normalized_request_text(text: str) -> str:
        folded = str(text or "").casefold()
        return "".join(
            ch for ch in folded
            if not ch.isspace()
            and unicodedata.category(ch)[0] not in {"P", "Z"}
        )

    def text_contains_request_variant(text: str, request_text: str) -> bool:
        normalized_request = normalized_request_text(request_text)
        if not normalized_request:
            return False
        return normalized_request in normalized_request_text(text)

    def safe_director_status_text(text: str, request_text: str, fallback: str) -> str:
        safe_text = str(text or "").strip()
        if not safe_text or text_contains_request_variant(safe_text, request_text):
            return fallback
        return safe_text

    def request_status_for_ready_item(request_text: str) -> dict:
        ready = playback_queue.ready_items()
        brain_decision = {}
        if isinstance(user_settings, dict):
            brain_state = user_settings.get("radio_brain")
            if isinstance(brain_state, dict) and isinstance(brain_state.get("decision"), dict):
                brain_decision = brain_state["decision"]
        if not ready:
            if brain_decision.get("intent_type") in {
                "taste_direction",
                "artist_direction",
                "negative_feedback",
                "skip_variant",
                "profile_correction",
            }:
                return {
                    "type": "request_status",
                    "status": "queued",
                    "text": str(brain_decision.get("ack_text") or "").strip()
                    or f"收到，我会往“{request_text}”这个方向调整。",
                }
            return {
                "type": "request_status",
                "status": "fallback",
                "text": f"我还没找到特别准的“{request_text}”，先往这个情绪靠近一点。",
            }
        item = ready[0]
        reason_type = (
            item.selection_reason.get("type")
            if isinstance(item.selection_reason, dict)
            else ""
        )
        track = _track_info(item.song)
        if brain_decision.get("intent_type") in {
            "negative_feedback",
            "skip_variant",
            "profile_correction",
        }:
            ack_text = str(brain_decision.get("ack_text") or "").strip()
            return {
                "type": "request_status",
                "status": "queued",
                "text": ack_text or "懂了，这批先避开。我重新按你的听感找。",
            }
        if brain_decision.get("intent_type") in {"taste_direction", "artist_direction"}:
            ack_text = str(brain_decision.get("ack_text") or "").strip()
            return {
                "type": "request_status",
                "status": "ready",
                "text": (
                    f"{ack_text} 下一首先接：{track['name']}。"
                    if ack_text
                    else f"收到，我会往“{request_text}”这个方向调整。"
                ),
                "next_track": track,
            }
        if reason_type == "dj_agent_verified":
            reason_text = ""
            if isinstance(item.selection_reason, dict):
                reason_text = str(item.selection_reason.get("text") or "").strip()
            if reason_text and text_contains_request_variant(reason_text, request_text):
                reason_text = ""
            return {
                "type": "request_status",
                "status": "ready",
                "text": reason_text or f"Next track is ready: {track['name']}.",
                "next_track": track,
            }
        if reason_type == "request_intent":
            return {
                "type": "request_status",
                "status": "ready",
                "text": f"我先把下一首往这个方向靠：{track['name']}。如果你想现在切过去，点下一首就好。",
                "next_track": track,
            }
        if reason_type in {"radio_brain_profile", "radio_brain_search"}:
            ack_text = str(brain_decision.get("ack_text") or "").strip()
            if ack_text:
                text = f"{ack_text} 下一首先接：{track['name']}。"
            else:
                text = f"收到，我按你的听感换线。下一首先接：{track['name']}。"
            return {
                "type": "request_status",
                "status": "ready",
                "text": text,
                "next_track": track,
            }
        return {
            "type": "request_status",
            "status": "fallback",
            "text": f"没找到特别准的“{request_text}”，我先往这个情绪靠近一点。",
            "next_track": track,
        }

    async def queue_agent_pick(pick: SongRequestPick) -> bool:
        if not pick.found or not pick.song:
            return False
        try:
            prepared = await _prepare_queue_item(
                audio_resolver,
                pick.song,
                str(uid) if uid else None,
            )
        except Exception:
            prepared = None
        if not prepared:
            return False
        prepared_song, prepared_url = prepared
        playback_queue.add_ready(
            prepared_song,
            prepared_url,
            prepared_song.get("selection_reason", {}),
        )
        return True

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
                if not isinstance(user_settings, dict):
                    user_settings = {}
                for key in ("timezone_name", "locale", "region_hint"):
                    if msg.get(key):
                        user_settings[key] = msg.get(key)
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
                if radio_brain and current_song:
                    try:
                        profile = radio_brain.apply_learning_signal(
                            profile,
                            {
                                "event_type": "skipped",
                                "song": _track_info(current_song),
                            },
                        )
                        if uid:
                            await store.save_profile(str(uid), profile)
                    except Exception:
                        pass
                await send_prepared_next(previous_event="skipped")

            elif msg_type == "song_request":
                request_text = " ".join(str(msg.get("text") or "").split())[:120]
                if not request_text:
                    continue
                if prewarm_task and not prewarm_task.done():
                    prewarm_task.cancel()
                    try:
                        await prewarm_task
                    except asyncio.CancelledError:
                        pass
                    except Exception:
                        pass
                    prewarm_task = None
                try:
                    await store.log_playback_event(
                        "song_request",
                        song_id=current_song_id,
                        uid=str(uid) if uid else None,
                        reason=request_text,
                    )
                except Exception:
                    pass

                if queue_director:
                    try:
                        recent_turns = (
                            compressor.get_context()
                            if hasattr(compressor, "get_context")
                            else []
                        )
                    except Exception:
                        recent_turns = []
                    try:
                        result = await queue_director.handle_song_request(
                            request_text=request_text,
                            playback_queue=playback_queue,
                            uid=str(uid) if uid else None,
                            session_id=session_id,
                            profile=profile,
                            user_settings=user_settings,
                            playback_context=dj_playback_context(),
                            recent_turns=recent_turns,
                        )
                    except Exception:
                        result = None

                    result_status = getattr(result, "status", "") if result else ""
                    result_text = getattr(result, "dj_text", "") if result else ""
                    if result_text:
                        dj_text = safe_director_status_text(
                            result_text,
                            request_text,
                            "I could not safely verify a playable match.",
                        )
                        tts_hash_val = await synthesize_intro_text(dj_text)
                        await websocket.send_json({
                            "type": "dj_message",
                            "text": dj_text,
                            "tts_ready": bool(tts_hash_val),
                            "tts_hash": tts_hash_val,
                        })

                    if result_status == "queued":
                        await websocket.send_json(request_status_for_ready_item(request_text))
                        await fill_queue(max_items=1, allow_program_break=False)
                        continue
                    if result_status == "ask":
                        ask_text = safe_director_status_text(
                            result_text,
                            request_text,
                            "I need to clarify the music direction first.",
                        )
                        await websocket.send_json({
                            "type": "request_status",
                            "status": "needs_clarification",
                            "text": ask_text,
                        })
                        continue

                    recovery_text = safe_director_status_text(
                        result_text,
                        request_text,
                        "I could not safely verify a playable match.",
                    )
                    await websocket.send_json({
                        "type": "request_status",
                        "status": "not_found",
                        "text": recovery_text,
                    })
                    continue

                clear_ready_queue()
                brain_decision = None
                if radio_brain:
                    try:
                        brain_decision = radio_brain.interpret_user_text(
                            request_text,
                            profile=profile,
                            user_settings=user_settings,
                        )
                    except Exception:
                        brain_decision = None

                agent_pick = None
                if (
                    request_agent
                    and (
                        brain_decision is None
                        or getattr(brain_decision, "intent_type", "") == "specific_song"
                    )
                ):
                    thinking_text = _specific_request_thinking_text(
                        request_text,
                        brain_decision,
                    )
                    if thinking_text:
                        tts_hash_val = await synthesize_intro_text(thinking_text)
                        await websocket.send_json({
                            "type": "dj_message",
                            "text": thinking_text,
                            "tts_ready": bool(tts_hash_val),
                            "tts_hash": tts_hash_val,
                        })
                    try:
                        agent_pick = await asyncio.wait_for(
                            request_agent.resolve(
                                request_text,
                                profile=profile,
                                user_settings=user_settings,
                            ),
                            timeout=28.0,
                        )
                    except Exception:
                        agent_pick = None
                if agent_pick and await queue_agent_pick(agent_pick):
                    item = playback_queue.promote_next(previous_event="skipped")
                    if not item:
                        continue
                    next_song = item.song
                    intro_text = agent_pick.dj_intro or f"我先给你定这一版：{_track_info(next_song)['name']}。"
                    tts_hash_val = await synthesize_intro_text(intro_text)
                    await websocket.send_json({
                        "type": "segue",
                        "text": intro_text,
                        "tts_ready": bool(tts_hash_val),
                        "tts_hash": tts_hash_val,
                        "next_track": _track_info(next_song),
                        "url": item.url,
                    })
                    await remember_current_song(next_song)
                    try:
                        compressor.add_round({
                            "round": 0,
                            "type": "request_pick",
                            "speaker": "memo",
                            "text": intro_text,
                            "song": _track_info(next_song),
                            "timestamp": "",
                        })
                    except Exception:
                        pass
                    await fill_queue(max_items=1)
                    continue

                if brain_decision and getattr(brain_decision, "intent_type", "") in {
                    "negative_feedback",
                    "taste_direction",
                    "artist_direction",
                    "skip_variant",
                    "profile_correction",
                }:
                    user_settings["radio_brain"] = {
                        "decision": brain_decision.to_dict()
                        if hasattr(brain_decision, "to_dict")
                        else dict(brain_decision),
                    }
                    try:
                        scheduler.apply_listening_intent(
                            scheduler_state,
                            request_text,
                            user_settings=user_settings,
                        )
                    except Exception:
                        user_settings["listening_intent"] = {
                            "raw_text": request_text,
                            "keywords": request_text,
                            "mood": "",
                        }
                    if getattr(brain_decision, "intent_type", "") == "negative_feedback":
                        user_settings["listening_intent"] = {
                            "raw_text": request_text,
                            "keywords": "",
                            "mood": "",
                        }
                    if (
                        radio_brain
                        and getattr(brain_decision, "intent_type", "") in {
                            "negative_feedback",
                            "profile_correction",
                        }
                    ):
                        try:
                            profile = radio_brain.apply_learning_signal(
                                profile,
                                {
                                    "event_type": getattr(brain_decision, "intent_type", ""),
                                    "decision": brain_decision.to_dict()
                                    if hasattr(brain_decision, "to_dict")
                                    else dict(brain_decision),
                                    "song": _track_info(current_song) if current_song else {},
                                },
                            )
                            if uid:
                                await store.save_profile(str(uid), profile)
                        except Exception:
                            pass
                    ack_text = getattr(brain_decision, "ack_text", "") or f"好，我往“{request_text}”这个方向给你找。"
                    tts_hash_val = await synthesize_intro_text(ack_text)
                    await websocket.send_json({
                        "type": "dj_message",
                        "text": ack_text,
                        "tts_ready": bool(tts_hash_val),
                        "tts_hash": tts_hash_val,
                    })
                    await fill_queue(max_items=1, allow_program_break=False)
                    await websocket.send_json(request_status_for_ready_item(request_text))
                    continue

                if _looks_like_specific_song_request(request_text):
                    interpreted = (
                        getattr(agent_pick, "interpreted_request", "") if agent_pick else ""
                    )
                    miss_target = interpreted or request_text
                    await websocket.send_json({
                        "type": "request_status",
                        "status": "not_found",
                        "text": (
                            f"我刚才没接准“{miss_target}”这一版，先不乱放。"
                            "你换个说法，或者加上歌手、专辑、英文名，我再帮你找。"
                        ),
                    })
                    continue

                try:
                    scheduler.apply_listening_intent(
                        scheduler_state,
                        request_text,
                        user_settings=user_settings,
                    )
                except Exception:
                    user_settings["listening_intent"] = {
                        "raw_text": request_text,
                        "keywords": request_text,
                        "mood": "",
                    }
                ack_text = f"好，我往“{request_text}”这个方向给你找。"
                try:
                    ack_text = await asyncio.wait_for(
                        dj_engine.generate_request_ack(
                            profile,
                            scene,
                            request_text,
                            user_settings=user_settings,
                        ),
                        timeout=8.0,
                    )
                except Exception:
                    pass
                tts_hash_val = await synthesize_intro_text(ack_text)
                await websocket.send_json({
                    "type": "dj_message",
                    "text": ack_text,
                    "tts_ready": bool(tts_hash_val),
                    "tts_hash": tts_hash_val,
                })
                await fill_queue(max_items=1, allow_program_break=False)
                await websocket.send_json(request_status_for_ready_item(request_text))

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


def _looks_like_specific_song_request(text: str) -> bool:
    raw = " ".join(str(text or "").split())
    if not raw:
        return False

    lowered = raw.lower()
    target = raw
    for marker in ("我想听", "想听", "播放", "点一首"):
        if marker in target:
            target = target.rsplit(marker, 1)[-1]
    target = target.strip(" ，,。.!！?？")
    generic_direction = any(
        phrase in target
        for phrase in (
            "的歌",
            "的音乐",
            "的曲子",
            "的歌曲",
            "这类歌",
            "这种歌",
            "这类音乐",
            "这种音乐",
        )
    ) or target.endswith(("歌", "音乐", "曲子", "歌曲", "歌单"))
    explicit_song_command = any(
        marker in raw
        for marker in ("我想听", "想听", "播放", "点一首")
    )
    short_specific_title = (
        explicit_song_command
        and not generic_direction
        and 1 <= len(target) <= 12
        and any(ch.isalnum() for ch in target)
    )
    mood_tokens = (
        "emo",
        "不开心",
        "难过",
        "低落",
        "伤心",
        "开心",
        "兴奋",
        "放松",
        "放空",
        "安静",
        "睡前",
        "夜路",
        "开车",
        "工作",
        "学习",
        "古典",
        "摇滚",
        "爵士",
        "电子",
        "电音",
        "炸场",
        "蹦迪",
        "edm",
        "民谣",
    )
    if short_specific_title:
        return True
    if any(token in lowered or token in raw for token in mood_tokens):
        specific_after_mood = any(
            marker in raw
            for marker in ("我想听", "想听", "播放", "点一首")
        ) and any(
            marker in raw
            for marker in ("《", "》", "专辑", "版本", " by ")
        )
        if "的" in target and not generic_direction:
            specific_after_mood = True
        if not specific_after_mood:
            return False

    if any(marker in raw for marker in ("《", "》", "专辑", "版本")):
        return True
    if explicit_song_command:
        if generic_direction:
            return False
        if len(target) >= 3 and any(ch.isalnum() for ch in target):
            return True
    return bool(re.search(r"[A-Za-z].*\s+[-A-Za-z0-9'. ]{2,}", raw))


def _specific_request_thinking_text(request_text: str, brain_decision=None) -> str:
    intent_type = getattr(brain_decision, "intent_type", "")
    raw = " ".join(str(request_text or "").split())
    if not raw:
        return ""
    if "我说的是" in raw or "说的是" in raw:
        return "明白，我先按你纠正的作品或人名确认版本，不再按泛风格乱接。"
    if intent_type == "specific_song" or _looks_like_specific_song_request(raw):
        return "我先按具体歌名、作品或人名确认一下版本，再接播放源。"
    return ""


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
