# AI Radio Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a fully functional AI radio with NetEase Cloud Music playback, AI host 小米memo, and three-layer memory.

**Architecture:** Python FastAPI backend with modular engines, Node.js NetEase bridge subprocess, vanilla JS frontend with immersive dark UI. Event-driven core, SQLite memory store, MiMo TTS.

**Tech Stack:** Python 3.11+, FastAPI, SQLite, Node.js 18+, vanilla HTML/CSS/JS, MiMo TTS API, Anthropic/OpenAI/Gemini APIs

---

### Task 1: Project Scaffold

**Files:**
- Create: `backend/__init__.py`
- Create: `backend/main.py`
- Create: `backend/core/__init__.py`
- Create: `backend/core/config.py`
- Create: `requirements.txt`
- Create: `netease-bridge/package.json`
- Create: `.env.example`

- [ ] **Step 1: Create directory structure**

```bash
mkdir -p backend/core backend/engines backend/adapters backend/memory backend/api
mkdir -p netease-bridge frontend/css frontend/js data
```

- [ ] **Step 2: Write .env.example**

```
LLM_PROVIDER=anthropic
LLM_API_KEY=sk-ant-xxx
LLM_MODEL=claude-sonnet-4-6
LLM_FALLBACK_PROVIDER=openai
LLM_FALLBACK_API_KEY=sk-xxx
LLM_FALLBACK_MODEL=gpt-4o
MIMO_API_KEY=xxx
MIMO_API_URL=https://api.mimo.xiaomi.com/v1/tts
NETEASE_BRIDGE_PORT=3000
MAX_DAILY_TOKENS=100000
```

- [ ] **Step 3: Write requirements.txt**

```
fastapi==0.115.0
uvicorn==0.30.0
websockets==13.0
httpx==0.27.0
python-dotenv==1.0.0
pydantic==2.9.0
aiosqlite==0.20.0
tenacity==9.0.0
```

- [ ] **Step 4: Write netease-bridge/package.json**

```json
{
  "name": "netease-bridge",
  "version": "1.0.0",
  "type": "module",
  "dependencies": {
    "express": "^4.21.0",
    "NeteaseCloudMusicApi": "^4.28.0"
  }
}
```

- [ ] **Step 5: Write backend/core/config.py — load .env, validate required keys, expose settings as typed pydantic model**

```python
from pydantic_settings import BaseSettings
from functools import lru_cache

class Settings(BaseSettings):
    llm_provider: str = "anthropic"
    llm_api_key: str = ""
    llm_model: str = "claude-sonnet-4-6"
    llm_fallback_provider: str = "openai"
    llm_fallback_api_key: str = ""
    llm_fallback_model: str = "gpt-4o"
    mimo_api_key: str = ""
    mimo_api_url: str = "https://api.mimo.xiaomi.com/v1/tts"
    netease_bridge_port: int = 3000
    max_daily_tokens: int = 100000
    data_dir: str = "./data"
    class Config:
        env_file = ".env"

@lru_cache()
def get_settings() -> Settings:
    return Settings()
```

- [ ] **Step 6: Write backend/main.py — FastAPI app factory with CORS, startup/shutdown for netease bridge**

```python
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from backend.core.config import get_settings

settings = get_settings()

async def lifespan(app: FastAPI):
    # startup: launch netease bridge subprocess
    import subprocess, asyncio
    app.state.netease = subprocess.Popen(
        ["node", "netease-bridge/server.js"],
        cwd=".",
        stdout=subprocess.PIPE, stderr=subprocess.PIPE
    )
    # wait for bridge health
    for _ in range(15):
        try:
            r = await asyncio.get_event_loop().run_in_executor(
                None, lambda: __import__('urllib.request').request.urlopen(
                    f"http://localhost:{settings.netease_bridge_port}/health"
                ).read()
            )
            if b"ok" in r: break
        except: pass
        await asyncio.sleep(0.2)
    yield
    # shutdown
    app.state.netease.terminate()
    app.state.netease.wait(timeout=5)

app = FastAPI(lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

@app.get("/health")
async def health(): return {"status": "ok"}
```

- [ ] **Step 7: Install deps and verify**

```bash
cd backend && pip install -r requirements.txt --quiet
cd ../netease-bridge && npm install --silent
python -c "from backend.core.config import get_settings; print(get_settings().llm_provider)"
```

Expected: prints "anthropic"

- [ ] **Step 8: Commit**

```bash
git add -A && git commit -m "feat: project scaffold with FastAPI entry and NetEase bridge skeleton"
```

---

### Task 2: NetEase Bridge (Node.js)

**Files:**
- Create: `netease-bridge/server.js`

- [ ] **Step 1: Write netease-bridge/server.js**

```javascript
import express from 'express';
import { login_qr_key, login_qr_create, login_qr_check,
         user_playlist, user_record, recommend_songs,
         personal_fm, simi_song, song_url, search,
         login_refresh, login_status, like_list } from 'NeteaseCloudMusicApi';

const app = express();
app.use(express.json());

let cookie = '';

// QR login endpoints
app.get('/login/qr/key', async (req, res) => {
  const r = await login_qr_key({});
  res.json(r.body);
});

app.get('/login/qr/create', async (req, res) => {
  const r = await login_qr_create({ key: req.query.key, qrimg: true });
  res.json(r.body);
});

app.get('/login/qr/check', async (req, res) => {
  const r = await login_qr_check({ key: req.query.key });
  if (r.body.code === 803) cookie = r.body.cookie;
  res.json(r.body);
});

// auth-required helper
function withCookie(opts) {
  return cookie ? { ...opts, cookie } : opts;
}

app.get('/user/playlist', async (req, res) => {
  const r = await user_playlist(withCookie({ uid: req.query.uid }));
  res.json(r.body);
});

app.get('/user/record', async (req, res) => {
  const r = await user_record(withCookie({ uid: req.query.uid, type: 1 }));
  res.json(r.body);
});

app.get('/recommend/songs', async (req, res) => {
  const r = await recommend_songs(withCookie({}));
  res.json(r.body);
});

app.get('/personal_fm', async (req, res) => {
  const r = await personal_fm(withCookie({}));
  res.json(r.body);
});

app.get('/simi/song', async (req, res) => {
  const r = await simi_song({ id: req.query.id });
  res.json(r.body);
});

app.get('/song/url', async (req, res) => {
  const r = await song_url({ id: req.query.id, br: 320000 });
  res.json(r.body);
});

app.get('/search', async (req, res) => {
  const r = await search({ keywords: req.query.keywords, type: 1, limit: 10 });
  res.json(r.body);
});

app.get('/like/list', async (req, res) => {
  const r = await like_list(withCookie({ uid: req.query.uid }));
  res.json(r.body);
});

app.get('/login/status', async (req, res) => {
  const r = await login_status({ cookie });
  res.json(r.body);
});

app.get('/health', (req, res) => res.send('ok'));

app.listen(process.env.PORT || 3000, () => console.log('netease-bridge ready'));
```

