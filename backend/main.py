import asyncio
import subprocess

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from backend.core.config import get_settings
from backend.core.event_bus import EventBus
from backend.memory.models import init_db
from backend.memory.store import MemoryStore
from backend.memory.compressor import ContextCompressor
from backend.adapters.netease import NeteaseAdapter
from backend.adapters.llm_router import LLMRouter
from backend.adapters.tts import TTSAdapter
from backend.engines.profile import ProfileEngine
from backend.engines.dj import DJEngine
from backend.engines.scheduler import StreamScheduler
from backend.engines.audio_resolver import AudioResolver
from backend.api import auth, radio, ws

settings = get_settings()


async def lifespan(app: FastAPI):
    # Startup
    app.state.netease_proc = None

    # Start NetEase bridge only if not already running
    import httpx
    bridge_alive = False
    try:
        r = httpx.get(f"http://127.0.0.1:{settings.netease_bridge_port}/login/status", timeout=2.0)
        bridge_alive = r.status_code == 200
    except Exception:
        pass

    if not bridge_alive:
        def start_bridge():
            try:
                proc = subprocess.Popen(
                    ["node", "netease-bridge/server.js"],
                    cwd=".",
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                )
                return proc
            except Exception:
                return None

        app.state.netease_proc = await asyncio.get_event_loop().run_in_executor(None, start_bridge)
        # Give the bridge a moment to start
        await asyncio.sleep(1.5)

    await init_db()

    bus = EventBus()
    store = MemoryStore()
    netease_adapter = NeteaseAdapter()
    llm_router = LLMRouter()
    tts_adapter = TTSAdapter()
    profile_eng = ProfileEngine(netease_adapter, llm_router, store)
    dj_eng = DJEngine(llm_router, store)
    sched = StreamScheduler(netease_adapter, store, bus)
    audio_resolver = AudioResolver(netease_adapter, store)
    comp = ContextCompressor()

    # Wire module globals
    auth.netease = netease_adapter
    auth.store = store
    radio.netease = netease_adapter
    radio.llm = llm_router
    radio.tts = tts_adapter
    radio.profile_engine = profile_eng
    radio.dj_engine = dj_eng
    radio.scheduler = sched
    radio.audio_resolver = audio_resolver
    radio.store = store
    radio.bus = bus
    radio.compressor = comp
    ws.netease = netease_adapter
    ws.llm = llm_router
    ws.tts = tts_adapter
    ws.profile_engine = profile_eng
    ws.dj_engine = dj_eng
    ws.scheduler = sched
    ws.audio_resolver = audio_resolver
    ws.store = store
    ws.bus = bus
    ws.compressor = comp

    app.state.bus = bus
    app.state.store = store
    app.state.netease = netease_adapter

    yield

    # Shutdown
    if app.state.netease_proc:
        app.state.netease_proc.terminate()
        app.state.netease_proc.wait(timeout=5)
    await llm_router.close()
    await tts_adapter.close()
    await netease_adapter.close()


app = FastAPI(title="AI Radio", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth.router)
app.include_router(radio.router)
app.add_websocket_route("/ws", ws.ws_handler)

app.mount("/css", StaticFiles(directory="frontend/css"), name="css")
app.mount("/js", StaticFiles(directory="frontend/js"), name="js")


@app.get("/health")
async def health():
    return {"status": "ok"}


@app.get("/")
async def root():
    return FileResponse("frontend/index.html")
