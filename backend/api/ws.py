import asyncio
import json
import re
import unicodedata

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
request_agent = None
radio_brain = None
dj_request_agent = None
search_verify_agent = None
queue_director = None
dj_memory_manager = None

def default_dj_intro(scene: str) -> str:
    greeting_map = {
        "清晨": "早上好",
        "午后": "下午好",
        "深夜": "晚上好",
        "日常": "你好",
    }
    greeting = greeting_map.get(scene, "你好")
    return f"{greeting}，电台已经打开了。先别急着说话，我们先让第一首歌把今天的气氛慢慢铺开。"
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
    intro_send_task = None
    background_tasks = set()
    send_lock = asyncio.Lock()

    async def send_json(payload: dict) -> None:
        async with send_lock:
            await websocket.send_json(payload)

    def start_background(coro):
        task = asyncio.create_task(coro)
        background_tasks.add(task)
        task.add_done_callback(background_tasks.discard)
        return task

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

    def current_theme_window() -> int:
        intent = scheduler_state.listening_intent if scheduler_state else {}
        try:
            return max(2, min(6, int((intent or {}).get("theme_window") or 4)))
        except Exception:
            return 4

    def structured_direction_from_decision(decision) -> str:
        if not isinstance(decision, dict):
            return ""
        policy = decision.get("queue_policy")
        if not isinstance(policy, dict) or not policy.get("continue_direction"):
            return ""
        task = decision.get("music_task")
        if not isinstance(task, dict):
            return ""
        task_type = str(task.get("type") or "").strip()
        if task_type not in {
            "artist_direction",
            "artist_work_direction",
            "scene_genre_direction",
            "continuation",
            "negative_feedback",
        }:
            return ""
        parts = []
        for entity in task.get("primary_entities") or []:
            if isinstance(entity, dict):
                name = str(entity.get("name") or "").strip()
                if name:
                    parts.append(name)
        style_hint = str(task.get("style_hint") or "").strip()
        if style_hint:
            parts.append(style_hint)
        work_hint = str(task.get("work_hint") or "").strip()
        if task_type == "artist_work_direction" and work_hint:
            parts.append(work_hint)
        cleaned = []
        for part in parts:
            for item in str(part).replace("，", " ").replace(",", " ").split():
                item = item.strip()
                if item and item not in cleaned:
                    cleaned.append(item)
        return " ".join(cleaned)[:120]

    def apply_structured_direction_from_result(result) -> None:
        if not scheduler or not scheduler_state:
            return
        decision = getattr(result, "decision", {}) if result else {}
        direction = structured_direction_from_decision(decision)
        if not direction:
            return
        try:
            scheduler.apply_listening_intent(
                scheduler_state,
                direction,
                user_settings=user_settings,
            )
            scheduler_state.intent_picks_remaining = max(
                scheduler_state.intent_picks_remaining,
                current_theme_window(),
            )
        except Exception:
            pass

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

    def looks_like_user_request_sentence(text: str) -> bool:
        lowered = str(text or "").casefold()
        phrase_markers = (
            "不能",
            "能不能",
            "可以",
            "想听",
            "我要",
            "我想",
            "来点",
            "放点",
            "播点",
            "给我",
            "换成",
            "换点",
            "别",
            "不要",
            "吗",
            "么",
            "would you",
            "could you",
            "can you",
            "please",
            "i want",
            "i'd like",
            "put on",
        )
        return any(marker in lowered for marker in phrase_markers) or bool(
            re.search(r"\bplay\b", lowered)
        )

    def text_contains_request_variant(text: str, request_text: str) -> bool:
        normalized_request = normalized_request_text(request_text)
        if not normalized_request:
            return False
        normalized_text = normalized_request_text(text)
        if normalized_text == normalized_request:
            return True
        return (
            looks_like_user_request_sentence(request_text)
            and normalized_request in normalized_text
        )

    def safe_director_status_text(text: str, request_text: str, fallback: str) -> str:
        safe_text = str(text or "").strip()
        old_failure_fragments = (
            "没找到特别准",
            "娌℃壘鍒扮壒鍒噯",
        )
        if (
            not safe_text
            or text_contains_request_variant(safe_text, request_text)
            or any(fragment in safe_text for fragment in old_failure_fragments)
        ):
            return fallback
        return safe_text

    def safe_ready_reason_text(text: str, request_text: str, fallback: str) -> str:
        safe_text = safe_director_status_text(text, request_text, fallback="")
        lowered = safe_text.casefold()
        internal_fragments = (
            "selected ",
            "selected the first playable candidate",
            "matching ",
            "search goal",
            "concrete track query",
            "low_confidence_judge_fallback",
            "verification",
            "artist_direction",
            "scene_genre_direction",
            "specific_track",
            "music_task",
            "query",
        )
        contains_cjk = bool(re.search(r"[\u4e00-\u9fff]", safe_text))
        if (
            not safe_text
            or not contains_cjk
            or any(fragment in lowered for fragment in internal_fragments)
        ):
            return fallback
        return safe_text

    def dj_agent_verified_ready_status(
        request_text: str,
        old_ready_items: list | None = None,
    ) -> dict | None:
        old_ready_items = old_ready_items or []
        for item in playback_queue.ready_items():
            # ready_items() returns the queue's live item objects; skip the
            # pre-request objects so stale verified items cannot satisfy a new request.
            if any(item is old_item for old_item in old_ready_items):
                continue
            selection_reason = (
                item.selection_reason
                if isinstance(item.selection_reason, dict)
                else {}
            )
            if selection_reason.get("type") != "dj_agent_verified":
                continue
            track = _track_info(item.song)
            fallback_text = f"下一首准备好了：{track['name']}。"
            reason_text = safe_ready_reason_text(
                str(selection_reason.get("text") or "").strip(),
                request_text,
                fallback_text,
            )
            return {
                "type": "request_status",
                "status": "ready",
                "text": reason_text,
                "next_track": track,
            }
        return None

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
        await send_json({
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
                    user_settings={
                        **user_settings,
                        "local_time_block": scene,
                    },
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
                        presentation_plan=prepared_song.get("presentation_plan"),
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
                await asyncio.wait_for(asyncio.shield(prewarm_task), timeout=1.5)
            except asyncio.TimeoutError:
                pass
            except asyncio.CancelledError:
                pass
            if prewarm_task.done():
                prewarm_task = None
        if not playback_queue.ready_items():
            await fill_queue(max_items=1, allow_program_break=False)
        item = playback_queue.promote_next(previous_event=previous_event)
        if not item:
            await send_json({
                "type": "error",
                "message": "暂无更多歌曲，请稍后再试",
            })
            return

        next_song = item.song
        segue = item.segue_text
        tts_hash_val = item.tts_hash

        if segue:
            await send_json({
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
                    await send_json({
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

                default_intro_text = default_dj_intro(scene)
                default_intro_task = asyncio.create_task(
                    synthesize_intro_text(default_intro_text)
                )
                intro_task = asyncio.create_task(prepare_intro())

                try:
                    session_id = await store.create_session(str(uid))
                except Exception:
                    session_id = 0

                await send_json({
                    "type": "session_start",
                    "profile": profile,
                    "scene": scene,
                    "intro_text": default_intro_text,
                    "tts_ready": False,
                    "tts_hash": "",
                })

                try:
                    default_tts_hash = await default_intro_task
                    await send_json({
                        "type": "intro",
                        "text": default_intro_text,
                        "tts_ready": bool(default_tts_hash),
                        "tts_hash": default_tts_hash,
                    })
                except Exception:
                    pass

                await fill_queue(max_items=1)
                item = playback_queue.promote_next()
                if item:
                    await send_track(item.song, item.url)

                async def send_llm_intro_when_ready():
                    try:
                        intro, tts_hash = await intro_task
                        if intro:
                            await send_json({
                                "type": "intro",
                                "text": intro,
                                "tts_ready": bool(tts_hash),
                                "tts_hash": tts_hash,
                            })
                    except Exception:
                        pass

                intro_send_task = start_background(send_llm_intro_when_ready())
                if prewarm_task and not prewarm_task.done():
                    prewarm_task.cancel()
                prewarm_task = asyncio.create_task(fill_queue(max_items=1))
                await asyncio.sleep(0)

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
                if intro_send_task and not intro_send_task.done():
                    intro_send_task.cancel()
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
                    old_ready_items = list(playback_queue.ready_items())
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

                    if result_status == "queued":
                        ready_status = dj_agent_verified_ready_status(
                            request_text,
                            old_ready_items=old_ready_items,
                        )
                        if not ready_status:
                            await send_json({
                                "type": "request_status",
                                "status": "not_found",
                                "text": "I could not safely verify a playable match.",
                            })
                            continue
                        if result_text:
                            dj_text = safe_director_status_text(
                                result_text,
                                request_text,
                                "Queued the verified track.",
                            )
                            tts_hash_val = await synthesize_intro_text(dj_text)
                            await send_json({
                                "type": "dj_message",
                                "text": dj_text,
                                "tts_ready": bool(tts_hash_val),
                                "tts_hash": tts_hash_val,
                            })
                        await send_json(ready_status)
                        apply_structured_direction_from_result(result)
                        await fill_queue(max_items=1, allow_program_break=False)
                        continue
                    if result_status == "ask":
                        ask_text = safe_director_status_text(
                            result_text,
                            request_text,
                            "I need to clarify the music direction first.",
                        )
                        await send_json({
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
                    await send_json({
                        "type": "request_status",
                        "status": "not_found",
                        "text": recovery_text,
                    })
                    continue

                await send_json({
                    "type": "request_status",
                    "status": "not_found",
                    "text": "I could not safely verify a playable match.",
                })
                continue

    except WebSocketDisconnect:
        if session_id and store:
            try:
                await store.end_session(session_id, 0, "", "用户断开")
            except Exception:
                pass
    finally:
        for task in list(background_tasks):
            if task.done():
                continue
            try:
                await asyncio.wait_for(asyncio.shield(task), timeout=0.2)
            except asyncio.CancelledError:
                pass
            except Exception:
                task.cancel()
        if prewarm_task and not prewarm_task.done():
            prewarm_task.cancel()


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
