# AI Radio — 设计文档

**项目代号:** AI Radio / 小米memo电台
**日期:** 2026-05-24
**状态:** 设计完成，进入实施

---

## 1. 项目概述

一个以 AI 主播（小米memo）为核心的网络电台。用户登录网易云音乐后，AI 自动分析歌单生成用户画像，在播放歌曲间隙以夏目漱石式含蓄温暖的风格串场，像朋友一样陪伴用户度过打工、coding、独处的时光。

**核心体验:** 全自动电台。登录即听，无需操作。AI 了解你的音乐品味，用不说破的方式传递温度。

---

## 2. 架构总览

```
Browser Frontend (沉浸式播放器)
      ↕ WebSocket + REST
Radio Core (Event Bus)
  ├── Profile Engine    → 歌单分析、人格侧写
  ├── DJ Engine         → 场景感知、文案生成
  ├── Stream Scheduler  → 播放调度、TTS预生成
  ├── Memory Store      → 三层记忆(L1画像/L2历史/L3上下文)
  ├── Netease Adapter   → 网易云API封装
  └── LLM Router        → 多模型统一调用
```

模块化单体，事件驱动。每个模块独立边界、独立测试，未来可拆微服务。

---

## 3. 模块设计

### 3.1 Memory Store — 防健忘核心

**L1 用户画像 (SQLite, 永久)**
```json
{
  "music_dna": {
    "genres": {"华语流行": 0.7, "后摇": 0.3},
    "era_bias": "2010s",
    "energy_level": "中低",
    "vocal_preference": "治愈系女声",
    "instrument_bias": ["钢琴", "吉他"]
  },
  "personality": {
    "mbti_guess": "INFP",
    "traits": ["内省", "念旧", "感性"],
    "emotional_resonance": "深夜、独处、回忆"
  },
  "listening_pattern": {
    "peak_hours": ["22:00-02:00"],
    "avg_session_min": 85
  }
}
```

**L2 播放历史 + 互动记录 (SQLite, 长期)**
- `track_log`: song_id, name, artist, played_at, source, feedback
- `dj_script_log`: topic, script, tts_cached, created_at, style
- `session_log`: session_start, songs_played, topics_covered (摘要压缩)

**L3 近期上下文 (内存, 20轮窗口)**
- 超出窗口自动 LLM 摘要 → 写入 L2
- 每 10 次会话触发画像重评估

### 3.2 Profile Engine

**输入:** 用户歌单、听歌记录、红心列表、每日推荐
**输出:** 用户画像 (L1)

**流程:**
1. 从 Netease Adapter 拉取所有歌单及歌曲
2. 聚合歌曲元数据: 风格、年代、语言、歌手、语种
3. 调用 LLM 做深度分析: MBTI推测、情感倾向、听歌习惯
4. 存入 L1 画像
5. 后台定时更新 (每10次会话或歌词积累>100首新数据)

### 3.3 DJ Engine

**System Prompt 约束:**
- 永远不说"我喜欢这首歌" → 用画面、回忆、比喻传递感受
- 永远不说"推荐" → 说"分享"、"让我想起"、"找到一首"
- 永远不评价用户品味 → 只共鸣，不判断
- 每段 30-60 秒朗读时长

**场景模式:**
- 深夜 (22:00-05:00): 低缓、安静、耳边轻语
- 午后 (12:00-17:00): 慵懒、随性、晒太阳闲聊
- 清晨 (05:00-09:00): 清爽、有朝气
- 日常 (其他时段): 自然、轻松

**话题池:** 歌曲故事 / 场景共鸣 / 生活观察 / 音乐连接

**输入:** L1画像 + L3上下文 + 当前场景 + 下一首歌曲信息
**输出:** 30-60秒中文口播文案

### 3.4 Stream Scheduler

**时序:**
1. 播放歌曲A → 异步触发下一段TTS预生成
2. DJ Engine 生成文案 → MiMo TTS 合成语音 → 缓存到前端
3. 歌曲A剩余5秒 → 200ms淡出 → 无缝切入TTS
4. TTS播完 → 无缝切入歌曲B → 触发新TTS预生成

**降级:** TTS超时(>10s) → 省略串场 → 直接切歌

