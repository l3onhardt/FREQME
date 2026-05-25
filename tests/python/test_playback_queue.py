import unittest

from backend.engines.playback_queue import PlaybackQueue


class PlaybackQueueTests(unittest.TestCase):
    def test_promote_ready_item_marks_previous_played(self):
        queue = PlaybackQueue(prewarm_depth=3)
        queue.add_ready({"id": "1", "name": "A"}, "/audio/1")
        queue.add_ready({"id": "2", "name": "B"}, "/audio/2")

        first = queue.promote_next()
        second = queue.promote_next(previous_event="played")

        self.assertEqual(first.song["id"], "1")
        self.assertEqual(second.song["id"], "2")
        self.assertEqual(queue.items[0].status, "played")
        self.assertEqual(queue.items[1].status, "playing")

    def test_needs_prewarm_counts_ready_and_playing_items(self):
        queue = PlaybackQueue(prewarm_depth=3)
        queue.add_ready({"id": "1"}, "/audio/1")

        self.assertEqual(queue.prewarm_needed(), 2)