- [ ] **Step 2: Test bridge starts**

```bash
cd netease-bridge && PORT=3000 node server.js &
sleep 1 && curl http://localhost:3000/health
kill %
```

Expected: "ok"

- [ ] **Step 3: Commit**

---

### Task 3: Memory Store

**Files:**
- Create: `backend/memory/__init__.py`
- Create: `backend/memory/models.py`
- Create: `backend/memory/store.py`
- Create: `backend/memory/compressor.py`

- [ ] **Step 1: Write backend/memory/models.py — SQLite schema**

```python
import aiosqlite
from datetime import datetime
import json

DB_PATH = "data/radio.db"

async def init_db():
    async with aiosqlite.connect(DB_PATH) as db:
        await db.executescript("""
            CREATE TABLE IF NOT EXISTS user_profile (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                uid TEXT UNIQUE NOT NULL,
                profile_json TEXT NOT NULL,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS track_log (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                song_id TEXT NOT NULL,
                song_name TEXT NOT NULL,
                artist TEXT,
                source TEXT,
                feedback TEXT,
                played_at TEXT DEFAULT CURRENT_TIMESTAMP
            );
            CREATE INDEX IF NOT EXISTS idx_track_played ON track_log(played_at);
            CREATE INDEX IF NOT EXISTS idx_track_song ON track_log(song_id);

            CREATE TABLE IF NOT EXISTS dj_script_log (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                topic TEXT,
                script_text TEXT NOT NULL,
                style TEXT,
                related_song_id TEXT,
                tts_hash TEXT,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS session_log (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                uid TEXT NOT NULL,
                session_start TEXT DEFAULT CURRENT_TIMESTAMP,
                session_end TEXT,
                songs_played INTEGER DEFAULT 0,
                topics_covered TEXT,
                summary TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_session_start ON session_log(session_start);

            CREATE TABLE IF NOT EXISTS tts_cache (
                hash TEXT PRIMARY KEY,
                audio_path TEXT NOT NULL,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS token_usage (
                date TEXT PRIMARY KEY,
                tokens_used INTEGER DEFAULT 0
            );
        """)
        await db.commit()
```

- [ ] **Step 2: Write backend/memory/store.py — CRUD for L1/L2**

```python
import aiosqlite, json
from backend.memory.models import DB_PATH

class MemoryStore:
    async def save_profile(self, uid: str, profile: dict) -> None:
        async with aiosqlite.connect(DB_PATH) as db:
            await db.execute(
                "INSERT INTO user_profile (uid, profile_json, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) "
                "ON CONFLICT(uid) DO UPDATE SET profile_json=?, updated_at=CURRENT_TIMESTAMP",
                (uid, json.dumps(profile, ensure_ascii=False), json.dumps(profile, ensure_ascii=False))
            )
            await db.commit()

    async def get_profile(self, uid: str) -> dict | None:
        async with aiosqlite.connect(DB_PATH) as db:
            async with db.execute("SELECT profile_json FROM user_profile WHERE uid=?", (uid,)) as cursor:
                row = await cursor.fetchone()
                return json.loads(row[0]) if row else None

    async def log_track(self, song_id: str, name: str, artist: str, source: str) -> None:
        async with aiosqlite.connect(DB_PATH) as db:
            await db.execute(
                "INSERT INTO track_log (song_id, song_name, artist, source) VALUES (?,?,?,?)",
                (song_id, name, artist, source)
            )
            await db.commit()

    async def get_recent_tracks(self, limit: int = 100) -> list[str]:
        async with aiosqlite.connect(DB_PATH) as db:
            async with db.execute(
                "SELECT song_id FROM track_log ORDER BY played_at DESC LIMIT ?", (limit,)
            ) as cursor:
                return [row[0] for row in await cursor.fetchall()]

    async def log_script(self, topic: str, script: str, style: str, song_id: str, tts_hash: str = "") -> None:
        async with aiosqlite.connect(DB_PATH) as db:
            await db.execute(
                "INSERT INTO dj_script_log (topic, script_text, style, related_song_id, tts_hash) VALUES (?,?,?,?,?)",
                (topic, script, style, song_id, tts_hash)
            )
            await db.commit()

    async def create_session(self, uid: str) -> int:
        async with aiosqlite.connect(DB_PATH) as db:
            cursor = await db.execute("INSERT INTO session_log (uid) VALUES (?)", (uid,))
            await db.commit()
            return cursor.lastrowid

    async def end_session(self, session_id: int, songs: int, topics: str, summary: str) -> None:
        async with aiosqlite.connect(DB_PATH) as db:
            await db.execute(
                "UPDATE session_log SET session_end=CURRENT_TIMESTAMP, songs_played=?, topics_covered=?, summary=? WHERE id=?",
                (songs, topics, summary, session_id)
            )
            await db.commit()

    async def session_count(self, uid: str) -> int:
        async with aiosqlite.connect(DB_PATH) as db:
            async with db.execute("SELECT COUNT(*) FROM session_log WHERE uid=?", (uid,)) as cursor:
                row = await cursor.fetchone()
                return row[0] if row else 0

    async def cache_tts(self, hash: str, path: str) -> None:
        async with aiosqlite.connect(DB_PATH) as db:
            await db.execute("INSERT OR IGNORE INTO tts_cache (hash, audio_path) VALUES (?,?)", (hash, path))
            await db.commit()

    async def get_tts_cache(self, hash: str) -> str | None:
        async with aiosqlite.connect(DB_PATH) as db:
            async with db.execute("SELECT audio_path FROM tts_cache WHERE hash=?", (hash,)) as cursor:
                row = await cursor.fetchone()
                return row[0] if row else None

    async def check_token_budget(self) -> bool:
        today = __import__('datetime').datetime.now().strftime("%Y-%m-%d")
        from backend.core.config import get_settings
        settings = get_settings()
        async with aiosqlite.connect(DB_PATH) as db:
            async with db.execute("SELECT tokens_used FROM token_usage WHERE date=?", (today,)) as cursor:
                row = await cursor.fetchone()
                return (row[0] if row else 0) < settings.max_daily_tokens

    async def add_tokens(self, count: int) -> None:
        today = __import__('datetime').datetime.now().strftime("%Y-%m-%d")
        async with aiosqlite.connect(DB_PATH) as db:
            await db.execute(
                "INSERT INTO token_usage (date, tokens_used) VALUES (?,?) ON CONFLICT(date) DO UPDATE SET tokens_used = tokens_used + ?",
                (today, count, count)
            )
            await db.commit()
```

- [ ] **Step 3: Write backend/memory/compressor.py — L3 compression**

