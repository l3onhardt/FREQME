import json
import unittest

from backend.engines.dj_request_agent import DJDecision
from backend.engines.playback_queue import PlaybackQueue
from backend.engines.queue_director import QueueDirector
from backend.engines.search_verify_agent import SearchVerification


class WeirdObject:
    def __str__(self):
        return "weird nested object"


class FakeMemoryManager:
    def __init__(self):
        self.build_calls = []
        self.update_calls = []

    async def build_context_pack(
        self,
        uid,
        session_id,
        user_message,
        profile=None,
        user_settings=None,
        playback_context=None,
        recent_turns=None,
    ):
        self.build_calls.append(
            {
                "uid": uid,
                "session_id": session_id,
                "user_message": user_message,
                "profile": profile,
                "user_settings": user_settings,
                "playback_context": playback_context,
                "recent_turns": recent_turns,
            }
        )
        return {"bounded": True, "playback_context": playback_context or {}}

    async def apply_decision_update(self, uid, session_id, request_text, decision):
        self.update_calls.append(
            {
                "uid": uid,
                "session_id": session_id,
                "request_text": request_text,
                "decision": decision,
            }
        )
        return {"updated": True}


class BuildFailingMemoryManager(FakeMemoryManager):
    async def build_context_pack(self, *args, **kwargs):
        self.build_calls.append({"failed": True, "args": args, "kwargs": kwargs})
        raise RuntimeError("context store unavailable")


class UpdateFailingMemoryManager(FakeMemoryManager):
    async def apply_decision_update(self, uid, session_id, request_text, decision):
        self.update_calls.append(
            {
                "uid": uid,
                "session_id": session_id,
                "request_text": request_text,
                "decision": decision,
            }
        )
        raise RuntimeError("memory update unavailable")


class FakeDJAgent:
    def __init__(self, decision):
        self.decision = decision
        self.calls = []

    async def decide(self, request_text, context_pack):
        self.calls.append({"request_text": request_text, "context_pack": context_pack})
        return self.decision


class RaisingDJAgent:
    def __init__(self):
        self.calls = []

    async def decide(self, request_text, context_pack):
        self.calls.append({"request_text": request_text, "context_pack": context_pack})
        raise RuntimeError(f"dj failed while handling {request_text}")


class FakeVerifier:
    def __init__(self, result):
        self.result = result
        self.calls = []

    async def verify(self, music_task, uid=None, raw_user_text=""):
        self.calls.append({"music_task": music_task, "uid": uid, "raw_user_text": raw_user_text})
        return self.result


class RaisingVerifier:
    def __init__(self, message="verifier unavailable"):
        self.calls = []
        self.message = message

    async def verify(self, music_task, uid=None, raw_user_text=""):
        self.calls.append({"music_task": music_task, "uid": uid, "raw_user_text": raw_user_text})
        raise RuntimeError(self.message)


def playable_decision(action="set_direction_and_play", speak_now="Queued."):
    return DJDecision(
        action=action,
        understood_intent="User wants Radiohead songs.",
        music_task={
            "type": "artist_direction",
            "primary_entities": [{"role": "artist", "name": "Radiohead"}],
            "search_goals": ["Radiohead Weird Fishes"],
        },
        queue_policy={"duration_tracks": 2, "continue_direction": True},
        dj_response={"speak_now": speak_now},
        memory_update={"session_preference": ["Radiohead direction"]},
        raw_text="original raw",
    )