**关键技术:**
- 网易云URL有过期时间，播放到 2/3 时刷新下一首
- AudioContext 实现 200ms 交叉淡入淡出
- TTS 异步队列，不阻塞播放

### 3.5 Netease Adapter

基于 `@neteasecloudmusicapienhanced/api` (Node.js 子进程)

**核心能力:**
- 二维码登录 (三步流程，cookie持久化)
- 获取用户歌单、听歌记录、每日推荐、私人FM
- 搜索歌曲/歌手/专辑
- 获取歌曲播放URL、歌词
- 相似歌曲/歌单推荐
- Cookie自动刷新

### 3.6 LLM Router

统一接口，支持三后端:
- `POST /llm/chat` → 自动路由到配置的模型
- 首次画像分析: 默认 Claude (深度分析)
- 日常串场文案: 默认 DeepSeek/便宜模型
- 环境变量配置: `LLM_PROVIDER`, `LLM_API_KEY`, `LLM_MODEL`

**降级链:**
- primary → secondary → 内置模板文案
- 超时: 15s (画像分析), 8s (串场文案)
- 日预算: 可配置 `MAX_TOKENS_PER_DAY`

### 3.7 TTS Adapter

**接口:** `adapters/tts.py`
```python
async def synthesize(text: str, style: str = "default") -> bytes
# 返回 WAV/MP3 字节流
# style: 深夜/日常/清晨/午后 → 映射到MiMo的情绪参数
```

**降级:** MiMo API不可用 → Edge TTS 免费备用
**缓存:** TTS结果按 text+style 哈希缓存24h，相同文案不重复生成
**超时:** 10s，超时后走降级路径

### 3.8 Audio Pipeline

**歌曲音频:**
1. Netease Adapter 获取歌曲URL (`/song/url?id=xxx`)
2. 前端直接用 `<audio>` 加载歌曲URL（不经过后端代理）
3. 播放到 2/3 时，Scheduler 刷新下一首URL（防止过期）

**主播语音:**
1. TTS Adapter 合成 → 返回 WAV bytes
2. 后端缓存到 `data/tts_cache/{hash}.wav`
3. 前端通过 `GET /audio/tts/{hash}` 获取
4. 预生成: 当前歌曲播放时异步排队生成下一段TTS

**交叉淡入淡出:**
- 前端用两个 `<audio>` 元素轮换
- 歌曲→TTS: 歌曲淡出200ms，TTS淡入200ms
- TTS→歌曲: TTS播放完自然结束，歌曲淡入

### 3.9 歌曲选择算法

优先级降级链:
1. **相似歌曲** (`/simi/song?id=当前歌曲ID`) → 最多取5首
2. → 不够 → **每日推荐** (`/recommend/songs`) 补充
3. → 还不够 → **用户歌单随机** 洗牌取
4. → **历史播放高反馈歌曲**

**去重:**
- 排除 L2 最近100首已播放
- 排除同歌手连续3首以上
- 排除用户反馈"跳过"的歌曲

### 3.10 Netease Bridge 生命周期

- Python `subprocess.Popen` 在 FastAPI startup 事件中启动 `node netease-bridge/server.js`
- Bridge 监听 `localhost:3000`，启动后返回 `{"status":"ready"}`
- Python 轮询 `GET /health`（最多3秒，间隔200ms）等待bridge就绪
- Bridge crash → Python 自动重启（最多3次，1s退避）
- FastAPI shutdown → `SIGTERM` → bridge进程清理

### 3.11 用户交互

最小控件集:
- 下一首 (skip) — 直接切换，无主播语音
- 暂停/播放
- 音量滑块

所有操作通过 WebSocket 发送消息:
```json
{"type": "skip"}
{"type": "pause"}
{"type": "resume"}
{"type": "volume", "value": 0.8}
```

### 3.12 时区处理

前端 WebSocket 握手时发送:
```json
{"type": "handshake", "timezone": "Asia/Shanghai", "utc_offset": 480}
```
DJ Engine 使用 `utc_offset` 计算用户本地时间判断场景。

### 3.13 事件总线事件类型