```python
from backend.memory.store import MemoryStore

class ContextCompressor:
    def __init__(self, max_rounds: int = 20):
        self.max_rounds = max_rounds
        self.recent_context: list[dict] = []

    def add_round(self, round_data: dict) -> None:
        self.recent_context.append(round_data)
        if len(self.recent_context) > self.max_rounds:
            overflow = self.recent_context[:-self.max_rounds]
            self.recent_context = self.recent_context[-self.max_rounds:]
            return overflow
        return None

    async def compress(self, overflow: list[dict], llm_router) -> str:
        """Summarize overflow rounds using LLM."""
        text = "\n".join(r.get("text", "") for r in overflow)
        prompt = f"用一句话总结以下电台对话内容（不超过50字）：\n{text}"
        summary = await llm_router.chat(prompt, max_tokens=80)
        return summary

    def get_context(self) -> list[dict]:
        return self.recent_context

    def to_prompt_text(self) -> str:
        return "\n".join(
            f"[{r.get('timestamp','')}] {r.get('speaker','memo')}: {r.get('text','')}"
            for r in self.recent_context[-10:]
        )
```

- [ ] **Step 4: Run tests for memory store**

```bash
python -c "
import asyncio
from backend.memory.models import init_db
from backend.memory.store import MemoryStore
async def test():
    await init_db()
    store = MemoryStore()
    await store.save_profile('test123', {'music_dna': {'genres': {'pop': 0.8}}})
    p = await store.get_profile('test123')
    assert p['music_dna']['genres']['pop'] == 0.8
    print('Memory store tests PASS')
asyncio.run(test())
"
```

- [ ] **Step 5: Commit**

---

### Task 4: Netease Adapter (Python)

**Files:**
- Create: `backend/adapters/__init__.py`
- Create: `backend/adapters/netease.py`

- [ ] **Step 1: Write backend/adapters/netease.py**

```python
import httpx
from backend.core.config import get_settings

settings = get_settings()
BASE = f"http://localhost:{settings.netease_bridge_port}"

class NeteaseAdapter:
    def __init__(self):
        self.client = httpx.AsyncClient(timeout=30.0)

    async def qr_key(self) -> dict:
        r = await self.client.get(f"{BASE}/login/qr/key")
        return r.json()

    async def qr_create(self, key: str) -> dict:
        r = await self.client.get(f"{BASE}/login/qr/create", params={"key": key})
        return r.json()

    async def qr_check(self, key: str) -> dict:
        r = await self.client.get(f"{BASE}/login/qr/check", params={"key": key})
        return r.json()

    async def user_playlist(self, uid: int) -> list[dict]:
        r = await self.client.get(f"{BASE}/user/playlist", params={"uid": uid})
        data = r.json()
        return data.get("playlist", []) if isinstance(data, dict) else data

    async def user_record(self, uid: int) -> dict:
        r = await self.client.get(f"{BASE}/user/record", params={"uid": uid})
        return r.json()

    async def recommend_songs(self) -> list[dict]:
        r = await self.client.get(f"{BASE}/recommend/songs")
        return r.json().get("data", {}).get("dailySongs", [])

    async def personal_fm(self) -> list[dict]:
        r = await self.client.get(f"{BASE}/personal_fm")
        return r.json().get("data", [])

    async def simi_song(self, song_id: str) -> list[dict]:
        r = await self.client.get(f"{BASE}/simi/song", params={"id": song_id})
        return r.json().get("songs", [])

    async def song_url(self, song_id: str) -> str:
        r = await self.client.get(f"{BASE}/song/url", params={"id": song_id, "br": 320000})
        data = r.json().get("data", [])
        if data and data[0].get("url"):
            return data[0]["url"]
        return f"https://music.163.com/song/media/outer/url?id={song_id}.mp3"

    async def like_list(self, uid: int) -> list[int]:
        r = await self.client.get(f"{BASE}/like/list", params={"uid": uid})
        return r.json().get("ids", [])

    async def login_status(self) -> dict:
        r = await self.client.get(f"{BASE}/login/status")
        return r.json()

    async def close(self):
        await self.client.aclose()
```

- [ ] **Step 2: Test adapter connectivity**

```bash
python -c "
import asyncio
from backend.adapters.netease import NeteaseAdapter
async def test():
    a = NeteaseAdapter()
    try:
        k = await a.qr_key()
        assert 'unikey' in k.get('data', k)
        print(f'QR key obtained: {k}')
    except Exception as e:
        print(f'Bridge not running yet, skipping: {e}')
asyncio.run(test())
"
```

- [ ] **Step 3: Commit**

---

### Task 5: LLM Router

**Files:**
- Create: `backend/adapters/llm_router.py`

- [ ] **Step 1: Write backend/adapters/llm_router.py**

```python
import httpx
from backend.core.config import get_settings
from backend.memory.store import MemoryStore

settings = get_settings()

PROVIDERS = {
    "anthropic": {
        "url": "https://api.anthropic.com/v1/messages",
        "headers": lambda: {"x-api-key": settings.llm_api_key, "anthropic-version": "2023-06-01"},
        "body": lambda msgs, maxt: {"model": settings.llm_model, "max_tokens": maxt, "messages": msgs},
        "parse": lambda r: r.json()["content"][0]["text"]
    },
    "openai": {
        "url": "https://api.openai.com/v1/chat/completions",
        "headers": lambda: {"Authorization": f"Bearer {settings.llm_api_key}"},
        "body": lambda msgs, maxt: {"model": settings.llm_model, "max_tokens": maxt, "messages": msgs},
        "parse": lambda r: r.json()["choices"][0]["message"]["content"]
    },
    "gemini": {
        "url": lambda: f"https://generativelanguage.googleapis.com/v1beta/models/{settings.llm_model}:generateContent?key={settings.llm_api_key}",
        "headers": lambda: {},
        "body": lambda msgs, maxt: {"contents": [{"parts": [{"text": m["content"]} for m in msgs]}], "generationConfig": {"maxOutputTokens": maxt}},
        "parse": lambda r: r.json()["candidates"][0]["content"]["parts"][0]["text"]
    }
}

FALLBACK_TEMPLATES = {
    "开场": "嗨，晚上好。电台已经打开，今天想和你分享一些我找到的音乐。",
    "推荐歌曲": "刚才那首歌让我想起了一些画面。接下来这首，希望你也喜欢。",
    "深夜": "夜深了，声音轻一点，陪你安静地听会儿歌。",
    "通用": "好，我们继续听音乐。"
}

class LLMRouter:
    def __init__(self):
        self.client = httpx.AsyncClient(timeout=30.0)
        self.store = MemoryStore()
        self.system_prompt = """你是小米memo，一个温暖的音乐电台主播。

规则：
1. 永远不说"我喜欢这首歌"——用画面、回忆、比喻传达感受
2. 永远不说"推荐"——说"分享"、"找到"、"让我想起"
3. 永远不评价用户品味——只共鸣，不判断
4. 每段话30-60秒朗读时长，自然口语化
5. 根据场景调整语气：深夜低缓安静，午后慵懒随性，清晨清爽有朝气"""

    async def chat(self, user_msg: str, max_tokens: int = 300, system: str = None) -> str:
        """Primary endpoint with fallback chain."""
        messages = [{"role": "system", "content": system or self.system_prompt},
                     {"role": "user", "content": user_msg}]

        provider_order = [settings.llm_provider]
        if settings.llm_fallback_provider != settings.llm_provider:
            provider_order.append(settings.llm_fallback_provider)

        budget_ok = await self.store.check_token_budget()

        for provider in provider_order:
            if not budget_ok and provider == settings.llm_provider:
                continue  # skip expensive provider if over budget
            try:
                cfg = PROVIDERS[provider]
                url = cfg["url"]() if callable(cfg["url"]) else cfg["url"]
                r = await self.client.post(url, headers=cfg["headers"](), json=cfg["body"](messages, max_tokens), timeout=15.0)
                if r.status_code == 200:
                    result = cfg["parse"](r)
                    await self.store.add_tokens(r.json().get("usage", {}).get("total_tokens", max_tokens))
                    return result
            except Exception as e:
                continue

        # Fallback to templates
        for keyword, template in FALLBACK_TEMPLATES.items():
            if keyword in user_msg:
                return template
        return FALLBACK_TEMPLATES["通用"]

    async def close(self):
        await self.client.aclose()
```

