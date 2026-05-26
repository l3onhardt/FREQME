import unittest
import importlib
from contextlib import asynccontextmanager
from unittest import mock

import httpx
from fastapi import FastAPI


class WSDJAgentFlowTests(unittest.IsolatedAsyncioTestCase):
    def test_ws_exposes_dj_request_service_globals(self):
        from backend.api import ws

        ws = importlib.reload(ws)
        self.assertIsNone(ws.dj_request_agent)
        self.assertIsNone(ws.search_verify_agent)
        self.assertIsNone(ws.queue_director)
        self.assertIsNone(ws.dj_memory_manager)

    async def test_lifespan_wires_dj_request_services_to_ws_globals(self):
        from backend.api import ws
        import backend.main as main
        from backend.engines.dj_request_agent import DJRequestAgent
        from backend.engines.queue_director import QueueDirector
        from backend.engines.search_verify_agent import SearchVerifyAgent
        from backend.memory.dj_memory import DJMemoryManager

        class FakeHTTPResponse:
            status_code = 200

        async def noop_async(*args, **kwargs):
            return None

        class FakeClosable:
            async def close(self):
                return None

        for name in (
            "dj_request_agent",
            "search_verify_agent",
            "queue_director",
            "dj_memory_manager",
        ):
            setattr(ws, name, None)

        app = FastAPI()
        with (
            mock.patch.object(httpx, "get", return_value=FakeHTTPResponse()),
            mock.patch.object(main, "init_db", side_effect=noop_async),
            mock.patch.object(main, "NeteaseAdapter", return_value=FakeClosable()),
            mock.patch.object(main, "LLMRouter", return_value=FakeClosable()),
            mock.patch.object(main, "TTSAdapter", return_value=FakeClosable()),
        ):
            async with asynccontextmanager(main.lifespan)(app):
                self.assertIsInstance(ws.dj_memory_manager, DJMemoryManager)
                self.assertIsInstance(ws.dj_request_agent, DJRequestAgent)
                self.assertIsInstance(ws.search_verify_agent, SearchVerifyAgent)
                self.assertIsInstance(ws.queue_director, QueueDirector)


if __name__ == "__main__":
    unittest.main()
