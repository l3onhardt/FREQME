import unittest

from backend.engines.dj import should_generate_segue


class DjCadenceTests(unittest.TestCase):
    def test_generates_segue_every_other_song(self):
        self.assertFalse(should_generate_segue(1))
        self.assertTrue(should_generate_segue(2))
        self.assertFalse(should_generate_segue(3))
        self.assertTrue(should_generate_segue(4))