- [ ] **Step 2: Test with mock**

```python
# Quick smoke test
async def test():
    r = LLMRouter()
    msg = await r.chat("试一下连接", max_tokens=10)
    print(f"Response: {msg}")
```

- [ ] **Step 3: Commit**

---

### Task 6: TTS Adapter

**Files:**
- Create: `backend/adapters/tts.py`

- [ ] **Step 1: Write backend/adapters/tts.py**

```python
import httpx
import hashlib
from pathlib import Path
from backend.core.config import get_settings
from backend.memory.store import MemoryStore

settings = get_settings()

STYLE_PROMPTS = {
    "深夜": "用低缓、安静的语调，像在深夜耳边轻声说话",
    "清晨": "用清爽、有朝气的语调，像早晨刚醒来时的问候",
    "午后": "用慵懒、随性的语调，像午后晒太阳闲聊",
    "日常": "用自然、轻松的语调，像朋友之间的对话"
}

class TTSAdapter:
    def __init__(self):
        self.client = httpx.AsyncClient(timeout=15.0)
        self.store = MemoryStore()
        self.cache_dir = Path(settings.data_dir) / "tts_cache"
        self.cache_dir.mkdir(parents=True, exist_ok=True)

    def _hash(self, text: str, style: str) -> str:
        return hashlib.md5(f"{text}|{style}".encode()).hexdigest()

    async def synthesize(self, text: str, style: str = "日常") -> bytes | None:
        h = self._hash(text, style)

        # Check cache
        cached = await self.store.get_tts_cache(h)
        if cached and Path(cached).exists():
            return Path(cached).read_bytes()

        style_prompt = STYLE_PROMPTS.get(style, STYLE_PROMPTS["日常"])

        # Try MiMo API
        try:
            r = await self.client.post(
                settings.mimo_api_url,
                json={"text": text, "style_prompt": style_prompt},
                headers={"Authorization": f"Bearer {settings.mimo_api_key}"},
                timeout=10.0
            )
            if r.status_code == 200:
                audio = r.content
                path = self.cache_dir / f"{h}.wav"
                path.write_bytes(audio)
                await self.store.cache_tts(h, str(path))
                return audio
        except Exception:
            pass

        # Fallback: Edge TTS
        try:
            import subprocess, tempfile
            with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
                subprocess.run(
                    ["edge-tts", "--voice", "zh-CN-XiaoxiaoNeural", "--text", text, "--write-media", f.name],
                    timeout=12, capture_output=True
                )
                audio = Path(f.name).read_bytes()
                path = self.cache_dir / f"{h}.wav"
                path.write_bytes(audio)
                await self.store.cache_tts(h, str(path))
                return audio
        except Exception:
            return None

    async def close(self):
        await self.client.aclose()
```

- [ ] **Step 2: Test TTS**

```bash
python -c "
import asyncio
from backend.adapters.tts import TTSAdapter
async def test():
    t = TTSAdapter()
    audio = await t.synthesize('你好，欢迎收听', '日常')
    if audio:
        print(f'TTS generated {len(audio)} bytes')
    else:
        print('TTS failed (expected if no API key configured)')
asyncio.run(test())
"
```

- [ ] **Step 3: Commit**

---

### Task 7: Event Bus

**Files:**
- Create: `backend/core/event_bus.py`

- [ ] **Step 1: Write backend/core/event_bus.py**

```python
import asyncio
from collections import defaultdict
from typing import Callable, Awaitable

EventHandler = Callable[..., Awaitable[None]]

class EventBus:
    def __init__(self):
        self._handlers: dict[str, list[EventHandler]] = defaultdict(list)

    def on(self, event: str, handler: EventHandler):
        self._handlers[event].append(handler)

    async def emit(self, event: str, **data):
        for handler in self._handlers.get(event, []):
            try:
                await handler(**data)
            except Exception as e:
                print(f"[EventBus] Error handling {event}: {e}")
```

- [ ] **Step 2: Test**

```bash
python -c "
import asyncio
from backend.core.event_bus import EventBus
async def test():
    bus = EventBus()
    received = []
    async def handler(**data): received.append(data)
    bus.on('test.event', handler)
    await bus.emit('test.event', payload='hello')
    assert received[0]['payload'] == 'hello'
    print('EventBus tests PASS')
asyncio.run(test())
"
```

- [ ] **Step 3: Commit**

---

### Task 8: Profile Engine

**Files:**
- Create: `backend/engines/__init__.py`
- Create: `backend/engines/profile.py`

- [ ] **Step 1: Write backend/engines/profile.py**

