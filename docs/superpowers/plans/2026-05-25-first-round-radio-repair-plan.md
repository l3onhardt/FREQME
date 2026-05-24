# First-Round Radio Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the first-use radio flow feel coherent and personal: no repeated QR login after refresh, a short onboarding/tuning flow after first login, stable DJ-style voice selection, and a first-pass song picker that mixes familiar anchors with tasteful discoveries.

**Architecture:** Keep the current FastAPI + vanilla frontend + Node NetEase bridge shape. Persist NetEase bridge cookies in the local `data/` directory, persist user onboarding settings in SQLite, make TTS request construction deterministic and user-selectable, and upgrade `StreamScheduler` from a fixed fallback chain into a scored candidate picker using user profile seeds and NetEase recommendation pools.

**Tech Stack:** Python 3.11+, FastAPI, SQLite/aiosqlite, vanilla JS/CSS, Node.js 18+ built-in `node:test`, MiMo OpenAI-compatible chat/TTS API, NetEaseCloudMusicApi.

---

## File Structure

### Existing Files To Modify

- `netease-bridge/server.js`
  - Load/save NetEase cookie from disk.
  - Add playlist detail endpoint.
  - Sanitize login responses so cookie is not echoed to the browser.

- `backend/adapters/netease.py`
  - Add `playlist_detail()`.
  - Add `login_refresh()`.
  - Keep `login_status()` as the backend source of truth for existing login.

- `backend/api/auth.py`
  - Wire `store`.
  - Persist current NetEase account profile after `/api/auth/status`.
  - Add optional logout endpoint if implementation cost stays small.

- `backend/api/radio.py`
  - Add onboarding bootstrap/save endpoints.
  - Keep `/start` backward-compatible.

- `backend/api/ws.py`
  - Send onboarding settings and profile into DJ/TTS/scheduler.
  - Track the full current song object instead of only the id.

- `backend/core/config.py`
  - Add optional TTS voice env names for the three onboarding presets.
  - Add NetEase cookie path config if the Node bridge needs it from env.

- `backend/memory/models.py`
  - Add `auth_account` and `user_settings` tables.

- `backend/memory/store.py`
  - Add CRUD for auth account and user settings.
  - Keep existing profile storage unchanged.

- `backend/engines/profile.py`
  - Fetch playlist details instead of assuming `user_playlist()` includes tracks.
  - Save anchor tracks and discovery seeds in profile JSON.

- `backend/engines/dj.py`
  - Make prompts concise and DJ-like.
  - Include user settings and selection reason.

- `backend/engines/scheduler.py`
  - Collect candidate pools, score them, and return a selected song with selection metadata.
  - Avoid recent songs and repeated artists.

- `backend/adapters/tts.py`
  - Split voice presets from scene guidance.
  - Remove overbearing emotion tags.
  - Build request bodies through testable helpers.

- `frontend/index.html`
  - Add a short onboarding/tuning screen between QR login and player.

- `frontend/css/radio.css`
  - Style the onboarding flow and progress states.

- `frontend/js/radio.js`
  - Check existing login status before creating QR.
  - Drive onboarding bootstrap/save.
  - Send settings to WebSocket handshake.

- `.env.example`
  - Fix `LLM_MODEL`.
  - Add voice preset env examples.

### New Files To Create

- `netease-bridge/auth-state.js`
  - Small testable module for loading/saving/sanitizing auth state.

- `netease-bridge/auth-state.test.mjs`
  - Node built-in tests for cookie persistence and sanitization.

- `tests/python/test_memory_store_settings.py`
  - Python stdlib `unittest` tests for new settings/account persistence.

- `tests/python/test_profile_engine_playlist_detail.py`
  - Tests that profile analysis uses playlist detail tracks and saves anchors.

- `tests/python/test_tts_voice_presets.py`
  - Tests request body construction and cache hash isolation by voice.

- `tests/python/test_scheduler_personalized_pick.py`
  - Tests first-pass “familiar plus discovery” song choice behavior.

### Optional New File

- `backend/engines/voice.py`
  - Only create this if `tts.py` becomes too large. It should hold voice preset labels, keys, and MiMo voice resolution.

---

## First-Round Product Shape

The first round should implement this user experience:

1. User opens the app.
2. Frontend calls `/api/auth/status`.
3. If a valid persisted NetEase login exists, skip QR and show the logged-in nickname.
4. If no valid login exists, show QR. When scan succeeds, bridge persists cookie locally.
5. After login, show a short tuning/onboarding screen.
6. The app analyzes profile in the background and asks exactly three questions:
   - Voice: `夜航女声`, `暖频男声`, `清甜少女声`. All three are framed as warm, magnetic radio-host voices, not character cosplay.
   - Name and notes: “我怎么称呼你？有什么歌单背景或雷区要补充？”
   - Current mode: `放松`, `专注`, `陪伴`, `深夜情绪`.
7. Save answers to SQLite.
8. Start player. WebSocket handshake includes `uid`, `utc_offset`, and onboarding settings.
9. Scheduler starts with a tasteful mix:
   - familiar anchor songs from user playlist/profile,
   - NetEase daily/FM songs,
   - similar-song discoveries,
   - no recent repeats.
10. DJ text references context lightly and avoids “推荐/喜欢/接下来请听”.

---

### Task 1: Add Test Harness And DB Path Safety

**Files:**
- Modify: `.gitignore`
- Modify: `backend/memory/models.py`
- Modify: `backend/memory/store.py`
- Create: `tests/python/test_memory_store_settings.py`

- [ ] **Step 1: Write failing tests for new account/settings persistence**

Before creating tests, update `.gitignore` so docs and tests can be tracked while generated runtime files remain ignored:

```gitignore
# Cache / Data
data/
!data/.gitkeep

# Auto-generated local UI experiments
.superpowers/
logs/
```

Remove the broad `docs/` ignore entry. Keep `.env`, `node_modules/`, Python caches, `.superpowers/`, and `logs/` ignored.

Create `tests/python/test_memory_store_settings.py`:

```python
import asyncio
import json
import os
import tempfile
import unittest
from pathlib import Path


class MemoryStoreSettingsTest(unittest.TestCase):
    def test_saves_and_loads_auth_account_and_user_settings(self):
        with tempfile.TemporaryDirectory() as tmp:
            os.environ["RADIO_DB_PATH"] = str(Path(tmp) / "radio-test.db")

            from backend.memory.models import init_db
            from backend.memory.store import MemoryStore

            async def run():
                await init_db()
                store = MemoryStore()
                await store.save_auth_account(
                    "42",
                    {"userId": 42, "nickname": "阿测", "avatarUrl": "x"},
                )
                await store.save_user_settings(
                    "42",
                    {
                        "display_name": "小林",
                        "voice_preset": "warm_male",
                        "music_notes": "最近想听安静一点",
                        "current_mode": "专注",
                    },
                )

                account = await store.get_auth_account("42")
                settings = await store.get_user_settings("42")

                self.assertEqual(account["nickname"], "阿测")
                self.assertEqual(settings["display_name"], "小林")
                self.assertEqual(settings["voice_preset"], "warm_male")
                self.assertEqual(settings["current_mode"], "专注")

            asyncio.run(run())


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run test and verify it fails**

Run:

```powershell
python -m unittest tests.python.test_memory_store_settings -v
```

Expected: FAIL because `RADIO_DB_PATH`, `auth_account`, `user_settings`, and store methods do not exist yet.

- [ ] **Step 3: Make DB path configurable without breaking production**

Modify `backend/memory/models.py`:

```python
import os

DB_PATH = os.getenv("RADIO_DB_PATH", "data/radio.db")
```

Keep the existing production default.

- [ ] **Step 4: Add tables**

In `init_db()` add:

```sql
CREATE TABLE IF NOT EXISTS auth_account (
    uid TEXT PRIMARY KEY,
    account_json TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS user_settings (
    uid TEXT PRIMARY KEY,
    settings_json TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);
```

- [ ] **Step 5: Add store methods**

Modify `backend/memory/store.py`:

```python
    async def save_auth_account(self, uid: str, account: dict) -> None:
        async with aiosqlite.connect(DB_PATH) as db:
            await db.execute(
                "INSERT INTO auth_account (uid, account_json, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) "
                "ON CONFLICT(uid) DO UPDATE SET account_json=excluded.account_json, updated_at=CURRENT_TIMESTAMP",
                (uid, json.dumps(account, ensure_ascii=False)),
            )
            await db.commit()

    async def get_auth_account(self, uid: str) -> dict | None:
        async with aiosqlite.connect(DB_PATH) as db:
            async with db.execute("SELECT account_json FROM auth_account WHERE uid=?", (uid,)) as cursor:
                row = await cursor.fetchone()
                return json.loads(row[0]) if row else None

    async def save_user_settings(self, uid: str, settings: dict) -> None:
        async with aiosqlite.connect(DB_PATH) as db:
            await db.execute(
                "INSERT INTO user_settings (uid, settings_json, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) "
                "ON CONFLICT(uid) DO UPDATE SET settings_json=excluded.settings_json, updated_at=CURRENT_TIMESTAMP",
                (uid, json.dumps(settings, ensure_ascii=False)),
            )
            await db.commit()

    async def get_user_settings(self, uid: str) -> dict | None:
        async with aiosqlite.connect(DB_PATH) as db:
            async with db.execute("SELECT settings_json FROM user_settings WHERE uid=?", (uid,)) as cursor:
                row = await cursor.fetchone()
                return json.loads(row[0]) if row else None
```

- [ ] **Step 6: Run test and verify it passes**

Run:

```powershell
python -m unittest tests.python.test_memory_store_settings -v
```

Expected: PASS.

- [ ] **Step 7: Commit**

```powershell
git add .gitignore backend/memory/models.py backend/memory/store.py tests/python/test_memory_store_settings.py
git commit -m "test: add persistence coverage for account and onboarding settings"
```

---

### Task 2: Persist NetEase Login And Skip QR On Refresh

**Files:**
- Create: `netease-bridge/auth-state.js`
- Create: `netease-bridge/auth-state.test.mjs`
- Modify: `netease-bridge/server.js`
- Modify: `backend/adapters/netease.py`
- Modify: `backend/api/auth.py`
- Modify: `backend/main.py`
- Modify: `frontend/js/radio.js`

- [ ] **Step 1: Write failing Node tests for cookie persistence and sanitization**

Create `netease-bridge/auth-state.test.mjs`:

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  loadCookie,
  saveCookie,
  sanitizeLoginBody,
} from './auth-state.js';

test('saveCookie and loadCookie persist a cookie string', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'netease-auth-'));
  const file = path.join(dir, 'cookie.json');

  saveCookie(file, 'MUSIC_U=abc; NMTID=xyz;');

  assert.equal(loadCookie(file), 'MUSIC_U=abc; NMTID=xyz;');
});

test('loadCookie returns empty string when file is missing or invalid', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'netease-auth-'));

  assert.equal(loadCookie(path.join(dir, 'missing.json')), '');

  const badFile = path.join(dir, 'bad.json');
  fs.writeFileSync(badFile, '{bad json', 'utf8');
  assert.equal(loadCookie(badFile), '');
});

test('sanitizeLoginBody removes cookie before response is sent to browser', () => {
  const body = {
    code: 803,
    cookie: 'SECRET',
    data: { code: 803, cookie: 'ALSO_SECRET', profile: { userId: 1 } },
  };

  const clean = sanitizeLoginBody(body);

  assert.equal(clean.cookie, undefined);
  assert.equal(clean.data.cookie, undefined);
  assert.equal(clean.data.profile.userId, 1);
});
```

- [ ] **Step 2: Run test and verify it fails**

Run:

```powershell
node --test netease-bridge/auth-state.test.mjs
```

Expected: FAIL because `auth-state.js` does not exist.

- [ ] **Step 3: Implement `auth-state.js`**

Create `netease-bridge/auth-state.js`:

```javascript
import fs from 'node:fs';
import path from 'node:path';

export function loadCookie(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    return typeof parsed.cookie === 'string' ? parsed.cookie : '';
  } catch {
    return '';
  }
}

export function saveCookie(filePath, cookie) {
  if (!cookie) return;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp`;
  fs.writeFileSync(
    tmpPath,
    JSON.stringify({ cookie, updatedAt: new Date().toISOString() }, null, 2),
    'utf8',
  );
  fs.renameSync(tmpPath, filePath);
}

