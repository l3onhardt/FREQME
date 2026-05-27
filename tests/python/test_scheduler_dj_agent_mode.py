import unittest

from tests.python.test_scheduler_personalized_pick import FakeNetease, FakeStore
from backend.engines.scheduler import StreamScheduler


class SchedulerDJAgentModeTests(unittest.TestCase):
    def make_scheduler(self):
        return StreamScheduler(FakeNetease(), FakeStore(), bus=None)

    def test_scheduler_ignores_dj_agent_mode_for_natural_language_parsing(self):
        scheduler = self.make_scheduler()
        state = scheduler.new_session_state()
        user_settings = {
            "dj_agent": {
                "active_mode": {
                    "label": "Radiohead direction",
                    "expires_after_tracks": 3,
                }
            }
        }

        intent = scheduler.apply_listening_intent(
            state,
            "不能放点radiohead的吗",
            user_settings=user_settings,
        )

        self.assertEqual(intent["keywords"], "")
        self.assertEqual(state.intent_picks_remaining, 0)
        self.assertEqual(user_settings["listening_intent"]["keywords"], "")

    def test_scheduler_ignores_empty_dj_agent_mode_for_natural_language_parsing(self):
        scheduler = self.make_scheduler()
        state = scheduler.new_session_state()
        user_settings = {"dj_agent": {"active_mode": {}}}

        intent = scheduler.apply_listening_intent(
            state,
            "不能放点radiohead的吗",
            user_settings=user_settings,
        )

        self.assertEqual(intent["keywords"], "")
        self.assertEqual(state.intent_picks_remaining, 0)

    def test_dj_agent_mode_written_intent_does_not_rehydrate_raw_search(self):
        scheduler = self.make_scheduler()
        state = scheduler.new_session_state()
        user_settings = {
            "dj_agent": {
                "active_mode": {
                    "label": "Radiohead direction",
                    "expires_after_tracks": 3,
                }
            }
        }
        scheduler.apply_listening_intent(
            state,
            "不能放点radiohead的吗",
            user_settings=user_settings,
        )

        fresh_state = scheduler.new_session_state()
        intent = scheduler._intent_from_settings(user_settings, fresh_state)

        self.assertEqual(intent["keywords"], "")
        self.assertEqual(scheduler._intent_keywords(intent), "")
        self.assertEqual(fresh_state.intent_picks_remaining, 0)


if __name__ == "__main__":
    unittest.main()
