import unittest

from backend.engines.dj_request_agent import DJDecision
from backend.engines.playback_queue import PlaybackQueue
from backend.engines.queue_director import QueueDirector
from backend.engines.search_verify_agent import SearchVerification


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


class FakeDJAgent:
    def __init__(self, decision):
        self.decision = decision
        self.calls = []

    async def decide(self, request_text, context_pack):
        self.calls.append({"request_text": request_text, "context_pack": context_pack})
        return self.decision


class FakeVerifier:
    def __init__(self, result):
        self.result = result
        self.calls = []

    async def verify(self, music_task, uid=None, raw_user_text=""):
        self.calls.append({"music_task": music_task, "uid": uid, "raw_user_text": raw_user_text})
        return self.result


class RaisingVerifier:
    def __init__(self):
        self.calls = []

    async def verify(self, music_task, uid=None, raw_user_text=""):
        self.calls.append({"music_task": music_task, "uid": uid, "raw_user_text": raw_user_text})
        raise RuntimeError("verifier unavailable")


def playable_decision(action="set_direction_and_play", speak_now="接上这条线。"):
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
        director = QueueDirector(FakeDJAgent(decision), verifier, queue, FakeMemoryManager())

        result = await director.handle_request("uid-1", 7, "别放这个了，来点 Radiohead")

        self.assertEqual(result.status, "queued")
        self.assertEqual(result.next_song["id"], "verified")
        self.assertEqual(verifier.calls[0]["music_task"], decision.music_task)
        self.assertEqual(verifier.calls[0]["raw_user_text"], "别放这个了，来点 Radiohead")
        self.assertEqual(queue.items[0].song["id"], "playing")
        self.assertEqual(queue.items[0].status, "playing")
        ready = queue.ready_items()
        self.assertEqual([item.song["id"] for item in ready], ["verified"])
        self.assertEqual(ready[0].selection_reason["type"], "dj_agent_verified")
        self.assertEqual(ready[0].selection_reason["understood_intent"], "User wants Radiohead songs.")
        self.assertEqual(ready[0].selection_reason["verification_note"], "official studio version")

    async def test_ask_clarifying_question_does_not_clear_or_verify(self):
        queue = PlaybackQueue()
        queue.add_ready({"id": "stale", "name": "Stale"}, "/audio/stale")
        decision = DJDecision(
            action="ask_clarifying_question",
            understood_intent="The request is unclear.",
            dj_response={"speak_now": "你想听哪一类？"},
        )
        verifier = FakeVerifier(SearchVerification(status="verified", selected_song={}, url=""))
        director = QueueDirector(FakeDJAgent(decision), verifier, queue, FakeMemoryManager())

        result = await director.handle_request("uid-1", 7, "随便那个")

        self.assertEqual(result.status, "ask")
        self.assertEqual(result.dj_text, "你想听哪一类？")
        self.assertEqual(verifier.calls, [])
        self.assertEqual([item.song["id"] for item in queue.ready_items()], ["stale"])

    async def test_search_failure_returns_recovery_without_quoting_raw_sentence(self):
        queue = PlaybackQueue()
        queue.add_ready({"id": "stale", "name": "Stale"}, "/audio/stale")
        raw_sentence = "别放这个了，给我那首超级难找的歌"
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
        director = QueueDirector(FakeDJAgent(decision), verifier, queue, FakeMemoryManager())

        result = await director.handle_request("uid-1", 7, raw_sentence)

        self.assertEqual(result.status, "needs_recovery")
        self.assertNotIn(raw_sentence, result.dj_text)
        self.assertEqual(queue.ready_items(), [])
        self.assertEqual(len(result.recovery_options), 3)
        self.assertEqual(result.recovery_options[0]["task"], "Radiohead live")

    async def test_context_and_memory_update_are_called_with_bounded_inputs(self):
        memory = FakeMemoryManager()
        decision = playable_decision()
        director = QueueDirector(
            FakeDJAgent(decision),
            FakeVerifier(SearchVerification(status="not_found")),
            PlaybackQueue(),
            memory,
        )
        profile = {"radio_insights": {"taste_summary": "alt rock"}}
        user_settings = {"locale": "zh-CN"}
        playback_context = {"current_track": {"name": "Now"}}
        recent_turns = [{"speaker": "user", "text": "之前"}]

        await director.handle_request(
            "uid-1",
            7,
            "来点 Radiohead",
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
        self.assertEqual(memory.update_calls[0]["request_text"], "来点 Radiohead")
        self.assertIs(memory.update_calls[0]["decision"], decision)

    async def test_verifier_exception_returns_recovery_without_queueing(self):
        queue = PlaybackQueue()
        decision = playable_decision(action="negative_feedback")
        verifier = RaisingVerifier()
        director = QueueDirector(FakeDJAgent(decision), verifier, queue, FakeMemoryManager())

        result = await director.handle_request("uid-1", 7, "别放这个")

        self.assertEqual(result.status, "needs_recovery")
        self.assertEqual(queue.ready_items(), [])
        self.assertEqual(verifier.calls[0]["raw_user_text"], "别放这个")


if __name__ == "__main__":
    unittest.main()