export function clearCookie(filePath) {
  try {
    fs.rmSync(filePath, { force: true });
  } catch {
    // Best effort local logout cleanup.
  }
}

export function sanitizeLoginBody(body) {
  if (!body || typeof body !== 'object') return body;
  const clean = structuredClone(body);
  delete clean.cookie;
  if (clean.data && typeof clean.data === 'object') {
    delete clean.data.cookie;
  }
  return clean;
}
```

- [ ] **Step 4: Run Node tests and verify they pass**

Run:

```powershell
node --test netease-bridge/auth-state.test.mjs
```

Expected: PASS.

- [ ] **Step 5: Wire cookie persistence in bridge**

Modify `netease-bridge/server.js`:

```javascript
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  clearCookie,
  loadCookie,
  saveCookie,
  sanitizeLoginBody,
} from './auth-state.js';
```

After `const app = express()`:

```javascript
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cookiePath = process.env.NETEASE_COOKIE_PATH || path.join(projectRoot, 'data', 'netease-cookie.json');
let cookie = loadCookie(cookiePath);
```

Replace existing `let cookie = '';`.

In `/login/qr/check`:

```javascript
if (r.body.code === 803 && r.body.cookie) {
  cookie = r.body.cookie;
  saveCookie(cookiePath, cookie);
}
res.json(sanitizeLoginBody(r.body));
```

In `/login/refresh`:

```javascript
if (r.body.cookie) {
  cookie = r.body.cookie;
  saveCookie(cookiePath, cookie);
}
res.json(sanitizeLoginBody(r.body));
```

Add optional logout:

```javascript
app.post('/logout', async (_req, res) => {
  cookie = '';
  clearCookie(cookiePath);
  res.json({ code: 200 });
});
```

- [ ] **Step 6: Add adapter method**

Modify `backend/adapters/netease.py`:

```python
    async def login_refresh(self) -> dict:
        try:
            r = await self.client.get(f"{BASE}/login/refresh", timeout=8.0)
            return r.json()
        except Exception:
            return {"code": -1, "message": "网易云登录刷新失败"}
```

- [ ] **Step 7: Persist account in auth API**

Modify `backend/api/auth.py`:

```python
store = None
```

Replace `login_status()` with:

```python
@router.get("/status")
async def login_status():
    status = await netease.login_status()
    profile = (
        status.get("data", {}).get("profile")
        or status.get("profile")
        or {}
    )
    uid = profile.get("userId")
    if uid and store:
        await store.save_auth_account(str(uid), profile)
    return status
```

Add:

```python
@router.post("/refresh")
async def refresh_login():
    return await netease.login_refresh()
```

Wire in `backend/main.py`:

```python
auth.store = store
```

- [ ] **Step 8: Update frontend startup to check status before QR**

Modify `frontend/js/radio.js`:

```javascript
async function bootAuth() {
  document.getElementById('qr-status').textContent = '正在检查登录状态...';
  try {
    const statusResp = await fetch('/api/auth/status');
    const statusData = await statusResp.json();
    const profile = statusData.data?.profile || statusData.profile;
    if (profile?.userId) {
      uid = profile.userId;
      document.getElementById('qr-status').textContent = `已登录: ${profile.nickname}`;
      await showOnboardingOrStart(profile);
      return;
    }
  } catch {
    // Fall through to QR login.
  }
  initLogin();
}
```

Replace final boot call:

```javascript
bootAuth();
```

Do not call `initLogin()` directly on page load anymore.

- [ ] **Step 9: Run tests and smoke bridge**

Run:

```powershell
node --test netease-bridge/auth-state.test.mjs
python -m unittest tests.python.test_memory_store_settings -v
```

Expected: PASS.

Then start app and verify:

```powershell
python -m uvicorn backend.main:app --port 8080
```

Open `http://localhost:8080`, scan once, refresh. Expected: refresh checks status and does not immediately show QR when the cookie is valid.

- [ ] **Step 10: Commit**

```powershell
git add netease-bridge/auth-state.js netease-bridge/auth-state.test.mjs netease-bridge/server.js backend/adapters/netease.py backend/api/auth.py backend/main.py frontend/js/radio.js
git commit -m "fix: persist NetEase login across refreshes"
```

---

### Task 3: Add First-Time Onboarding And Save User Settings

**Files:**
- Modify: `backend/api/radio.py`
- Modify: `backend/api/ws.py`
- Modify: `frontend/index.html`
- Modify: `frontend/css/radio.css`
- Modify: `frontend/js/radio.js`
- Test: `tests/python/test_memory_store_settings.py`

- [ ] **Step 1: Extend failing settings test for onboarding defaults**

Add to `tests/python/test_memory_store_settings.py`:

```python
    def test_get_user_settings_returns_none_before_onboarding(self):
        with tempfile.TemporaryDirectory() as tmp:
            os.environ["RADIO_DB_PATH"] = str(Path(tmp) / "radio-test.db")

            from backend.memory.models import init_db
            from backend.memory.store import MemoryStore

            async def run():
                await init_db()
                store = MemoryStore()
                self.assertIsNone(await store.get_user_settings("new-user"))

            asyncio.run(run())
```

- [ ] **Step 2: Run test and verify it passes or fails for the right reason**

Run:

```powershell
python -m unittest tests.python.test_memory_store_settings -v
```

Expected: PASS if Task 1 is complete. If it fails, fix Task 1 before continuing.

- [ ] **Step 3: Add radio onboarding endpoints**

Modify `backend/api/radio.py`:

```python
@router.get("/onboarding/{uid}")
async def get_onboarding(uid: int):
    profile = await store.get_profile(str(uid)) or {}
    settings = await store.get_user_settings(str(uid))
    return {
        "profile_ready": bool(profile),
        "profile": profile,
        "settings": settings,
        "onboarded": bool(settings),
    }


@router.post("/onboarding/{uid}")
async def save_onboarding(uid: int, payload: dict):
    allowed_presets = {"warm_female", "warm_male", "bright_girl"}
    voice_preset = payload.get("voice_preset") or "warm_female"
    if voice_preset not in allowed_presets:
        voice_preset = "warm_female"

    settings_payload = {
        "voice_preset": voice_preset,
        "display_name": (payload.get("display_name") or "").strip()[:40],
        "music_notes": (payload.get("music_notes") or "").strip()[:500],
        "current_mode": payload.get("current_mode") or "陪伴",
    }
    await store.save_user_settings(str(uid), settings_payload)
    return {"settings": settings_payload, "onboarded": True}
```