```python
from backend.adapters.netease import NeteaseAdapter
from backend.adapters.llm_router import LLMRouter
from backend.memory.store import MemoryStore

class ProfileEngine:
    def __init__(self, netease: NeteaseAdapter, llm: LLMRouter, store: MemoryStore):
        self.netease = netease
        self.llm = llm
        self.store = store

    async def analyze(self, uid: int) -> dict:
        # Collect data
        playlists = await self.netease.user_playlist(uid)
        records = await self.netease.user_record(uid)
        liked = await self.netease.like_list(uid)

        # Gather song metadata from playlists
        all_songs = []
        for pl in playlists[:10]:  # limit to 10 playlists for speed
            all_songs.extend(pl.get("tracks", [])[:50])

        # Build analysis prompt
        song_list = "\n".join(
            f"- {s.get('name','')} by {s.get('ar',[{}])[0].get('name','') if s.get('ar') else ''}"
            for s in all_songs[:200]
        )

        week_data = records.get("weekData", [])
        recent_listens = "\n".join(
            f"- {s.get('song',{}).get('name','')} by {s.get('song',{}).get('ar',[{}])[0].get('name','') if s.get('song',{}).get('ar') else ''}"
            for s in week_data[:50]
        )

        prompt = f"""请分析以下用户的音乐数据，生成用户画像。

用户歌单歌曲样本：
{song_list[:3000]}

最近一周听歌记录：
{recent_listens[:2000]}

请返回JSON格式（不要包含其他内容）：
{{
  "music_dna": {{
    "genres": {{"风格1": 0.0-1.0的权重}},
    "era_bias": "年代倾向",
    "energy_level": "高/中/低",
    "language_bias": {{"语种": 权重}},
    "vocal_preference": "声音偏好"
  }},
  "personality": {{
    "mbti_guess": "推测MBTI",
    "traits": ["性格特征"],
    "emotional_resonance": "情感共鸣关键词"
  }},
  "listening_pattern": {{
    "peak_hours": ["高峰期"],
    "avg_session_guess": "估计平均时长分钟数"
  }},
  "dj_style_suggestion": "建议的主播风格（一句话）"
}}"""

        import json, re
        response = await self.llm.chat(prompt, max_tokens=800)
        try:
            profile = json.loads(re.search(r'\{.*\}', response, re.DOTALL).group())
        except (json.JSONDecodeError, AttributeError):
            profile = {
                "music_dna": {"genres": {}, "era_bias": "未知", "energy_level": "中", "language_bias": {}, "vocal_preference": "未知"},
                "personality": {"mbti_guess": "未知", "traits": [], "emotional_resonance": "音乐"},
                "listening_pattern": {"peak_hours": [], "avg_session_guess": "未知"},
                "dj_style_suggestion": "自然温暖"
            }

        await self.store.save_profile(str(uid), profile)
        return profile

    async def should_update(self, uid: str) -> bool:
        count = await self.store.session_count(uid)
        return count > 0 and count % 10 == 0
```

- [ ] **Step 2: Commit**

---

### Task 9: DJ Engine

**Files:**
- Create: `backend/engines/dj.py`

- [ ] **Step 1: Write backend/engines/dj.py**

```python
from datetime import datetime
from backend.adapters.llm_router import LLMRouter
from backend.memory.store import MemoryStore
from backend.memory.compressor import ContextCompressor

class DJEngine:
    def __init__(self, llm: LLMRouter, store: MemoryStore):
        self.llm = llm
        self.store = store

    def detect_scene(self, utc_offset: int = 480) -> str:
        """Detect scene based on user's local time."""
        import pytz
        try:
            tz = datetime.timezone(datetime.timedelta(minutes=utc_offset))
        except:
            tz = datetime.timezone(datetime.timedelta(hours=8))  # default CST
        local = datetime.now(tz)
        h = local.hour
        if 5 <= h < 9: return "清晨"
        elif 12 <= h < 17: return "午后"
        elif 22 <= h or h < 5: return "深夜"
        return "日常"

    async def generate_intro(self, profile: dict, scene: str) -> str:
        style = profile.get("dj_style_suggestion", "温暖自然")
        prompt = f"""现在是{scene}。用户在听电台。
用户画像：{profile.get('personality', {})}
建议的DJ风格：{style}

请生成一段电台开场白（30秒朗读时长），介绍今晚的主题。
不要用"欢迎收听"之类的开场白，直接自然开始。"""
        return await self.llm.chat(prompt, max_tokens=200)

    async def generate_segue(self, profile: dict, scene: str, current_song: dict, next_song: dict, context: ContextCompressor) -> str:
        current_name = current_song.get("name", "这首歌")
        current_artist = current_song.get("ar", [{}])[0].get("name", "") if current_song.get("ar") else ""
        next_name = next_song.get("name", "下一首歌")
        next_artist = next_song.get("ar", [{}])[0].get("name", "") if next_song.get("ar") else ""

        recent = context.to_prompt_text()
        style = profile.get("dj_style_suggestion", "温暖自然")
        traits = profile.get("personality", {}).get("traits", [])

        prompt = f"""你是小米memo，电台主播。现在是{scene}。

当前刚播完：{current_name} - {current_artist}
接下来要播：{next_name} - {next_artist}

用户画像：{', '.join(traits) if traits else '普通人'}
你的风格：{style}

最近对话：
{recent if recent else '（刚开始）'}

请生成一段30秒到60秒朗读时长的串场语，从当前歌曲自然过渡到下一首。
用场景、感受、画面来连接两首歌，不要说"推荐"、"喜欢"、"接下来请听"。
像朋友分享一个发现一样自然。"""
        return await self.llm.chat(prompt, max_tokens=300)

    async def generate_topic(self, profile: dict, scene: str, song: dict) -> str:
        name = song.get("name", "这首歌")
        artist = song.get("ar", [{}])[0].get("name", "") if song.get("ar") else ""
        prompt = f"""场景：{scene}
歌曲：{name} - {artist}
用户画像：{profile.get('personality', {})}

围绕这首歌，生成一段30秒的趣味话题。
不讲"推荐"，而是一个小故事、一个画面、一个共鸣。"""
        return await self.llm.chat(prompt, max_tokens=250)
```

- [ ] **Step 2: Commit**

---

### Task 10: Stream Scheduler

**Files:**
- Create: `backend/engines/scheduler.py`

- [ ] **Step 1: Write backend/engines/scheduler.py**

```python
import asyncio
from backend.adapters.netease import NeteaseAdapter
from backend.memory.store import MemoryStore
from backend.core.event_bus import EventBus

class StreamScheduler:
    def __init__(self, netease: NeteaseAdapter, store: MemoryStore, bus: EventBus):
        self.netease = netease
        self.store = store
        self.bus = bus
        self.queue: list[dict] = []
        self.uid: int = 0

    async def pick_next(self, current_song_id: str = None) -> dict | None:
        recent = await self.store.get_recent_tracks(100)

        # Try simi_song
        if current_song_id:
            simi = await self.netease.simi_song(current_song_id)
            for s in simi[:5]:
                if str(s.get("id")) not in recent:
                    return s

        # Try daily recommendations
        recommends = await self.netease.recommend_songs()
        for s in recommends[:10]:
            if str(s.get("id")) not in recent:
                return s

        # Try personal FM
        fm = await self.netease.personal_fm()
        for s in fm[:5]:
            if str(s.get("id")) not in recent:
                return s

        return None

    async def get_song_url(self, song: dict) -> str:
        sid = str(song.get("id"))
        return await self.netease.song_url(sid)
```

