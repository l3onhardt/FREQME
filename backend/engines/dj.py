from datetime import datetime, timedelta, timezone

from backend.adapters.llm_router import LLMRouter
from backend.memory.compressor import ContextCompressor
from backend.memory.store import MemoryStore


def should_generate_segue(track_index: int) -> bool:
    return track_index > 1 and (track_index - 1) % 3 == 0


class DJEngine:
    def __init__(self, llm: LLMRouter, store: MemoryStore):
        self.llm = llm
        self.store = store

    def detect_scene(self, utc_offset: int = 480) -> str:
        try:
            tz = timezone(timedelta(minutes=utc_offset))
        except Exception:
            tz = timezone(timedelta(hours=8))
        local = datetime.now(tz)
        h = local.hour
        if 5 <= h < 9:
            return "清晨"
        if 12 <= h < 17:
            return "午后"
        if 22 <= h or h < 5:
            return "深夜"
        return "日常"

    async def generate_intro(
        self,
        profile: dict,
        scene: str,
        user_settings: dict | None = None,
    ) -> str:
        style = profile.get("dj_style_suggestion", "温暖自然")
        personality = profile.get("personality", {})
        insights = self._radio_insights_text(profile)
        situational = self._situational_text(user_settings)
        prompt = f"""现在是{scene}，用户刚打开一档私人音乐电台。

用户画像：{personality}
主播可用的听感洞察：
{insights}
建议的 DJ 风格：{style}
时间与地区上下文：{situational}

请生成一段开场白，朗读时长约 12 到 20 秒。
只输出主播要说的话，不要标题、括号、解释或舞台提示。
不要说“欢迎收听”，不要说“根据你的画像”，不要提系统或算法。
如果用户刚点了方向，先像真人 DJ 一样轻轻接住这个请求，再把音乐放进去。
语气要像真实电台主播自然开口，有画面感，但不要矫情。"""
        return await self.llm.chat(
            self._with_user_settings_hint(prompt, user_settings),
            max_tokens=180,
        )

    async def generate_segue(
        self,
        profile: dict,
        scene: str,
        current_song: dict,
        next_song: dict,
        context: ContextCompressor,
        user_settings: dict | None = None,
    ) -> str:
        current_name = current_song.get("name", "这首歌")
        current_artist = self._artist_name(current_song)
        next_name = next_song.get("name", "下一首歌")
        next_artist = self._artist_name(next_song)
        selection_reason = (
            (next_song.get("selection_reason") or {}).get("text", "")
            if isinstance(next_song.get("selection_reason"), dict)
            else ""
        )

        recent = context.to_prompt_text()
        style = profile.get("dj_style_suggestion", "温暖自然")
        traits = profile.get("personality", {}).get("traits", [])
        current_mode = (user_settings or {}).get("current_mode", "").strip()
        music_notes = (user_settings or {}).get("music_notes", "").strip()[:200]
        insights = self._radio_insights_text(profile)
        situational = self._situational_text(user_settings)

        prompt = f"""你是小米 memo，一位私人音乐电台主播。现在是{scene}。

当前刚播完：{current_name} - {current_artist}
下一首即将播放：{next_name} - {next_artist}
选曲线索：{selection_reason or '延续刚才的情绪，让两首歌自然接上。'}

用户画像：{', '.join(traits) if traits else '暂无明确画像'}
主播可用的听感洞察：
{insights}
主播风格：{style}
用户当前状态：{current_mode or '未说明'}
用户备注：{music_notes or '未说明'}
时间与地区上下文：{situational}

最近电台上下文：
{recent if recent else '刚开始，没有历史上下文。'}

请生成一段 1 到 2 句的串场，朗读时长约 8 到 15 秒。
只输出主播要说的话，不要标题、括号、解释或舞台提示。
必须自然连接“{current_name}”和“{next_name}”，可以点到两首歌的气质变化。
不要使用“推荐”“喜欢”“接下来请听”这些机械表达；不要提系统、画像或选曲规则。
语气要像深夜电台里真实的人在接歌：具体、克制、贴近音乐。"""
        return await self.llm.chat(
            self._with_user_settings_hint(prompt, user_settings),
            max_tokens=180,
        )

    async def generate_program_break(
        self,
        profile: dict,
        scene: str,
        played_songs: list[dict],
        next_song: dict,
        context: ContextCompressor,
        user_settings: dict | None = None,
    ) -> str:
        played_text = self._song_list_text(played_songs[-3:])
        next_name = next_song.get("name", "下一首歌")
        next_artist = self._artist_name(next_song)
        next_facts = self._song_fact_text(next_song)
        selection_reason = (
            (next_song.get("selection_reason") or {}).get("text", "")
            if isinstance(next_song.get("selection_reason"), dict)
            else ""
        )
        recent = context.to_prompt_text()
        style = profile.get("dj_style_suggestion", "温暖自然")
        traits = profile.get("personality", {}).get("traits", [])
        current_mode = (user_settings or {}).get("current_mode", "").strip()
        music_notes = (user_settings or {}).get("music_notes", "").strip()[:200]
        insights = self._radio_insights_text(profile)
        situational = self._situational_text(user_settings)

        prompt = f"""你是小米 memo，一位真实的私人音乐电台主播。现在是{scene}。

刚刚播过的一组歌：
{played_text}

下一首即将播放：{next_name} - {next_artist}
下一首可确认信息：{next_facts}
选曲线索：{selection_reason or '延续刚才一组歌的情绪，同时给听感一点变化。'}

用户画像：{', '.join(traits) if traits else '暂无明确画像'}
主播可用的听感洞察：
{insights}
主播风格：{style}
用户当前状态：{current_mode or '未说明'}
用户备注：{music_notes or '未说明'}
时间与地区上下文：{situational}
最近电台上下文：{recent if recent else '刚开始，没有历史上下文。'}

请生成一段像人类电台 DJ 的节目段落，朗读时长约 20 到 35 秒。
结构要自然：先用一句话回看刚刚这一组歌的共同气质，再介绍下一首歌。
介绍下一首时必须点到歌名和艺人；可以提到专辑、别名、发行时间等“可确认信息”。
如果没有明确创作背景，绝对不要编造幕后故事、发行背景或作者意图；改用声音质感、情绪、编曲听感来讲。
只输出主播要说的话，不要标题、括号、舞台提示或解释。
不要提系统、画像或选曲规则；所有“懂用户”的表达都要像你自己听出来的。
语气要像真实电台主播：有呼吸感、具体、克制、温暖，可以有一点口语停顿，但不要加奇怪语气词，不要卖萌，不要像广告。"""
        return await self.llm.chat(
            self._with_user_settings_hint(prompt, user_settings),
            max_tokens=360,
        )

    async def generate_request_ack(
        self,
        profile: dict,
        scene: str,
        request_text: str,
        user_settings: dict | None = None,
    ) -> str:
        insights = self._radio_insights_text(profile)
        situational = self._situational_text(user_settings)
        prompt = f"""你是小米 memo，一位私人音乐电台主播。现在是{scene}。
用户刚刚点歌/描述想听的方向：{request_text}
主播可用的听感洞察：
{insights}
时间与地区上下文：{situational}

请生成一句很短的回应，朗读约 4 到 8 秒。
只输出主播要说的话，不要标题、括号或解释。
要像真人 DJ 听懂了用户，不要承诺一定找到某一首具体歌，不要说系统、搜索、算法、队列。"""
        return await self.llm.chat(
            self._with_user_settings_hint(prompt, user_settings),
            max_tokens=100,
        )

    def _artist_name(self, song: dict | None) -> str:
        if not isinstance(song, dict):
            return ""
        artist = song.get("artist")
        if isinstance(artist, str) and artist.strip():
            return artist.strip()
        for key in ("ar", "artists"):
            artists = song.get(key)
            if isinstance(artists, list) and artists:
                first = artists[0]
                if isinstance(first, dict):
                    name = first.get("name")
                    if isinstance(name, str):
                        return name.strip()
            elif isinstance(artists, dict):
                name = artists.get("name")
                if isinstance(name, str):
                    return name.strip()
        return ""

    def _song_list_text(self, songs: list[dict]) -> str:
        lines = []
        for song in songs:
            if not isinstance(song, dict):
                continue
            name = song.get("name") or "未知歌名"
            artist = self._artist_name(song) or "未知艺人"
            lines.append(f"- {name} - {artist}")
        return "\n".join(lines) if lines else "- 暂无"

    def _song_fact_text(self, song: dict | None) -> str:
        if not isinstance(song, dict):
            return "暂无更多可确认信息。"
        facts = []
        album = song.get("al") or song.get("album")
        if isinstance(album, dict):
            album_name = album.get("name")
            if isinstance(album_name, str) and album_name.strip():
                facts.append(f"专辑：{album_name.strip()}")
        elif isinstance(album, str) and album.strip():
            facts.append(f"专辑：{album.strip()}")

        aliases = song.get("alia") or song.get("alias")
        if isinstance(aliases, list):
            alias_text = "、".join(
                item.strip() for item in aliases
                if isinstance(item, str) and item.strip()
            )
            if alias_text:
                facts.append(f"别名：{alias_text}")

        publish_time = song.get("publishTime") or song.get("publish_time")
        if publish_time:
            facts.append(f"发行时间：{publish_time}")

        reason = song.get("selection_reason")
        if isinstance(reason, dict):
            reason_text = reason.get("text")
            if isinstance(reason_text, str) and reason_text.strip():
                facts.append(f"本次接歌原因：{reason_text.strip()}")

        return "；".join(facts) if facts else "暂无更多可确认信息。"

    def _radio_insights_text(self, profile: dict | None) -> str:
        if not isinstance(profile, dict):
            return "暂无明确洞察。"
        insights = profile.get("radio_insights")
        if not isinstance(insights, dict):
            return "暂无明确洞察。"
        lines = []
        taste_summary = insights.get("taste_summary")
        if isinstance(taste_summary, str) and taste_summary.strip():
            lines.append(f"- 听感判断：{taste_summary.strip()}")
        for key, label in (
            ("comfort_zone", "熟悉区"),
            ("discovery_direction", "可扩展方向"),
            ("emotional_hooks", "情绪钩子"),
            ("dj_talking_points", "可自然提到的观察"),
        ):
            value = insights.get(key)
            if isinstance(value, list):
                text = "；".join(
                    str(item).strip()
                    for item in value[:4]
                    if str(item).strip()
                )
            elif isinstance(value, str):
                text = value.strip()
            else:
                text = ""
            if text:
                lines.append(f"- {label}：{text}")
        return "\n".join(lines) if lines else "暂无明确洞察。"

    def _situational_text(self, user_settings: dict | None = None) -> str:
        settings = user_settings or {}
        hints = []
        timezone_name = settings.get("timezone_name")
        locale = settings.get("locale")
        region_hint = settings.get("region_hint")
        intent = settings.get("listening_intent")
        if timezone_name:
            hints.append(f"时区：{timezone_name}")
        if locale:
            hints.append(f"语言环境：{locale}")
        if region_hint:
            hints.append(f"地区线索：{region_hint}")
        if isinstance(intent, dict):
            raw_text = (intent.get("raw_text") or "").strip()
            keywords = (intent.get("keywords") or "").strip()
            mood = (intent.get("mood") or "").strip()
            intent_bits = [bit for bit in (raw_text, keywords, mood) if bit]
            if intent_bits:
                hints.append(f"用户刚刚想听：{' / '.join(intent_bits)}")
        return "；".join(hints) if hints else "未说明"

    def _clean_music_notes(self, notes: str) -> str:
        clean = (notes or "").strip()[:200]
        if not clean:
            return ""

        replacements = {
            "傻逼": "不喜欢",
            "sb": "不喜欢",
            "土嗨": "高刺激舞曲或粗糙舞曲",
            "不停": "避免连续播放",
        }
        for old, new in replacements.items():
            clean = clean.replace(old, new)

        if clean != notes.strip()[:200]:
            clean = f"{clean}。请只理解为音乐偏好，不要复述原话。"
        return clean

    def _with_user_settings_hint(
        self,
        prompt: str,
        user_settings: dict | None = None,
    ) -> str:
        display_name = (user_settings or {}).get("display_name", "").strip()
        music_notes = self._clean_music_notes(
            (user_settings or {}).get("music_notes", "")
        )
        current_mode = (user_settings or {}).get("current_mode", "").strip()
        intent = (user_settings or {}).get("listening_intent")
        timezone_name = (user_settings or {}).get("timezone_name", "").strip()
        locale = (user_settings or {}).get("locale", "").strip()
        region_hint = (user_settings or {}).get("region_hint", "").strip()
        hints = []
        if display_name:
            hints.append(f"听众昵称：{display_name}")
        if current_mode:
            hints.append(f"当前状态：{current_mode}")
        if music_notes:
            hints.append(f"音乐偏好备注：{music_notes}")
        if isinstance(intent, dict) and intent.get("raw_text"):
            hints.append(f"刚刚点歌方向：{str(intent.get('raw_text')).strip()[:120]}")
        if timezone_name:
            hints.append(f"本地时区：{timezone_name}")
        if locale:
            hints.append(f"语言环境：{locale}")
        if region_hint:
            hints.append(f"地区线索：{region_hint}")
        if not hints:
            return prompt
        return f"{prompt}\n\n听众补充信息：{'；'.join(hints)}"