- [ ] **Step 4: Add onboarding screen HTML**

In `frontend/index.html`, between login screen and player screen:

```html
  <div id="onboarding-screen" class="screen">
    <div class="onboarding-panel">
      <div class="scene-label">调频</div>
      <h1>先把这个电台调成你的频率</h1>
      <p id="onboarding-status" class="subtitle">正在读取你的歌单和最近收听...</p>

      <section class="onboarding-step active" data-step="voice">
        <h2>你希望主播是什么声音？</h2>
        <div class="choice-grid" id="voice-options">
          <button class="choice-card selected" data-voice="warm_female">
            <strong>夜航女声</strong>
            <span>成熟、低暖、有磁性</span>
          </button>
          <button class="choice-card" data-voice="warm_male">
            <strong>暖频男声</strong>
            <span>温和、沉稳、不油腻</span>
          </button>
          <button class="choice-card" data-voice="bright_girl">
            <strong>清甜少女声</strong>
            <span>轻亮、亲近、仍然克制</span>
          </button>
        </div>
      </section>

      <section class="onboarding-step" data-step="notes">
        <h2>我怎么称呼你？</h2>
        <input id="display-name-input" class="text-input" maxlength="40" placeholder="比如：小林">
        <textarea id="music-notes-input" class="text-area" maxlength="500" placeholder="有什么歌单背景、最近状态、雷区或偏好可以补充"></textarea>
      </section>

      <section class="onboarding-step" data-step="mode">
        <h2>现在想让电台怎么陪你？</h2>
        <div class="choice-grid compact" id="mode-options">
          <button class="choice-card selected" data-mode="陪伴">陪伴</button>
          <button class="choice-card" data-mode="专注">专注</button>
          <button class="choice-card" data-mode="放松">放松</button>
          <button class="choice-card" data-mode="深夜情绪">深夜情绪</button>
        </div>
      </section>

      <button id="onboarding-next-btn" class="btn-primary">继续</button>
    </div>
  </div>
```

- [ ] **Step 5: Add minimal onboarding CSS**

Modify `frontend/css/radio.css`:

```css
.onboarding-panel {
  width: min(720px, calc(100vw - 32px));
  display: flex;
  flex-direction: column;
  gap: 22px;
  text-align: center;
}

.onboarding-panel h1 {
  font-size: 28px;
  font-weight: 300;
}

.onboarding-panel h2 {
  font-size: 18px;
  font-weight: 400;
  margin-bottom: 14px;
}

.onboarding-step {
  display: none;
}

.onboarding-step.active {
  display: block;
}

.choice-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
}

.choice-grid.compact {
  grid-template-columns: repeat(4, minmax(0, 1fr));
}

.choice-card {
  min-height: 92px;
  border: 1px solid #333;
  background: #111118;
  color: #ddd;
  border-radius: 8px;
  padding: 14px;
  cursor: pointer;
}

.choice-card strong,
.choice-card span {
  display: block;
}

.choice-card span {
  margin-top: 8px;
  color: #888;
  font-size: 13px;
  line-height: 1.5;
}

.choice-card.selected {
  border-color: #e94560;
  color: #fff;
}

.text-input,
.text-area {
  width: 100%;
  border: 1px solid #333;
  background: #111118;
  color: #eee;
  border-radius: 8px;
  padding: 12px 14px;
  margin-top: 10px;
  font: inherit;
}

.text-area {
  min-height: 96px;
  resize: vertical;
}

@media (max-width: 640px) {
  .choice-grid,
  .choice-grid.compact {
    grid-template-columns: 1fr;
  }
}
```

- [ ] **Step 6: Add frontend onboarding state machine**

Modify `frontend/js/radio.js`:

```javascript
let onboardingSettings = null;
let onboardingStepIndex = 0;
const onboardingSteps = ['voice', 'notes', 'mode'];
const pendingOnboarding = {
  voice_preset: 'warm_female',
  display_name: '',
  music_notes: '',
  current_mode: '陪伴',
};

async function showOnboardingOrStart(profile) {
  const resp = await fetch(`/api/radio/onboarding/${profile.userId}`);
  const data = await resp.json();
  if (data.onboarded && data.settings) {
    onboardingSettings = data.settings;
    document.getElementById('start-radio-btn').style.display = 'block';
    return;
  }
  document.getElementById('login-screen').classList.remove('active');
  document.getElementById('onboarding-screen').classList.add('active');
  document.getElementById('onboarding-status').textContent =
    data.profile_ready ? '我已经读到一些你的音乐线索了。' : '正在读你的歌单，先把声音和偏好调好。';
}

function setStep(stepIndex) {
  onboardingStepIndex = stepIndex;
  document.querySelectorAll('.onboarding-step').forEach((node) => {
    node.classList.toggle('active', node.dataset.step === onboardingSteps[stepIndex]);
  });
  document.getElementById('onboarding-next-btn').textContent =
    stepIndex === onboardingSteps.length - 1 ? '开始收听' : '继续';
}
```

Add button handlers:

```javascript
document.querySelectorAll('#voice-options .choice-card').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#voice-options .choice-card').forEach((item) => item.classList.remove('selected'));
    btn.classList.add('selected');
    pendingOnboarding.voice_preset = btn.dataset.voice;
  });
});

document.querySelectorAll('#mode-options .choice-card').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#mode-options .choice-card').forEach((item) => item.classList.remove('selected'));
    btn.classList.add('selected');
    pendingOnboarding.current_mode = btn.dataset.mode;
  });
});

document.getElementById('onboarding-next-btn').addEventListener('click', async () => {
  if (onboardingStepIndex < onboardingSteps.length - 1) {
    setStep(onboardingStepIndex + 1);
    return;
  }
  pendingOnboarding.display_name = document.getElementById('display-name-input').value;
  pendingOnboarding.music_notes = document.getElementById('music-notes-input').value;
  const resp = await fetch(`/api/radio/onboarding/${uid}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(pendingOnboarding),
  });
  const data = await resp.json();
  onboardingSettings = data.settings;
  document.getElementById('onboarding-screen').classList.remove('active');
  document.getElementById('player-screen').classList.add('active');
  createParticles();
  connectWebSocket();
});
```

In WebSocket handshake:

```javascript
settings: onboardingSettings,
```

- [ ] **Step 7: Update login success path**

In QR success block, after `uid = profile.userId`, call:

```javascript
await showOnboardingOrStart(profile);
```

Only show `start-radio-btn` for already-onboarded users.

- [ ] **Step 8: Update existing start button**

Keep the existing `start-radio-btn` behavior, but ensure it relies on `onboardingSettings` if present. If settings are missing, fetch `/api/radio/onboarding/{uid}` before connecting.

- [ ] **Step 9: Update WebSocket handler to read settings**

Modify `backend/api/ws.py` handshake:

```python
settings_payload = msg.get("settings") or {}
stored_settings = await store.get_user_settings(str(uid)) if uid else None
user_settings = stored_settings or settings_payload or {}
```

Store it in the handler scope and pass it to DJ/TTS/scheduler in later tasks.

- [ ] **Step 10: Run tests and browser smoke**

Run:

```powershell
python -m unittest tests.python.test_memory_store_settings -v
python -m uvicorn backend.main:app --port 8080
```

Open `http://localhost:8080`.

Expected:

- Valid login skips QR.
- First-time user sees onboarding.
- Three questions advance without layout overflow.
- Saving onboarding enters player.
- Returning user skips onboarding and sees “开始收听”.

- [ ] **Step 11: Commit**

```powershell
git add backend/api/radio.py backend/api/ws.py frontend/index.html frontend/css/radio.css frontend/js/radio.js tests/python/test_memory_store_settings.py
git commit -m "feat: add first-time radio onboarding"
```

---

### Task 4: Stabilize MiMo TTS Voice Presets

**Files:**
- Modify: `backend/core/config.py`
- Modify: `backend/adapters/tts.py`
- Modify: `.env.example`
- Create: `tests/python/test_tts_voice_presets.py`

- [ ] **Step 1: Write failing tests for voice request construction**

Create `tests/python/test_tts_voice_presets.py`:

```python
import unittest

from backend.adapters.tts import TTSAdapter


class TTSVoicePresetTest(unittest.TestCase):
    def test_request_uses_voice_preset_without_emotion_tags(self):
        adapter = TTSAdapter()

        body = adapter.build_request_body(
            "今晚我们先从一首安静的歌开始。",
            scene="深夜",
            voice_preset="warm_male",
        )

        assistant_text = body["messages"][1]["content"]
        self.assertNotIn("(温柔)", assistant_text)
        self.assertNotIn("(慵懒)", assistant_text)
        self.assertIn("今晚我们先从一首安静的歌开始。", assistant_text)
        self.assertTrue(body["audio"]["voice"])

    def test_hash_changes_when_voice_preset_changes(self):
        adapter = TTSAdapter()

        female_hash = adapter._hash("同一句话", "深夜", "warm_female")
        male_hash = adapter._hash("同一句话", "深夜", "warm_male")

        self.assertNotEqual(female_hash, male_hash)


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run test and verify it fails**

Run:

```powershell
python -m unittest tests.python.test_tts_voice_presets -v
```

Expected: FAIL because `build_request_body()` does not exist and `_hash()` only accepts two args.

- [ ] **Step 3: Add voice config**

Modify `backend/core/config.py`:

```python
    mimo_tts_voice_warm_female: str = ""
    mimo_tts_voice_warm_male: str = ""
    mimo_tts_voice_bright_girl: str = ""
```

These should default to empty strings so existing `MIMO_TTS_VOICE` remains the fallback.

- [ ] **Step 4: Replace overbearing style tags with calm voice presets**

Modify `backend/adapters/tts.py`:

```python
VOICE_PRESETS = {
    "warm_female": {
        "label": "夜航女声",
        "config_attr": "mimo_tts_voice_warm_female",
        "director": "成熟温暖的中文电台女主播，声音有磁性，低暖、克制、自然，不夸张。",
    },
    "warm_male": {
        "label": "暖频男声",
        "config_attr": "mimo_tts_voice_warm_male",
        "director": "温和沉稳的中文电台男主播，声音低暖、有陪伴感，不油腻、不表演化。",
    },
    "bright_girl": {
        "label": "清甜少女声",
        "config_attr": "mimo_tts_voice_bright_girl",
        "director": "年轻清亮的中文电台女主播，亲近、干净、克制，不使用二次元或撒娇口吻。",
    },
}

SCENE_GUIDANCE = {
    "深夜": "深夜时段，语速稍慢，留白自然。",
    "清晨": "清晨时段，语气清爽但不亢奋。",
    "午后": "午后时段，语气放松、轻一点。",
    "日常": "日常陪伴，语气自然平稳。",
}
```

Remove `STYLE_TAGS` and stop prepending parenthesized emotion tags.

- [ ] **Step 5: Add helper methods**

Inside `TTSAdapter`:

```python
    def _resolve_voice(self, voice_preset: str) -> str:
        preset = VOICE_PRESETS.get(voice_preset, VOICE_PRESETS["warm_female"])
        configured = getattr(settings, preset["config_attr"], "") or ""
        return configured or self.voice

    def _director_prompt(self, scene: str, voice_preset: str) -> str:
        preset = VOICE_PRESETS.get(voice_preset, VOICE_PRESETS["warm_female"])
        scene_text = SCENE_GUIDANCE.get(scene, SCENE_GUIDANCE["日常"])
        return (
            f"[角色]{preset['director']}"
            f"[场景]{scene_text}"
            "[指导]像真实电台主播一样说话。不要加入奇怪语气词、括号情绪标签、拟声词或夸张重音。"
        )

    def build_request_body(self, text: str, scene: str = "日常", voice_preset: str = "warm_female") -> dict:
        return {
            "model": self.model,
            "messages": [
                {"role": "user", "content": self._director_prompt(scene, voice_preset)},
                {"role": "assistant", "content": text},
            ],
            "audio": {
                "format": "wav",
                "voice": self._resolve_voice(voice_preset),
            },
        }