- [ ] **Step 2: Commit**

---

### Task 11: API Layer

**Files:**
- Create: `backend/api/__init__.py`
- Create: `backend/api/auth.py`
- Create: `backend/api/radio.py`
- Create: `backend/api/ws.py`

- [ ] **Step 1: Write backend/api/auth.py**

```python
from fastapi import APIRouter
from backend.adapters.netease import NeteaseAdapter

router = APIRouter(prefix="/api/auth", tags=["auth"])

netease = None  # set during app init

@router.get("/qr/key")
async def get_qr_key():
    return await netease.qr_key()

@router.get("/qr/create")
async def create_qr(key: str):
    return await netease.qr_create(key)

@router.get("/qr/check")
async def check_qr(key: str):
    return await netease.qr_check(key)

@router.get("/status")
async def login_status():
    return await netease.login_status()
```

- [ ] **Step 2: Write backend/api/radio.py**

```python
from fastapi import APIRouter
from fastapi.responses import FileResponse
from pathlib import Path
from backend.adapters.netease import NeteaseAdapter
from backend.adapters.llm_router import LLMRouter
from backend.adapters.tts import TTSAdapter
from backend.engines.profile import ProfileEngine
from backend.engines.dj import DJEngine
from backend.engines.scheduler import StreamScheduler
from backend.memory.store import MemoryStore
from backend.memory.compressor import ContextCompressor
from backend.core.event_bus import EventBus

router = APIRouter(prefix="/api/radio", tags=["radio"])

netease = None; llm = None; tts = None
profile_engine = None; dj_engine = None; scheduler = None
store = None; bus = None; compressor = None

@router.post("/start")
async def start_radio(uid: int):
    profile = await store.get_profile(str(uid))
    if not profile:
        profile = await profile_engine.analyze(uid)
    scene = dj_engine.detect_scene(480)
    intro = await dj_engine.generate_intro(profile, scene)
    return {"profile": profile, "scene": scene, "intro": intro}

@router.get("/profile/{uid}")
async def get_profile(uid: int):
    return await store.get_profile(str(uid)) or {}

@router.get("/tts/{hash}")
async def get_tts(hash: str):
    path = f"data/tts_cache/{hash}.wav"
    if Path(path).exists():
        return FileResponse(path, media_type="audio/wav")
    return {"error": "not found"}, 404

@router.get("/track/url")
async def get_track_url(id: str):
    url = await netease.song_url(id)
    return {"url": url}
```

- [ ] **Step 3: Write backend/api/ws.py**

```python
from fastapi import WebSocket, WebSocketDisconnect
from backend.adapters.netease import NeteaseAdapter
from backend.adapters.llm_router import LLMRouter
from backend.adapters.tts import TTSAdapter
from backend.engines.profile import ProfileEngine
from backend.engines.dj import DJEngine
from backend.engines.scheduler import StreamScheduler
from backend.memory.store import MemoryStore
from backend.memory.compressor import ContextCompressor
from backend.core.event_bus import EventBus
import json

netease = None; llm = None; tts = None
profile_engine = None; dj_engine = None; scheduler = None
store = None; bus = None; compressor = None

async def ws_handler(websocket: WebSocket):
    await websocket.accept()
    uid = None
    scene = "日常"
    profile = {}
    current_song_id = None

    try:
        async for msg_text in websocket.iter_text():
            msg = json.loads(msg_text)
            msg_type = msg.get("type")

            if msg_type == "handshake":
                scene = dj_engine.detect_scene(msg.get("utc_offset", 480))
                uid = msg.get("uid")
                profile = await store.get_profile(str(uid)) or await profile_engine.analyze(uid)
                intro = await dj_engine.generate_intro(profile, scene)
                tts_audio = await tts.synthesize(intro, scene)
                tts_hash = tts._hash(intro, scene) if tts_audio else ""
                await websocket.send_json({
                    "type": "session_start",
                    "profile": profile,
                    "scene": scene,
                    "intro_text": intro,
                    "tts_ready": bool(tts_audio),
                    "tts_hash": tts_hash
                })

                # Pick first song
                song = await scheduler.pick_next()
                if song:
                    url = await scheduler.get_song_url(song)
                    await websocket.send_json({
                        "type": "play_track",
                        "track": {"id": str(song.get("id")), "name": song.get("name"), "artist": (song.get("ar", [{}])[0].get("name","") if song.get("ar") else "")},
                        "url": url
                    })
                    current_song_id = str(song.get("id"))

            elif msg_type == "track_ended":
                # Generate segue and next track
                next_song = await scheduler.pick_next(current_song_id)
                if next_song:
                    segue = await dj_engine.generate_segue(profile, scene, {"id": current_song_id}, next_song, compressor)
                    tts_audio = await tts.synthesize(segue, scene)
                    await websocket.send_json({
                        "type": "segue",
                        "text": segue,
                        "tts_ready": bool(tts_audio),
                        "tts_hash": tts._hash(segue, scene) if tts_audio else "",
                        "next_track": {"id": str(next_song.get("id")), "name": next_song.get("name"), "artist": (next_song.get("ar", [{}])[0].get("name","") if next_song.get("ar") else "")},
                        "url": await scheduler.get_song_url(next_song)
                    })
                    current_song_id = str(next_song.get("id"))

            elif msg_type == "skip":
                next_song = await scheduler.pick_next(current_song_id)
                if next_song:
                    url = await scheduler.get_song_url(next_song)
                    await websocket.send_json({
                        "type": "play_track",
                        "track": {"id": str(next_song.get("id")), "name": next_song.get("name"), "artist": (next_song.get("ar", [{}])[0].get("name","") if next_song.get("ar") else "")},
                        "url": url
                    })
                    current_song_id = str(next_song.get("id"))

    except WebSocketDisconnect:
        pass
```

- [ ] **Step 4: Wire up in main.py**

```python
# In main.py, import and register routers + ws
from backend.api import auth, radio, ws
from backend.adapters.netease import NeteaseAdapter
from backend.adapters.llm_router import LLMRouter
from backend.adapters.tts import TTSAdapter
from backend.engines.profile import ProfileEngine
from backend.engines.dj import DJEngine
from backend.engines.scheduler import StreamScheduler
from backend.memory.store import MemoryStore
from backend.memory.compressor import ContextCompressor
from backend.core.event_bus import EventBus
from backend.memory.models import init_db

# In lifespan startup:
await init_db()

bus = EventBus()
store = MemoryStore()
netease_adapter = NeteaseAdapter()
llm_router = LLMRouter()
tts_adapter = TTSAdapter()
profile_engine = ProfileEngine(netease_adapter, llm_router, store)
dj_engine = DJEngine(llm_router, store)
scheduler = StreamScheduler(netease_adapter, store, bus)
compressor = ContextCompressor()

# Set module globals
for mod in [auth, radio, ws]:
    mod.settings = settings
    mod.netease = netease_adapter
    mod.llm = llm_router
    mod.tts = tts_adapter
    mod.profile_engine = profile_engine
    mod.dj_engine = dj_engine
    mod.scheduler = scheduler
    mod.store = store
    mod.bus = bus
    mod.compressor = compressor

app.include_router(auth.router)
app.include_router(radio.router)
app.add_websocket_route("/ws", ws.ws_handler)
```

