import unittest

from backend.engines.dj import should_generate_segue


class DjCadenceTests(unittest.TestCase):
    def test_generates_program_break_after_each_three_song_set(self):
        self.assertFalse(should_generate_segue(1))
        self.assertFalse(should_generate_segue(2))
        self.assertFalse(should_generate_segue(3))
        self.assertTrue(should_generate_segue(4))
        self.assertFalse(should_generate_segue(5))
        self.assertFalse(should_generate_segue(6))
        self.assertTrue(should_generate_segue(7))