```

Change hash:

```python
    def _hash(self, text: str, style: str, voice_preset: str = "warm_female") -> str:
        voice = self._resolve_voice(voice_preset)
        return hashlib.md5(f"{text}|{style}|{voice_preset}|{voice}".encode()).hexdigest()
```

Change synthesize signature:

```python
    async def synthesize(self, text: str, style: str = "日常", voice_preset: str = "warm_female") -> bytes | None:
```

Use:

```python
body = self.build_request_body(text, style, voice_preset)
```

- [ ] **Step 6: Update all call sites**

In `backend/api/ws.py`, use user settings:

```python
voice_preset = user_settings.get("voice_preset", "warm_female")
tts_audio = await tts.synthesize(intro, scene, voice_preset=voice_preset)
tts_hash = tts._hash(intro, scene, voice_preset) if tts_audio else ""
```

Repeat for segue synthesis.

- [ ] **Step 7: Update `.env.example`**

Set:

```env
LLM_MODEL=mimo-v2.5-pro

MIMO_TTS_VOICE=冰糖
MIMO_TTS_VOICE_WARM_FEMALE=
MIMO_TTS_VOICE_WARM_MALE=
MIMO_TTS_VOICE_BRIGHT_GIRL=
```

Leave preset-specific values empty because actual available MiMo voice names depend on the account and chosen provider configuration.

- [ ] **Step 8: Run tests**

Run:

```powershell
python -m unittest tests.python.test_tts_voice_presets -v
python -m unittest tests.python.test_memory_store_settings -v
```

Expected: PASS.

- [ ] **Step 9: Manual TTS smoke**

With MiMo key configured, run a short synthesis script:

```powershell
@'
import asyncio
from backend.adapters.tts import TTSAdapter

async def main():
    t = TTSAdapter()
    audio = await t.synthesize("今晚我们先把声音放低一点。", "深夜", "warm_female")
    print("ok", bool(audio), len(audio or b""))
    await t.close()

asyncio.run(main())
'@ | python -
```

Expected: `ok True` with nonzero bytes, or Edge fallback if MiMo is unavailable.

- [ ] **Step 10: Commit**

```powershell
git add backend/core/config.py backend/adapters/tts.py backend/api/ws.py .env.example tests/python/test_tts_voice_presets.py
git commit -m "feat: add stable DJ voice presets for MiMo TTS"
```

---

### Task 5: Improve Profile Analysis With Playlist Details And User Notes

**Files:**
- Modify: `netease-bridge/server.js`
- Modify: `backend/adapters/netease.py`
- Modify: `backend/engines/profile.py`
- Create: `tests/python/test_profile_engine_playlist_detail.py`

- [ ] **Step 1: Write failing profile test**

Create `tests/python/test_profile_engine_playlist_detail.py`:

```python
import asyncio
import json
import os
import tempfile
import unittest
from pathlib import Path


class FakeNetease:
    async def user_playlist(self, uid):
        return [{"id": 100, "name": "夜里听"}, {"id": 200, "name": "工作"}]

    async def playlist_detail(self, playlist_id):
        return {
            "playlist": {
                "tracks": [
                    {"id": 1, "name": "雨夜", "ar": [{"name": "A"}]},
                    {"id": 2, "name": "慢慢", "ar": [{"name": "B"}]},
                ]
            }
        }

    async def user_record(self, uid):
        return {"weekData": [{"song": {"id": 3, "name": "最近", "ar": [{"name": "C"}]}}]}

    async def like_list(self, uid):
        return [1, 3]


class FakeLLM:
    async def chat(self, prompt, max_tokens=800):
        return json.dumps({
            "music_dna": {"genres": {"华语流行": 0.8}, "energy_level": "中"},
            "personality": {"traits": ["念旧"]},
            "listening_pattern": {},
            "dj_style_suggestion": "温暖克制",
        }, ensure_ascii=False)


class ProfilePlaylistDetailTest(unittest.TestCase):
    def test_profile_includes_anchor_tracks_from_playlist_detail(self):
        with tempfile.TemporaryDirectory() as tmp:
            os.environ["RADIO_DB_PATH"] = str(Path(tmp) / "radio-test.db")

            from backend.memory.models import init_db
            from backend.memory.store import MemoryStore
            from backend.engines.profile import ProfileEngine

            async def run():
                await init_db()
                store = MemoryStore()
                engine = ProfileEngine(FakeNetease(), FakeLLM(), store)
                profile = await engine.analyze(42)

                self.assertIn("anchor_tracks", profile)
                self.assertEqual(profile["anchor_tracks"][0]["name"], "雨夜")
                saved = await store.get_profile("42")
                self.assertEqual(saved["anchor_tracks"][1]["artist"], "B")

            asyncio.run(run())


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run test and verify it fails**

Run:

```powershell
python -m unittest tests.python.test_profile_engine_playlist_detail -v
```

Expected: FAIL because `playlist_detail()` is not available and profile does not save `anchor_tracks`.

- [ ] **Step 3: Add playlist detail to bridge**

Modify import in `netease-bridge/server.js`:

```javascript
playlist_detail,
```

Add endpoint:

```javascript
app.get('/playlist/detail', async (req, res) => {
  const r = await playlist_detail(withCookie({ id: req.query.id }));
  res.json(r.body);
});
```

- [ ] **Step 4: Add adapter method**

Modify `backend/adapters/netease.py`:

```python
    async def playlist_detail(self, playlist_id: int | str) -> dict:
        try:
            r = await self.client.get(f"{BASE}/playlist/detail", params={"id": playlist_id}, timeout=12.0)
            return r.json()
        except Exception:
            return {}
```

- [ ] **Step 5: Update profile analysis track collection**

Modify `backend/engines/profile.py`:

```python
    async def _playlist_tracks(self, playlists: list[dict], max_playlists: int = 6) -> list[dict]:
        tracks = []
        for playlist in (playlists or [])[:max_playlists]:
            detail = await self.netease.playlist_detail(playlist.get("id"))
            playlist_tracks = detail.get("playlist", {}).get("tracks", [])
            for song in playlist_tracks[:40]:
                tracks.append(song)
        return tracks

    def _compact_track(self, song: dict, source: str = "") -> dict:
        return {
            "id": str(song.get("id", "")),
            "name": song.get("name", ""),
            "artist": (
                song.get("ar", [{}])[0].get("name", "")
                if song.get("ar")
                else ""
            ),
            "source": source,
        }
```

In `analyze()`:

```python
all_songs = await self._playlist_tracks(playlists or [])
```

After parsing LLM response:

```python
anchor_tracks = [
    self._compact_track(song, "playlist")
    for song in all_songs[:60]
    if song.get("id")
]
recent_tracks = [
    self._compact_track(item.get("song", {}), "recent")
    for item in week_data[:40]
    if item.get("song", {}).get("id")
]
profile["anchor_tracks"] = anchor_tracks[:40]
profile["recent_tracks"] = recent_tracks[:30]
profile["liked_track_ids"] = [str(x) for x in (liked or [])[:500]]
```

- [ ] **Step 6: Include onboarding notes in prompt if available**

At the start of `analyze()`:

```python
settings = await self.store.get_user_settings(str(uid)) or {}
music_notes = settings.get("music_notes", "")
```

Add to prompt:

```text
用户补充说明：
{music_notes[:500] or "无"}
```

- [ ] **Step 7: Run tests**

Run:

```powershell
python -m unittest tests.python.test_profile_engine_playlist_detail -v
python -m unittest tests.python.test_memory_store_settings -v
```

Expected: PASS.

- [ ] **Step 8: Commit**

```powershell
git add netease-bridge/server.js backend/adapters/netease.py backend/engines/profile.py tests/python/test_profile_engine_playlist_detail.py
git commit -m "feat: enrich profiles with playlist detail tracks"
```

---

### Task 6: Upgrade Scheduler To Personalized Familiar/Discovery Mix

**Files:**
- Modify: `backend/engines/scheduler.py`
- Modify: `backend/api/ws.py`
- Modify: `backend/engines/dj.py`
- Create: `tests/python/test_scheduler_personalized_pick.py`

- [ ] **Step 1: Write failing scheduler test**

Create `tests/python/test_scheduler_personalized_pick.py`:

```python
import asyncio
import os
import tempfile
import unittest
from pathlib import Path


class FakeNetease:
    async def simi_song(self, song_id):
        return [{"id": "20", "name": "新发现", "ar": [{"name": "新歌手"}]}]

    async def recommend_songs(self):
        return [{"id": "30", "name": "每日", "ar": [{"name": "日推歌手"}]}]

    async def personal_fm(self):
        return [{"id": "40", "name": "FM", "ar": [{"name": "FM歌手"}]}]

    async def song_url(self, song_id):
        return f"http://example.com/{song_id}.mp3"


class DummyBus:
    pass


class SchedulerPersonalizedPickTest(unittest.TestCase):
    def test_first_pick_prefers_profile_anchor_when_available(self):
        with tempfile.TemporaryDirectory() as tmp:
            os.environ["RADIO_DB_PATH"] = str(Path(tmp) / "radio-test.db")

            from backend.memory.models import init_db
            from backend.memory.store import MemoryStore
            from backend.engines.scheduler import StreamScheduler

            async def run():
                await init_db()
                store = MemoryStore()
                scheduler = StreamScheduler(FakeNetease(), store, DummyBus())
                profile = {
                    "anchor_tracks": [
                        {"id": "10", "name": "熟悉歌", "artist": "老朋友", "source": "playlist"}
                    ]
                }
                song = await scheduler.pick_next(profile=profile, user_settings={"current_mode": "陪伴"})

                self.assertEqual(str(song["id"]), "10")
                self.assertEqual(song["selection_reason"]["type"], "familiar_anchor")

            asyncio.run(run())

    def test_recent_track_is_not_repeated(self):
        with tempfile.TemporaryDirectory() as tmp:
            os.environ["RADIO_DB_PATH"] = str(Path(tmp) / "radio-test.db")

            from backend.memory.models import init_db
            from backend.memory.store import MemoryStore
            from backend.engines.scheduler import StreamScheduler

            async def run():
                await init_db()
                store = MemoryStore()
                await store.log_track("10", "熟悉歌", "老朋友", "test")
                scheduler = StreamScheduler(FakeNetease(), store, DummyBus())
                profile = {
                    "anchor_tracks": [
                        {"id": "10", "name": "熟悉歌", "artist": "老朋友", "source": "playlist"}
                    ]
                }
                song = await scheduler.pick_next(profile=profile, current_song_id="9")

                self.assertNotEqual(str(song["id"]), "10")

            asyncio.run(run())


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run test and verify it fails**

Run:

```powershell
python -m unittest tests.python.test_scheduler_personalized_pick -v
```

Expected: FAIL because `pick_next()` does not accept `profile` or return `selection_reason`.

- [ ] **Step 3: Add helpers to scheduler**

Modify `backend/engines/scheduler.py`.

Add compact conversion:

```python
    def _from_profile_track(self, track: dict) -> dict:
        return {
            "id": str(track.get("id", "")),
            "name": track.get("name", ""),
            "ar": [{"name": track.get("artist", "")}],
            "source": track.get("source", "profile"),
        }
```

Add artist helper:

```python
    def _artist(self, song: dict) -> str:
        return (
            song.get("ar", [{}])[0].get("name", "")
            if song.get("ar")
            else song.get("artist", "")
        )
```

Add reason helper:

```python
    def _with_reason(self, song: dict, reason_type: str, text: str) -> dict:
        song = dict(song)
        song["selection_reason"] = {"type": reason_type, "text": text}
        return song
```

- [ ] **Step 4: Change pick signature**

```python
    async def pick_next(
        self,
        current_song_id: str | None = None,
        profile: dict | None = None,
        user_settings: dict | None = None,
    ) -> dict | None:
```

- [ ] **Step 5: Add personalized first-pass logic**

Before similar songs:

```python
        profile = profile or {}
        user_settings = user_settings or {}
        recent_db = await self.store.get_recent_tracks(200)
        recent = set(recent_db) | self._played_this_session
        recent_artists = set()

        def _good(song: dict) -> bool:
            sid = str(song.get("id"))
            return bool(sid) and sid not in recent

        anchor_tracks = [self._from_profile_track(t) for t in profile.get("anchor_tracks", [])]
        should_use_anchor = len(self._played_this_session) % 4 == 0 or not current_song_id
        if should_use_anchor:
            for song in anchor_tracks:
                if _good(song):
                    self._played_this_session.add(str(song.get("id")))
                    return self._with_reason(
                        song,
                        "familiar_anchor",
                        "从你的歌单里挑一首熟悉的歌，先把电台调到你的频率。",
                    )
```

Keep existing similar/daily/FM/fallback chain but wrap returns:

```python
return self._with_reason(s, "discovery_similar", "沿着刚才那首歌的气质，找一首不太陌生的新发现。")
return self._with_reason(s, "daily_personal", "从今天的私人推荐里挑一首适合当前状态的歌。")
return self._with_reason(s, "personal_fm", "从私人 FM 里接一首轻轻往前走的歌。")
return self._with_reason(s, "fallback", "网络推荐暂时不可用，先用一首稳定的兜底歌保持播放。")
```

- [ ] **Step 6: Prevent duplicate logging and keep full current song**

Modify `backend/api/ws.py`:

```python
current_song = None
```

In `send_track(song, url)`:

```python
nonlocal current_song, current_song_id
current_song = song
current_song_id = str(song.get("id"))
```

In `play_next_with_segue()`:

```python
next_song = await scheduler.pick_next(
    prev_song_id,
    profile=profile,
    user_settings=user_settings,
)
```

Pass `current_song or {"id": prev_song_id}` to DJ:

```python
segue = await dj_engine.generate_segue(
    profile, scene, current_song or {"id": prev_song_id}, next_song, compressor, user_settings
)
```

When a segue is sent, set `current_song = next_song` after playback message is sent. Remove duplicate `store.log_track()` if `send_track()` already logged that same song.

- [ ] **Step 7: Update first song pick**

In handshake:

```python
song = await scheduler.pick_next(profile=profile, user_settings=user_settings)
```

- [ ] **Step 8: Update DJ prompt signature**

Modify `backend/engines/dj.py`:

```python
    async def generate_intro(self, profile: dict, scene: str, user_settings: dict | None = None) -> str:
```

and:

```python
    async def generate_segue(..., user_settings: dict | None = None) -> str:
```

Use:

```python
display_name = (user_settings or {}).get("display_name", "")
mode = (user_settings or {}).get("current_mode", "陪伴")
notes = (user_settings or {}).get("music_notes", "")
reason = next_song.get("selection_reason", {}).get("text", "")
```

Add prompt guidance:

```text
用户当前想要的陪伴方式：{mode}
用户补充：{notes[:200] or "无"}
选曲理由线索：{reason or "自然衔接"}

要求：
- 像电台主播，不像短视频配音。
- 少用语气词。
- 不要说“推荐”“喜欢”“接下来请听”。
- 只轻轻点到用户信息，不要暴露“我分析了你”。
```

- [ ] **Step 9: Run tests**

Run:

```powershell
python -m unittest tests.python.test_scheduler_personalized_pick -v
python -m unittest tests.python.test_profile_engine_playlist_detail -v
python -m unittest tests.python.test_tts_voice_presets -v
python -m unittest tests.python.test_memory_store_settings -v
```

Expected: PASS.

- [ ] **Step 10: Manual playback smoke**

Start:

```powershell
python -m uvicorn backend.main:app --port 8080
```

Open `http://localhost:8080`.

Expected:

- Existing login is reused.
- Onboarding is skipped if settings exist.
- First song can come from profile anchors if available.
- Next songs do not repeat recent tracks.
- DJ text includes actual previous and next song names when available.

- [ ] **Step 11: Commit**

```powershell
git add backend/engines/scheduler.py backend/api/ws.py backend/engines/dj.py tests/python/test_scheduler_personalized_pick.py
git commit -m "feat: personalize radio song selection"
```

---

### Task 7: Final Integration Verification

**Files:**
- Modify if needed based on verification findings.

- [ ] **Step 1: Run all automated tests**

Run:

```powershell
node --test netease-bridge/auth-state.test.mjs
python -m unittest discover -s tests/python -v
```

Expected: all tests PASS.

- [ ] **Step 2: Start app**

Run:

```powershell
python -m uvicorn backend.main:app --port 8080
```

Expected: FastAPI starts, NetEase bridge starts or reuses existing bridge.

- [ ] **Step 3: Browser verification checklist**

Open `http://localhost:8080`.

Verify:

- Fresh user sees QR.
- QR success saves login.
- Browser refresh skips QR when cookie is valid.
- First-time user sees three-step onboarding.
- Voice option selection persists after saving.
- Returning user can start player without repeating onboarding.
- WebSocket handshake succeeds.
- TTS request uses selected voice preset.
- First track plays or gracefully falls back.
- Skip button still works.
- Track ending produces a segue or direct next song.
- No obvious text overflow on desktop and narrow mobile viewport.

- [ ] **Step 4: Inspect generated local files**

Verify:

```powershell
Test-Path data/netease-cookie.json
Test-Path data/radio.db
```

Expected: both are present after login/onboarding.

- [ ] **Step 5: Check git diff for secrets**

Run:

```powershell
git diff -- data .env
git status --short
```

Expected:

- No `.env` changes staged.
- No cookie file staged.
- Only intended source and test files changed.

- [ ] **Step 6: Commit final fixes if any**

```powershell
git add <changed source/test files only>
git commit -m "fix: complete first-round radio repair verification"
```

---

## Completion Criteria

This first round is complete when:

- Refreshing the browser no longer forces a new QR scan while NetEase cookie remains valid.
- First-time login shows a three-question tuning/onboarding experience.
- User voice preset, name, notes, and current mode persist locally.
- MiMo TTS no longer receives stacked emotion tags or overly theatrical scene prompts.
- Scheduler uses profile anchors and recommendation pools with recent-track dedupe.
- DJ receives enough context to mention real songs naturally.
- All new Python and Node tests pass.
- Manual browser smoke confirms login, onboarding, playback, skip, and next-track flow.