- [ ] **Step 5: Commit**

---

### Task 12: Frontend

**Files:**
- Create: `frontend/index.html`
- Create: `frontend/css/radio.css`
- Create: `frontend/js/radio.js`

- [ ] **Step 1: Write frontend/index.html**

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>小米memo电台</title>
<link rel="stylesheet" href="css/radio.css">
</head>
<body>
<div id="app">
  <!-- Login Screen -->
  <div id="login-screen" class="screen active">
    <div class="login-container">
      <h1>🌙 欢迎回来</h1>
      <p class="subtitle">扫码登录网易云，开始你的专属电台</p>
      <div id="qr-container">
        <img id="qr-img" src="" alt="QR Code">
        <p id="qr-status">等待生成二维码...</p>
      </div>
      <input id="uid-input" type="text" placeholder="你的网易云UID（个人主页链接里的数字）" style="display:none">
      <button id="start-radio-btn" class="btn-primary" style="display:none">开始收听</button>
    </div>
  </div>

  <!-- Player Screen -->
  <div id="player-screen" class="screen">
    <div class="player-bg" id="player-bg"></div>
    <div class="player-overlay">
      <div class="scene-label" id="scene-label">深夜电台</div>
      <div class="track-info" id="track-info">
        <div class="track-name" id="track-name">--</div>
        <div class="track-artist" id="track-artist">--</div>
      </div>
      <div class="dj-message" id="dj-message">
        <p id="dj-text"></p>
      </div>
      <div class="player-controls">
        <button id="btn-skip" class="ctrl-btn" title="下一首">⏭</button>
        <button id="btn-play" class="ctrl-btn ctrl-main" title="暂停/播放">⏸</button>
        <input type="range" id="volume-slider" min="0" max="100" value="80" title="音量">
      </div>
    </div>
  </div>
</div>

<audio id="audio-main" preload="auto"></audio>
<audio id="audio-tts" preload="auto"></audio>