```
auth.login_success    → Profile Engine 启动分析
profile.updated       → Memory Store 写入L1
track.started         → Scheduler 预生成下一段TTS
track.near_end        → Scheduler 获取下一首歌
tts.ready             → 前端可播放通知
tts.failed            → Scheduler 走降级路径
session.end           → Memory Store 压缩L3
track.skipped         → 记录反馈到L2
```

---

## 4. 数据流

### 首次使用
```
用户打开网页 → 扫码登录网易云
→ Netease Adapter 拉取歌单+历史
→ Profile Engine 分析 → 写入 L1 画像
→ DJ Engine 选择开场话题 → 生成开场白
→ MiMo TTS 合成语音 → 前端播放
→ Stream Scheduler 开始推送歌曲
```

### 正常播放循环
```
歌曲播放中 → Scheduler 取下一首歌(simi_song / 每日推荐)
→ DJ Engine 生成串场文案 → TTS预生成
→ 歌曲结束 → 播放TTS → 下一首歌 → 循环
```

### 会话结束
```
用户关闭页面 → L3上下文触发摘要压缩 → 写入L2 session_log
→ 检查是否需要画像更新 (每10次会话)
```

### 错误流

```
登录超时 → QR码过期 → 前端显示刷新按钮，重新请求QR key
歌单为空 → Profile Engine 返回空画像 → DJ用通用开场白
TTS超时(>10s) → 跳过串场 → 直接切歌
URL过期(403) → Scheduler重试一次 → 仍失败则跳过该歌曲
WebSocket断开 → 前端显示重连提示 → 3秒自动重连
Bridge崩溃 → 自动重启(最多3次) → 前端显示"连线中..."
```

---

## 5. 技术栈

| 层 | 选型 |
|----|------|
| 后端框架 | Python FastAPI |
| 网易云API | @neteasecloudmusicapienhanced/api (Node.js子进程) |
| 数据库 | SQLite (本地文件) |
| LLM | Anthropic / OpenAI / Gemini (Router抽象) |
| TTS | 小米 MiMo API |
| 前端 | 纯 HTML/CSS/JS (沉浸式深色UI) |
| 通信 | WebSocket (播放控制) + REST (登录/设置) |
| 部署 | 本地 Web 服务 |

---

## 6. 错误处理

- 网易云API失败 → 使用本地缓存的播放URL，重试3次后降级
- TTS失败 → 跳过串场，直接切歌
- LLM超时 → 使用预设通用模板文案
- 歌曲URL过期 → 播放到2/3时预刷新

---

## 7. MVP范围

**包含:**
- 网易云二维码登录
- 歌单拉取 + 人格侧写
- DJ Engine 基础文案生成
- 小米MiMo TTS合成
- 沉浸式前端播放器
- 三层记忆存储
- 基础场景感知 (时间)

**不包含 (后续迭代):**
- 天气感知
- 多语言支持
- 用户名/密码登录
- 桌面端打包
- 向量记忆检索

---

## 8. 文件结构

```
ai-radio/
├── backend/
│   ├── main.py              # FastAPI 入口
│   ├── core/
│   │   ├── event_bus.py     # 事件总线
│   │   └── config.py        # 配置管理
│   ├── engines/
│   │   ├── profile.py       # Profile Engine
│   │   ├── dj.py            # DJ Engine
│   │   └── scheduler.py     # Stream Scheduler
│   ├── adapters/
│   │   ├── netease.py       # 网易云API适配器
│   │   ├── llm_router.py    # LLM路由
│   │   └── tts.py           # TTS适配器(MiMo + Edge降级)
│   ├── memory/
│   │   ├── store.py         # Memory Store
│   │   ├── models.py        # 数据模型
│   │   └── compressor.py    # 摘要压缩
│   └── api/
│       ├── auth.py          # 登录相关
│       ├── radio.py         # 电台控制
│       └── ws.py            # WebSocket
├── frontend/
│   ├── index.html           # 主播放器页面
│   ├── css/
│   └── js/
├── netease-bridge/          # Node.js 网易云桥接
│   └── server.js
├── data/                    # SQLite数据库
├── docs/
│   └── superpowers/
│       └── specs/
└── requirements.txt
```
