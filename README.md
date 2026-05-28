# FREQME

私人 AI 电台。它会登录网易云音乐，蒸馏你的歌单和最近播放，用一个有记忆的 AI DJ 帮你选歌、串场、处理模糊点歌和避雷反馈。

## 现在的架构

FREQME 已经切到单一 TypeScript 后端：

- Node.js / TypeScript / Express / WebSocket
- 直接集成 `NeteaseCloudMusicApi`
- 本地 SQLite 记忆、画像、TTS 缓存和音频 URL 缓存
- 前端仍是 `frontend/index.html`、`frontend/js/radio.js`、`frontend/css/radio.css`

不再需要 Python 虚拟环境，也不再需要单独启动 `netease-bridge`。

## 核心能力

- AI DJ 会理解自然语言点歌，而不是直接搜用户原句。
- 模糊请求会先推断具体歌曲、歌手、作品、风格或场景，再搜索和校验。
- 歌单、最近播放、喜欢列表、onboarding 备注、跳过和负反馈会进入本地画像。
- 电台会根据时间、地区提示和浏览器授权的城市级位置调整播放方向。
- TTS 失败时音乐继续播放，主播文字仍会显示。
- WebSocket 队列会预热下一首，避免播放断档。

## 快速启动

```powershell
npm install
npm run dev
```

打开：

```text
http://127.0.0.1:8000/
```

## 环境变量

复制 `.env.example` 到 `.env`，填入可用的 LLM / TTS key。

```env
MIMO_API_KEY=tp-xxx
MIMO_API_BASE=https://token-plan-sgp.xiaomimimo.com/v1
MIMO_TTS_MODEL=mimo-v2.5-tts
MIMO_TTS_VOICE=

LLM_PROVIDER=mimo
LLM_API_KEY=tp-xxx
LLM_MODEL=mimo-v2.5-pro
LLM_API_BASE=https://token-plan-sgp.xiaomimimo.com/v1

LLM_FALLBACK_PROVIDER=anthropic
LLM_FALLBACK_API_KEY=
LLM_FALLBACK_MODEL=claude-sonnet-4-6

PORT=8000
HOST=127.0.0.1
DATA_DIR=./data
RADIO_DB_PATH=./data/freqme.db
MAX_DAILY_TOKENS=100000
```

## 开发命令

```powershell
npm run build
npm test
npm start
```

`npm test` 会先编译 TypeScript，再跑新的 TypeScript 测试、前端 WebSocket 测试，以及保留下来的网易云桥工具函数测试。

## 本地数据

新后端默认使用：

- `data/freqme.db`
- `data/netease-cookie.json`
- `data/tts_cache/`

旧的 `data/radio.db` 不再作为主数据库使用。