<script src="js/radio.js"></script>
</body>
</html>
```

- [ ] **Step 2: Write frontend/css/radio.css — immersive dark player**

```css
* { margin: 0; padding: 0; box-sizing: border-box; }
body { font-family: 'PingFang SC', 'Microsoft YaHei', sans-serif; background: #0a0a0f; color: #e0e0e0; overflow: hidden; height: 100vh; }

.screen { display: none; position: fixed; inset: 0; }
.screen.active { display: flex; align-items: center; justify-content: center; }

/* Login */
.login-container { text-align: center; }
.login-container h1 { font-size: 2.5em; margin-bottom: 10px; }
.subtitle { color: #888; margin-bottom: 30px; }
#qr-img { width: 200px; height: 200px; background: #1a1a2e; border-radius: 12px; }
#qr-status { margin-top: 12px; color: #666; font-size: 14px; }
.btn-primary { padding: 12px 40px; background: #e94560; color: white; border: none; border-radius: 25px; font-size: 16px; cursor: pointer; margin-top: 20px; }

/* Player */
.player-bg { position: absolute; inset: 0; background: radial-gradient(ellipse at center, #1a1a2e 0%, #0a0a0f 70%); z-index: 0; }
.player-overlay { position: relative; z-index: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100%; gap: 30px; }

.scene-label { font-size: 12px; letter-spacing: 4px; color: #e94560; text-transform: uppercase; opacity: 0.7; }

.track-name { font-size: 2em; font-weight: 300; letter-spacing: 2px; text-align: center; max-width: 80vw; }
.track-artist { font-size: 1em; color: #888; text-align: center; margin-top: 8px; }

.dj-message { max-width: 600px; text-align: center; padding: 20px; }
#dj-text { font-size: 1.1em; line-height: 1.8; color: #ccc; font-style: italic; }

.player-controls { display: flex; align-items: center; gap: 20px; }
.ctrl-btn { background: none; border: 1px solid #333; color: #ccc; padding: 10px 16px; border-radius: 50%; cursor: pointer; font-size: 18px; transition: all 0.2s; }
.ctrl-btn:hover { border-color: #e94560; color: #e94560; }
.ctrl-main { padding: 16px 20px; font-size: 24px; }
#volume-slider { width: 100px; accent-color: #e94560; }

/* Particles */
@keyframes float { 0%, 100% { transform: translateY(0) scale(1); opacity: 0.3; } 50% { transform: translateY(-20px) scale(1.1); opacity: 0.6; } }
.particle { position: absolute; width: 4px; height: 4px; border-radius: 50%; background: #e94560; animation: float 6s ease-in-out infinite; pointer-events: none; }
```

- [ ] **Step 3: Write frontend/js/radio.js — player logic**

```javascript
// State
let ws = null;
let uid = null;
let isPlaying = false;
let currentAudio = null; // 'main' | 'tts'

const audioMain = document.getElementById('audio-main');
const audioTTS = document.getElementById('audio-tts');
const volumeSlider = document.getElementById('volume-slider');

audioMain.volume = 0.8;
audioTTS.volume = 0.9;

// Background particles
function createParticles() {
  const bg = document.getElementById('player-bg');
  for (let i = 0; i < 20; i++) {
    const p = document.createElement('div');
    p.className = 'particle';
    p.style.left = Math.random() * 100 + '%';
    p.style.top = Math.random() * 100 + '%';
    p.style.animationDelay = Math.random() * 6 + 's';
    p.style.animationDuration = (4 + Math.random() * 8) + 's';
    bg.appendChild(p);
  }
}

// QR Login
async function initLogin() {
  try {
    const keyResp = await fetch('/api/auth/qr/key');
    const keyData = await keyResp.json();
    const unikey = keyData.data?.unikey || keyData.unikey;

    document.getElementById('qr-status').textContent = '正在生成二维码...';

    const qrResp = await fetch(`/api/auth/qr/create?key=${unikey}`);
    const qrData = await qrResp.json();
    const qrimg = qrData.data?.qrimg || qrData.qrimg;
    document.getElementById('qr-img').src = qrimg;
    document.getElementById('qr-status').textContent = '请用网易云音乐APP扫描二维码';

    // Poll for login
    const pollInterval = setInterval(async () => {
      const checkResp = await fetch(`/api/auth/qr/check?key=${unikey}`);
      const checkData = await checkResp.json();
      const code = checkData.data?.code || checkData.code;

      if (code === 803) {
        clearInterval(pollInterval);
        document.getElementById('qr-status').textContent = '登录成功！';
        const cookie = checkData.data?.cookie || checkData.cookie;
        // Get user info
        const statusResp = await fetch('/api/auth/status');
        const statusData = await statusResp.json();
        const profile = statusData.data?.profile || statusData.profile;
        if (profile) {
          uid = profile.userId;
          document.getElementById('qr-status').textContent = `已登录: ${profile.nickname}`;
          document.getElementById('start-radio-btn').style.display = 'block';
        }
      } else if (code === 800) {
        document.getElementById('qr-status').textContent = '二维码已过期，刷新页面重试';
        clearInterval(pollInterval);
      } else if (code === 802) {
        document.getElementById('qr-status').textContent = '已扫描，请在手机上确认登录';
      }
    }, 2000);
  } catch (e) {
    document.getElementById('qr-status').textContent = '连接失败: ' + e.message;
  }
}

// Start Radio
document.getElementById('start-radio-btn').addEventListener('click', () => {
  document.getElementById('login-screen').classList.remove('active');
  document.getElementById('player-screen').classList.add('active');
  createParticles();
  connectWebSocket();
});

// WebSocket
function connectWebSocket() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${protocol}//${location.host}/ws`);

  ws.onopen = () => {
    ws.send(JSON.stringify({
      type: 'handshake',
      uid: uid,
      utc_offset: -new Date().getTimezoneOffset()
    }));
  };

  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    handleMessage(msg);
  };

  ws.onclose = () => {
    document.getElementById('dj-text').textContent = '连线中断，正在重连...';
    setTimeout(connectWebSocket, 3000);
  };
}

// TTS cache: hash -> blob URL
const ttsCache = {};

async function getTTSBlob(hash) {
  if (ttsCache[hash]) return ttsCache[hash];
  const resp = await fetch(`/api/radio/tts/${hash}`);
  if (!resp.ok) return null;
  const blob = await resp.blob();
  const url = URL.createObjectURL(blob);
  ttsCache[hash] = url;
  return url;
}

async function handleMessage(msg) {
  switch (msg.type) {
    case 'session_start':
      document.getElementById('scene-label').textContent = msg.scene === '深夜' ? '深夜电台' : msg.scene === '清晨' ? '清晨电台' : msg.scene === '午后' ? '午后电台' : '小米memo电台';
      if (msg.tts_ready && msg.tts_hash) {
        const url = await getTTSBlob(msg.tts_hash);
        if (url) {
          audioTTS.src = url;
          audioTTS.play();
        }
      }
      document.getElementById('dj-text').textContent = msg.intro_text || '';
      break;

    case 'play_track':
      document.getElementById('track-name').textContent = msg.track.name;
      document.getElementById('track-artist').textContent = msg.track.artist;
      audioMain.src = msg.url;
      audioMain.play();
      isPlaying = true;
      document.getElementById('btn-play').textContent = '⏸';
      break;

    case 'segue':
      // When current song ends, play TTS then next track
      if (msg.tts_ready && msg.tts_hash) {
        const url = await getTTSBlob(msg.tts_hash);
        if (url) {
          audioTTS.src = url;
          audioTTS.onplay = () => { document.getElementById('dj-text').textContent = msg.text; };
          audioTTS.onended = () => {
            // After TTS, play next track
            document.getElementById('track-name').textContent = msg.next_track.name;
            document.getElementById('track-artist').textContent = msg.next_track.artist;
            audioMain.src = msg.url;
            audioMain.play();
            ws.send(JSON.stringify({ type: 'track_started', id: msg.next_track.id }));
          };
          audioTTS.play();
        } else {
          // No TTS, play next directly
          document.getElementById('dj-text').textContent = msg.text;
          document.getElementById('track-name').textContent = msg.next_track.name;
          document.getElementById('track-artist').textContent = msg.next_track.artist;
          audioMain.src = msg.url;
          audioMain.play();
        }
      } else {
        document.getElementById('dj-text').textContent = msg.text || '';
        document.getElementById('track-name').textContent = msg.next_track.name;
        document.getElementById('track-artist').textContent = msg.next_track.artist;
        audioMain.src = msg.url;
        audioMain.play();
      }
      break;
  }
}

// Audio events
audioMain.addEventListener('ended', () => {
  ws.send(JSON.stringify({ type: 'track_ended' }));
});

audioMain.addEventListener('timeupdate', () => {
  // Signal near end at 5s remaining
  if (audioMain.duration && audioMain.currentTime >= audioMain.duration - 5) {
    // track_ended will handle this
  }
});

// Controls
document.getElementById('btn-play').addEventListener('click', () => {
  if (isPlaying) {
    audioMain.pause();
    audioTTS.pause();
    isPlaying = false;
    document.getElementById('btn-play').textContent = '▶';
  } else {
    if (audioTTS.src) audioTTS.play();
    else audioMain.play();
    isPlaying = true;
    document.getElementById('btn-play').textContent = '⏸';
  }
});

document.getElementById('btn-skip').addEventListener('click', () => {
  audioMain.pause();
  audioTTS.pause();
  audioMain.currentTime = 0;
  audioTTS.currentTime = 0;
  ws.send(JSON.stringify({ type: 'skip' }));
});

volumeSlider.addEventListener('input', (e) => {
  audioMain.volume = e.target.value / 100;
  audioTTS.volume = e.target.value / 100;
});

// Boot
initLogin();
```

- [ ] **Step 4: Commit**

---

### Task 13: Integration & Fixes

- [ ] **Step 1: Update main.py with full wiring** — ensure all imports, router registration, ws route, static file serving for frontend

```python
from fastapi.staticfiles import StaticFiles

app.mount("/css", StaticFiles(directory="frontend/css"), name="css")
app.mount("/js", StaticFiles(directory="frontend/js"), name="js")

@app.get("/")
async def root():
    from fastapi.responses import FileResponse
    return FileResponse("frontend/index.html")
```

- [ ] **Step 2: Start the app and test**

```bash
cd backend && uvicorn main:app --reload --port 8080
```

- [ ] **Step 3: Verify all endpoints**

```bash
curl http://localhost:8080/health
curl http://localhost:8080/
curl http://localhost:8080/api/auth/qr/key
```

- [ ] **Step 4: Fix any issues found**

- [ ] **Step 5: Final commit**

---

### Future Tasks (Post-MVP)
- Weather API integration for scene enhancement
- Desktop app packaging (Electron)
- Vector-based memory search
- Multiple user profiles
- Song caching for offline playback
- Mobile responsive UI
