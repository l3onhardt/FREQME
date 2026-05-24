import unittest

from backend.api import auth


class FakeNetease:
    def __init__(self, status):
        self.status = status

    async def login_status(self):
        return self.status


class FakeStore:
    def __init__(self, *, raises=False):
        self.raises = raises
        self.saved = []

    async def save_auth_account(self, uid, profile):
        if self.raises:
            raise RuntimeError("save failed")
        self.saved.append((uid, profile))


class AuthStatusTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.original_netease = auth.netease
        self.original_store = auth.store
        self.addCleanup(self._restore_auth_globals)

    def _restore_auth_globals(self):
        auth.netease = self.original_netease
        auth.store = self.original_store

    async def test_non_dict_status_returns_clean_unauthenticated_shape(self):
        auth.netease = FakeNetease("bad")
        auth.store = FakeStore()

        result = await auth.login_status()

        self.assertEqual(result, {"data": {"code": -1, "account": None, "profile": None}})

    async def test_bad_data_shape_returns_original_status_without_raising(self):
        status = {"data": "bad"}
        auth.netease = FakeNetease(status)
        auth.store = FakeStore()

        result = await auth.login_status()

        self.assertIs(result, status)

    async def test_bad_top_level_profile_shape_returns_original_status_without_raising(self):
        status = {"profile": "bad"}
        auth.netease = FakeNetease(status)
        auth.store = FakeStore()

        result = await auth.login_status()

        self.assertIs(result, status)

    async def test_valid_profile_saves_auth_account_with_string_uid(self):
        profile = {"userId": 12345, "nickname": "Tester"}
        status = {"data": {"profile": profile}}
        fake_store = FakeStore()
        auth.netease = FakeNetease(status)
        auth.store = fake_store

        result = await auth.login_status()

        self.assertIs(result, status)
        self.assertEqual(fake_store.saved, [("12345", profile)])

    async def test_store_save_failure_still_returns_original_status(self):
        profile = {"userId": 12345, "nickname": "Tester"}
        status = {"data": {"profile": profile}}
        auth.netease = FakeNetease(status)
        auth.store = FakeStore(raises=True)

        result = await auth.login_status()

        self.assertIs(result, status)


if __name__ == "__main__":
    unittest.main()