class QueueDirectorTests(unittest.IsolatedAsyncioTestCase):
    async def test_request_clears_stale_ready_items_and_queues_verified_song(self):
        queue = PlaybackQueue()
        queue.add_ready({"id": "playing", "name": "Now"}, "/audio/current")
        queue.promote_next()
        queue.add_ready({"id": "stale", "name": "Stale"}, "/audio/stale")
        decision = playable_decision()
        verifier = FakeVerifier(
            SearchVerification(
                status="verified",
                selected_song={"id": "verified", "name": "Weird Fishes", "artist": "Radiohead"},
                url="/audio/verified",
                verification={"version_note": "official studio version"},
            )
        )
        director = QueueDirector(FakeDJAgent(decision), verifier, FakeMemoryManager())

        result = await director.handle_song_request(
            "change it to Radiohead",
            playback_queue=queue,
            uid="uid-1",
            session_id=7,
            profile={},
            user_settings={},
            playback_context={},
        )

        self.assertEqual(result.status, "queued")
        self.assertEqual(result.next_song["id"], "verified")
        self.assertEqual(verifier.calls[0]["music_task"], decision.music_task)
        self.assertEqual(verifier.calls[0]["raw_user_text"], "change it to Radiohead")
        self.assertEqual(queue.items[0].song["id"], "playing")
        self.assertEqual(queue.items[0].status, "playing")
        ready = queue.ready_items()
        self.assertEqual([item.song["id"] for item in ready], ["verified"])
        self.assertEqual(ready[0].selection_reason["type"], "dj_agent_verified")
        self.assertEqual(ready[0].selection_reason["understood_intent"], "User wants Radiohead songs.")
        self.assertEqual(ready[0].selection_reason["verification_note"], "official studio version")
        self.assertEqual(ready[0].selection_reason["text"], "official studio version")

    async def test_queued_dj_text_does_not_echo_raw_request(self):
        raw_sentence = "raw queued request"
        queue = PlaybackQueue()
        decision = playable_decision(action="play_now", speak_now=raw_sentence)
        verifier = FakeVerifier(
            SearchVerification(
                status="verified",
                selected_song={"id": "verified", "name": "Weird Fishes"},
                url="/audio/verified",
            )
        )
        director = QueueDirector(FakeDJAgent(decision), verifier, FakeMemoryManager())

        result = await director.handle_song_request(
            raw_sentence,
            playback_queue=queue,
            uid="uid-1",
            session_id=7,
            profile={},
            user_settings={},
            playback_context={},
        )

        self.assertEqual(result.status, "queued")
        self.assertNotIn(raw_sentence, result.dj_text)

    async def test_queued_selection_reason_does_not_echo_raw_request(self):
        raw_sentence = "raw selection reason"
        queue = PlaybackQueue()
        decision = playable_decision(action="play_now")
        decision.understood_intent = raw_sentence
        verifier = FakeVerifier(
            SearchVerification(
                status="verified",
                selected_song={"id": "verified", "name": "Weird Fishes"},
                url="/audio/verified",
                verification={"version_note": ""},
            )
        )
        director = QueueDirector(FakeDJAgent(decision), verifier, FakeMemoryManager())

        result = await director.handle_song_request(
            raw_sentence,
            playback_queue=queue,
            uid="uid-1",
            session_id=7,
            profile={},
            user_settings={},
            playback_context={},
        )

        reason = queue.ready_items()[0].selection_reason
        self.assertEqual(result.status, "queued")
        self.assertEqual(reason["type"], "dj_agent_verified")
        self.assertNotIn(raw_sentence, reason["understood_intent"])
        self.assertNotIn(raw_sentence, reason["verification_note"])
        self.assertNotIn(raw_sentence, reason["text"])

    async def test_ask_clarifying_question_updates_memory_but_does_not_clear_or_verify(self):
        queue = PlaybackQueue()
        queue.add_ready({"id": "stale", "name": "Stale"}, "/audio/stale")
        decision = DJDecision(
            action="ask_clarifying_question",
            understood_intent="The request is unclear.",
            dj_response={"speak_now": "Which kind do you mean?"},
        )
        verifier = FakeVerifier(SearchVerification(status="verified", selected_song={}, url=""))
        memory = FakeMemoryManager()
        director = QueueDirector(FakeDJAgent(decision), verifier, memory)

        result = await director.handle_song_request(
            "that one",
            playback_queue=queue,
            uid="uid-1",
            session_id=7,
            profile={},
            user_settings={},
            playback_context={},
        )

        self.assertEqual(result.status, "ask")
        self.assertEqual(result.dj_text, "Which kind do you mean?")
        self.assertEqual(memory.update_calls[0]["request_text"], "that one")
        self.assertEqual(verifier.calls, [])
        self.assertEqual([item.song["id"] for item in queue.ready_items()], ["stale"])

    async def test_ask_dj_text_does_not_echo_raw_request(self):
        raw_sentence = "raw ask request"
        decision = DJDecision(
            action="ask_clarifying_question",
            understood_intent="The request is unclear.",
            dj_response={"speak_now": raw_sentence},
        )
        director = QueueDirector(
            FakeDJAgent(decision),
            FakeVerifier(SearchVerification(status="verified", selected_song={}, url="")),
            FakeMemoryManager(),
        )

        result = await director.handle_song_request(
            raw_sentence,
            playback_queue=PlaybackQueue(),
            uid="uid-1",
            session_id=7,
            profile={},
            user_settings={},
            playback_context={},
        )

        self.assertEqual(result.status, "ask")
        self.assertNotIn(raw_sentence, result.dj_text)

    async def test_search_failure_returns_recovery_without_quoting_raw_sentence(self):
        queue = PlaybackQueue()
        queue.add_ready({"id": "stale", "name": "Stale"}, "/audio/stale")
        raw_sentence = "play the extremely obscure song I just described"
        decision = playable_decision(action="play_now", speak_now=raw_sentence)
        verifier = FakeVerifier(
            SearchVerification(
                status="not_found",
                failure_reason="No candidate passed verification.",
                recovery_options=[
                    {"type": "adjacent_version", "task": "Radiohead live", "reason": "Try an adjacent version."},
                    {"type": "artist_direction", "task": "Radiohead deep cuts", "reason": "Stay in the direction."},
                    {"type": "too_many", "task": "extra", "reason": "extra"},
                    {"type": "too_many_again", "task": "extra2", "reason": "extra2"},
                ],
            )
        )
        director = QueueDirector(FakeDJAgent(decision), verifier, FakeMemoryManager())

        result = await director.handle_song_request(
            raw_sentence,
            playback_queue=queue,
            uid="uid-1",
            session_id=7,
            profile={},
            user_settings={},
            playback_context={},
        )

        self.assertEqual(result.status, "needs_recovery")
        self.assertNotIn(raw_sentence, result.dj_text)
        self.assertNotIn(raw_sentence, str(result.decision))
        self.assertNotIn("raw_text", result.decision)
        self.assertEqual(queue.ready_items(), [])
        self.assertEqual(len(result.recovery_options), 3)
        self.assertEqual(result.recovery_options[0]["task"], "Radiohead live")

    async def test_search_failure_recovery_copy_is_user_facing_chinese_not_internal_english(self):
        decision = playable_decision(action="play_now")
        decision.understood_intent = "User wants music around Radiohead."
        verifier = FakeVerifier(SearchVerification(status="not_found"))
        director = QueueDirector(FakeDJAgent(decision), verifier, FakeMemoryManager())

        result = await director.handle_song_request(
            "来点radiohead",
            playback_queue=PlaybackQueue(),
            uid="uid-1",
            session_id=7,
            profile={},
            user_settings={},
            playback_context={},
        )

        self.assertEqual(result.status, "needs_recovery")
        self.assertIn("没能确认到", result.dj_text)
        self.assertNotIn("I tried", result.dj_text)
        self.assertNotIn("User wants", result.dj_text)
        self.assertNotIn("Radiohead", result.dj_text)

    async def test_recovery_text_does_not_use_understood_intent_when_it_contains_raw_sentence(self):
        queue = PlaybackQueue()
        raw_sentence = "literal unsafe user sentence"
        decision = playable_decision(action="play_now")
        decision.understood_intent = raw_sentence
        verifier = FakeVerifier(SearchVerification(status="not_found"))
        director = QueueDirector(FakeDJAgent(decision), verifier, FakeMemoryManager())

        result = await director.handle_song_request(
            raw_sentence,
            playback_queue=queue,
            uid="uid-1",
            session_id=7,
            profile={},
            user_settings={},
            playback_context={},
        )

        self.assertEqual(result.status, "needs_recovery")
        self.assertNotIn(raw_sentence, result.dj_text)
        self.assertNotIn(raw_sentence, str(result.decision))

    async def test_context_build_failure_uses_minimal_context_and_continues(self):
        memory = BuildFailingMemoryManager()
        decision = playable_decision(action="play_now")
        dj_agent = FakeDJAgent(decision)
        verifier = FakeVerifier(
            SearchVerification(
                status="verified",
                selected_song={"id": "verified", "name": "Weird Fishes"},
                url="/audio/verified",
            )
        )
        director = QueueDirector(dj_agent, verifier, memory)

        result = await director.handle_song_request(
            "play Radiohead",
            playback_queue=PlaybackQueue(),
            uid="uid-1",
            session_id=7,
            profile={"p": True},
            user_settings={"locale": "en"},
            playback_context={"current_track": {"name": "Now"}},
        )

        self.assertEqual(result.status, "queued")
        self.assertEqual(dj_agent.calls[0]["context_pack"]["playback_context"]["current_track"]["name"], "Now")
        self.assertEqual(dj_agent.calls[0]["context_pack"]["user_settings"]["locale"], "en")

    async def test_memory_update_failure_does_not_block_queueing(self):
        memory = UpdateFailingMemoryManager()
        decision = playable_decision(action="play_now")
        verifier = FakeVerifier(
            SearchVerification(
                status="verified",
                selected_song={"id": "verified", "name": "Weird Fishes"},
                url="/audio/verified",
            )
        )
        queue = PlaybackQueue()
        director = QueueDirector(FakeDJAgent(decision), verifier, memory)

        result = await director.handle_song_request(
            "play Radiohead",
            playback_queue=queue,
            uid="uid-1",
            session_id=7,
            profile={},
            user_settings={},
            playback_context={},
        )

        self.assertEqual(result.status, "queued")
        self.assertEqual([item.song["id"] for item in queue.ready_items()], ["verified"])
        self.assertEqual(memory.update_calls[0]["request_text"], "play Radiohead")

    async def test_dj_failure_returns_safe_recovery_without_queue_mutation_or_raw_payload(self):
        raw_sentence = "raw secret request text"
        queue = PlaybackQueue()
        queue.add_ready({"id": "stale", "name": "Stale"}, "/audio/stale")
        director = QueueDirector(RaisingDJAgent(), FakeVerifier(SearchVerification(status="not_found")), FakeMemoryManager())

        result = await director.handle_song_request(
            raw_sentence,
            playback_queue=queue,
            uid="uid-1",
            session_id=7,
            profile={},
            user_settings={},
            playback_context={},
        )

        self.assertEqual(result.status, "needs_recovery")
        self.assertEqual([item.song["id"] for item in queue.ready_items()], ["stale"])
        self.assertNotIn(raw_sentence, result.dj_text)
        self.assertNotIn(raw_sentence, str(result.decision))
        self.assertNotIn(raw_sentence, str(result.verification))

    async def test_negative_feedback_without_executable_task_clears_but_does_not_verify(self):
        queue = PlaybackQueue()
        queue.add_ready({"id": "stale", "name": "Stale"}, "/audio/stale")
        decision = DJDecision(
            action="negative_feedback",
            understood_intent="User rejected the current direction.",
            music_task={"type": "negative_feedback", "search_goals": [], "primary_entities": []},
            dj_response={"speak_now": "I will adjust."},
        )
        verifier = FakeVerifier(SearchVerification(status="verified", selected_song={"id": "x"}, url="/audio/x"))
        memory = FakeMemoryManager()
        director = QueueDirector(FakeDJAgent(decision), verifier, memory)

        result = await director.handle_song_request(
            "not this",
            playback_queue=queue,
            uid="uid-1",
            session_id=7,
            profile={},
            user_settings={},
            playback_context={},
        )

        self.assertEqual(result.status, "needs_recovery")
        self.assertEqual(queue.ready_items(), [])
        self.assertEqual(verifier.calls, [])
        self.assertEqual(memory.update_calls[0]["request_text"], "not this")

    async def test_invalid_verified_result_does_not_queue(self):
        queue = PlaybackQueue()
        queue.add_ready({"id": "stale", "name": "Stale"}, "/audio/stale")
        decision = playable_decision(action="play_now")
        verifier = FakeVerifier(
            SearchVerification(
                status="verified",
                selected_song={"id": "verified", "name": "No URL"},
                url="",
            )
        )
        director = QueueDirector(FakeDJAgent(decision), verifier, FakeMemoryManager())

        result = await director.handle_song_request(
            "play Radiohead",
            playback_queue=queue,
            uid="uid-1",
            session_id=7,
            profile={},
            user_settings={},
            playback_context={},
        )

        self.assertEqual(result.status, "needs_recovery")
        self.assertEqual(queue.ready_items(), [])

    async def test_context_and_memory_update_are_called_with_bounded_inputs(self):
        memory = FakeMemoryManager()
        decision = playable_decision()
        director = QueueDirector(
            FakeDJAgent(decision),
            FakeVerifier(SearchVerification(status="not_found")),
            memory,
        )
        profile = {"radio_insights": {"taste_summary": "alt rock"}}
        user_settings = {"locale": "zh-CN"}
        playback_context = {"current_track": {"name": "Now"}}
        recent_turns = [{"speaker": "user", "text": "earlier"}]

        await director.handle_song_request(
            "play Radiohead",
            playback_queue=PlaybackQueue(),
            uid="uid-1",
            session_id=7,
            profile=profile,
            user_settings=user_settings,
            playback_context=playback_context,
            recent_turns=recent_turns,
        )

        self.assertEqual(memory.build_calls[0]["profile"], profile)
        self.assertEqual(memory.build_calls[0]["user_settings"], user_settings)
        self.assertEqual(memory.build_calls[0]["playback_context"], playback_context)
        self.assertEqual(memory.build_calls[0]["recent_turns"], recent_turns)
        self.assertEqual(memory.update_calls[0]["uid"], "uid-1")
        self.assertEqual(memory.update_calls[0]["session_id"], 7)
        self.assertEqual(memory.update_calls[0]["request_text"], "play Radiohead")
        self.assertIs(memory.update_calls[0]["decision"], decision)

    async def test_verifier_exception_returns_recovery_without_queueing(self):
        queue = PlaybackQueue()
        decision = playable_decision(action="negative_feedback")
        raw_sentence = "not this raw query"
        verifier = RaisingVerifier(message=f"verifier unavailable for {raw_sentence}")
        director = QueueDirector(FakeDJAgent(decision), verifier, FakeMemoryManager())

        result = await director.handle_song_request(
            raw_sentence,
            playback_queue=queue,
            uid="uid-1",
            session_id=7,
            profile={},
            user_settings={},
            playback_context={},
        )

        self.assertEqual(result.status, "needs_recovery")
        self.assertEqual(queue.ready_items(), [])
        self.assertEqual(verifier.calls[0]["raw_user_text"], raw_sentence)
        self.assertEqual(result.verification["failure_reason"], "Search verification failed safely.")
        self.assertNotIn(raw_sentence, result.dj_text)
        self.assertNotIn(raw_sentence, str(result.decision))
        self.assertNotIn(raw_sentence, str(result.verification))

    async def test_result_to_dict_returns_json_safe_shape(self):
        result = await QueueDirector(
            FakeDJAgent(playable_decision(action="play_now")),
            FakeVerifier(
                SearchVerification(
                    status="verified",
                    selected_song={"id": "verified", "name": "Weird Fishes"},
                    url="/audio/verified",
                )
            ),
            FakeMemoryManager(),
        ).handle_song_request(
            "play Radiohead",
            playback_queue=PlaybackQueue(),
            uid="uid-1",
            session_id=7,
            profile={},
            user_settings={},
            playback_context={},
        )

        data = result.to_dict()

        self.assertEqual(data["status"], "queued")
        self.assertEqual(data["next_song"]["id"], "verified")
        self.assertEqual(data["url"], "/audio/verified")
        self.assertIsInstance(data["decision"], dict)
        self.assertIsInstance(data["verification"], dict)
        self.assertIsInstance(data["recovery_options"], list)

    async def test_result_to_dict_is_json_serializable_with_weird_nested_song_object(self):
        result = await QueueDirector(
            FakeDJAgent(playable_decision(action="play_now")),
            FakeVerifier(
                SearchVerification(
                    status="verified",
                    selected_song={
                        "id": "verified",
                        "name": "Weird Fishes",
                        "nested": {"object": WeirdObject()},
                    },
                    url="/audio/verified",
                )
            ),
            FakeMemoryManager(),
        ).handle_song_request(
            "play Radiohead",
            playback_queue=PlaybackQueue(),
            uid="uid-1",
            session_id=7,
            profile={},
            user_settings={},
            playback_context={},
        )

        dumped = json.dumps(result.to_dict(), ensure_ascii=False)

        self.assertIn("weird nested object", dumped)

    async def test_dict_style_decision_and_verification_are_supported(self):
        queue = PlaybackQueue()
        decision = {
            "action": "play_now",
            "understood_intent": "User wants a direct song.",
            "music_task": {"search_goals": ["Massive Attack Teardrop"]},
            "dj_response": {"speak_now": "Queued."},
            "raw_text": "raw should not surface",
        }
        verification = {
            "status": "verified",
            "selected_song": {"id": "teardrop", "name": "Teardrop"},
            "url": "/audio/teardrop",
            "verification": {"version_note": "matched original"},
        }
        director = QueueDirector(FakeDJAgent(decision), FakeVerifier(verification), FakeMemoryManager())

        result = await director.handle_song_request(
            "play Teardrop",
            playback_queue=queue,
            uid="uid-1",
            session_id=7,
            profile={},
            user_settings={},
            playback_context={},
        )

        self.assertEqual(result.status, "queued")
        self.assertEqual(queue.ready_items()[0].selection_reason["text"], "matched original")
        self.assertNotIn("raw_text", result.decision)


if __name__ == "__main__":
    unittest.main()
