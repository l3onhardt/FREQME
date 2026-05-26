from dataclasses import dataclass
import asyncio
import json
import re


@dataclass
class SongRequestPick:
    found: bool
    song: dict | None = None
    dj_intro: str = ""
    interpreted_request: str = ""
    search_query: str = ""


class SongRequestAgent:
    def __init__(self, llm, netease, llm_timeout_s: float = 8.0):
        self.llm = llm
        self.netease = netease
        self.llm_timeout_s = llm_timeout_s

    async def resolve(
        self,
        request_text: str,
        profile: dict | None = None,
        user_settings: dict | None = None,
    ) -> SongRequestPick:
        clean_text = " ".join(str(request_text or "").split())[:120]
        if not clean_text:
            return SongRequestPick(found=False)

        plan = await self._plan(clean_text, profile, user_settings)
        queries = self._search_queries(clean_text, plan)
        if self._needs_query_rewrite(clean_text, queries) or self._has_too_literal_query(
            clean_text,
            queries,
        ):
            search_plan = await self._rewrite_queries_only(
                clean_text,
                plan,
                queries,
                profile,
                user_settings,
            )
            rewritten_queries = self._search_queries(clean_text, search_plan)
            if rewritten_queries:
                queries = rewritten_queries
                plan = {**plan, **search_plan}
        candidates, used_query = await self._search_candidate_pool(queries)

        if not candidates:
            rewrite_plan = await self._rewrite_search(
                clean_text,
                plan,
                queries,
                profile,
                user_settings,
            )
            rewrite_queries = self._search_queries(clean_text, rewrite_plan)
            if self._needs_query_rewrite(clean_text, rewrite_queries):
                search_plan = await self._rewrite_queries_only(
                    clean_text,
                    rewrite_plan or plan,
                    self._merge_queries(queries, rewrite_queries),
                    profile,
                    user_settings,
                )
                rewrite_queries = self._merge_queries(
                    self._search_queries(clean_text, search_plan),
                    rewrite_queries,
                )
                if search_plan:
                    rewrite_plan = {**rewrite_plan, **search_plan}
            candidates, used_query = await self._search_candidate_pool(
                [
                    query for query in rewrite_queries
                    if query not in queries
                ]
            )
            if rewrite_plan:
                plan = {**plan, **rewrite_plan}

        if not candidates:
            return SongRequestPick(
                found=False,
                interpreted_request=str(plan.get("interpreted_request") or clean_text),
                search_query=queries[0] if queries else clean_text,
            )

        choice = await self._choose(clean_text, plan, candidates, profile, user_settings)
        song = self._chosen_song(candidates, choice)
        if not song:
            return SongRequestPick(
                found=False,
                interpreted_request=str(plan.get("interpreted_request") or clean_text),
                search_query=used_query,
            )

        interpreted = str(
            choice.get("interpreted_request")
            or plan.get("interpreted_request")
            or clean_text
        ).strip()
        intro = self._clean_text(choice.get("dj_intro")) or self._fallback_intro(
            clean_text,
            interpreted,
            song,
        )
        selected = dict(song)
        selected["selection_reason"] = {
            "type": "request_agent",
            "text": self._clean_text(choice.get("selection_reason"))
            or f"听懂为“{interpreted}”，从搜索结果里直接选了这一版。",
            "request_text": clean_text,
            "interpreted_request": interpreted,
        }
        return SongRequestPick(
            found=True,
            song=selected,
            dj_intro=intro,
            interpreted_request=interpreted,
            search_query=used_query,
        )

    async def _plan(
        self,
        request_text: str,
        profile: dict | None,
        user_settings: dict | None,
    ) -> dict:
        prompt = f"""用户刚刚对私人电台主播说：{request_text}

用户听感洞察：{self._compact_profile(profile)}
时间与地区：{self._compact_settings(user_settings)}

请先理解用户真正想听什么，并给出 1 到 5 个网易云搜索词。
要求：
- 先判断意图，再写搜索词；不要把“我想听”“放点”“来点”这类口语前缀放进搜索词。
- 能识别别名、中文译名、简称和用户可能说错的地方。例如“月之暗面”通常指 Pink Floyd 的 The Dark Side of the Moon；“普2”“普罗科菲耶夫第二钢琴交响曲”通常应理解为“普罗科菲耶夫第二钢琴协奏曲”。
- 如果用户只说了很短的标题、译名或同名作品，比如“夜曲”“月光”“Intro”，不要只给字面标题。要列出多个合理音乐指向，例如流行原曲、古典作品、专辑/作品原文名，让后续候选池一起比较。
- 搜索词可以使用中文、英文、艺人名、作品名、专辑名的组合，以更容易在网易云找到正确结果为准。
只返回 JSON，不要解释：
{{
  "interpreted_request": "你理解出的具体曲目/版本/情绪",
  "search_queries": ["最具体的搜索词", "备选搜索词"]
}}"""
        try:
            response = await asyncio.wait_for(
                self.llm.chat(
                    prompt,
                    max_tokens=220,
                    system="你是私人音乐电台的点歌理解代理。只输出可解析 JSON，不写主播台词。",
                ),
                timeout=self.llm_timeout_s,
            )
            data = self._parse_json(response)
        except Exception:
            data = {}
        return data if isinstance(data, dict) else {}

    async def _rewrite_queries_only(
        self,
        request_text: str,
        plan: dict,
        attempted_queries: list[str],
        profile: dict | None,
        user_settings: dict | None,
    ) -> dict:
        prompt = f"""用户原话：{request_text}
当前理解：{plan.get("interpreted_request") or "尚未稳定理解"}
已有搜索词：{attempted_queries}
用户听感洞察：{self._compact_profile(profile)}
时间与地区：{self._compact_settings(user_settings)}

请把用户的自然语言点歌请求改写成网易云更容易命中的搜索词。
要求：
- 先理解用户真正指向的歌、专辑、作品、版本或风格，再写搜索词。
- 如果用户说的是简称、译名、别名、口误、外文作品或古典作品，要改写成更可能被曲库收录的艺人/作曲家/作品名/专辑名/版本组合。
- 如果用户说的是短标题或同名作品，不要只输出字面标题；要输出多个可能解释的搜索词，让系统把候选放在一起比较。
- 不要把“我想听”“放点”“来点”“给我接”这类口语命令放进搜索词。
- 不要只返回用户嘴里的半截词；搜索词要像一个懂音乐的人会拿去搜的完整关键词。

只输出 1 到 5 行搜索词，每行一个。不要 JSON，不要编号，不要解释。"""
        try:
            response = await asyncio.wait_for(
                self.llm.chat(
                    prompt,
                    max_tokens=180,
                    system="你是私人音乐电台的点歌搜索改写器。只输出搜索词，每行一个。",
                ),
                timeout=self.llm_timeout_s,
            )
            queries = self._parse_query_lines(response)
        except Exception:
            queries = []
        return {
            "interpreted_request": str(plan.get("interpreted_request") or request_text),
            "search_queries": queries,
        }

    async def _rewrite_search(
        self,
        request_text: str,
        plan: dict,
        attempted_queries: list[str],
        profile: dict | None,
        user_settings: dict | None,
    ) -> dict:
        prompt = f"""用户原话：{request_text}
你第一轮理解为：{plan.get("interpreted_request") or request_text}
第一轮搜索词都没有找到候选：{attempted_queries}
用户听感洞察：{self._compact_profile(profile)}
时间与地区：{self._compact_settings(user_settings)}

请重新判断用户真正想听的对象，并改写网易云搜索词。
重点：如果是译名、别名、简称、短标题、同名作品或外文作品，要换成更可能被曲库收录的原文名/艺人名/专辑名，并给出多个合理方向；不要退回用户原话搜索。
只返回 JSON，不要解释：
{{
  "interpreted_request": "修正后的理解",
  "search_queries": ["改写后的搜索词", "另一个备选搜索词"]
}}"""
        try:
            response = await asyncio.wait_for(
                self.llm.chat(
                    prompt,
                    max_tokens=220,
                    system="你是私人音乐电台的点歌理解代理。只输出可解析 JSON，不写主播台词。",
                ),
                timeout=self.llm_timeout_s,
            )
            data = self._parse_json(response)
        except Exception:
            data = {}
        return data if isinstance(data, dict) else {}

    async def _choose(
        self,
        request_text: str,
        plan: dict,
        candidates: list[dict],
        profile: dict | None,
        user_settings: dict | None,
    ) -> dict:
        prompt = f"""用户原话：{request_text}
你对请求的理解：{plan.get("interpreted_request") or request_text}
用户听感洞察：{self._compact_profile(profile)}
时间与地区：{self._compact_settings(user_settings)}

搜索候选如下，候选可能来自多个不同的意图搜索词。请像一个会做节目的人一样，先判断用户真实意图，再直接挑一个最适合播放的版本。
不要默认选第一个候选；要看标题、艺人、专辑、别名和“来自搜索”。不要把选择权丢回给用户；用户表达不精确时，你要按最合理的音乐理解来选。
候选列表：
{self._candidate_text(candidates)}

只返回 JSON，不要解释：
{{
  "chosen_index": 0,
  "chosen_id": "候选歌曲 id",
  "interpreted_request": "最终按什么曲目/版本理解",
  "selection_reason": "一句内部选曲理由",
  "dj_intro": "主播要说的话，2 到 4 句。要介绍你选的版本、演奏者/艺人、可确认的歌曲或专辑信息；如果没有可靠创作背景，不要编造。语气像温暖、有磁性的电台 DJ。"
}}"""
        try:
            response = await asyncio.wait_for(
                self.llm.chat(
                    prompt,
                    max_tokens=420,
                    system="你是私人音乐电台的点歌选版代理。只输出可解析 JSON，不要输出 JSON 之外的文字。",
                ),
                timeout=self.llm_timeout_s,
            )
            data = self._parse_json(response)
        except Exception:
            data = {}
        return data if isinstance(data, dict) else {}

    def _search_queries(self, request_text: str, plan: dict) -> list[str]:
        queries = []

        def add(value) -> None:
            query = self._clean_search_query(request_text, value)
            if query and query not in queries:
                queries.append(query)

        planned_queries = plan.get("search_queries") or []
        if isinstance(planned_queries, str):
            planned_queries = [planned_queries]
        for query in planned_queries if isinstance(planned_queries, list) else []:
            add(query)
        add(plan.get("search_query"))
        return queries

    def _clean_search_query(self, request_text: str, value) -> str:
        query = " ".join(str(value or "").split())[:120]
        if not query:
            return ""

        command_fragments = {
            "听",
            "想听",
            "我想听",
            "想要听",
            "我要听",
            "放",
            "放点",
            "来点",
            "播放",
            "点一首",
            "点歌",
        }
        if query in command_fragments:
            return ""

        raw_request = " ".join(str(request_text or "").split())[:120]
        if query == raw_request and self._has_request_command(raw_request):
            return ""

        return query

    def _needs_query_rewrite(self, request_text: str, queries: list[str]) -> bool:
        if not queries:
            return True
        target = self._request_target_text(request_text)
        if not target:
            return False
        normalized_target = self._normalize_match_text(target)
        checked = 0
        for query in queries:
            normalized_query = self._normalize_match_text(query)
            if not normalized_query:
                continue
            checked += 1
            if normalized_query == normalized_target and self._has_request_command(request_text):
                continue
            if (
                normalized_query in normalized_target
                and len(normalized_query) <= 12
                and " " not in query.strip()
            ):
                continue
            return False
        return checked > 0

    def _has_too_literal_query(self, request_text: str, queries: list[str]) -> bool:
        target = self._request_target_text(request_text)
        normalized_target = self._normalize_match_text(target)
        if not normalized_target:
            return False
        checked = 0
        for query in queries:
            normalized_query = self._normalize_match_text(query)
            if not normalized_query:
                continue
            checked += 1
            if normalized_query == normalized_target:
                continue
            if self._query_is_mostly_target_tokens(query, target):
                continue
            return False
        return checked > 0

    def _query_is_mostly_target_tokens(self, query: str, target: str) -> bool:
        query_tokens = self._query_tokens(query)
        target_tokens = self._query_tokens(target)
        if len(query_tokens) < 2 or not target_tokens:
            return False
        matched = 0
        for token in query_tokens:
            if any(
                token == target_token
                or token in target_token
                or target_token in token
                for target_token in target_tokens
            ):
                matched += 1
        return matched == len(query_tokens)

    def _query_tokens(self, value: str) -> list[str]:
        text = str(value or "").casefold()
        tokens = re.findall(r"[a-z0-9]+|[\u4e00-\u9fff]+", text)
        expanded = []
        for token in tokens:
            if re.fullmatch(r"[\u4e00-\u9fff]+", token) and len(token) > 4:
                expanded.extend(token[index:index + 2] for index in range(len(token) - 1))
            expanded.append(token)
        return [token for token in expanded if token]

    def _request_target_text(self, text: str) -> str:
        target = " ".join(str(text or "").split())[:120]
        for marker in (
            "我想听",
            "想听",
            "想要听",
            "我要听",
            "帮我放",
            "给我放",
            "放点",
            "来点",
            "播放",
            "点一首",
        ):
            if marker in target:
                target = target.rsplit(marker, 1)[-1]
        return target.strip(" ，,。.!！?？")

    def _merge_queries(self, first: list[str], second: list[str]) -> list[str]:
        merged = []
        for query in list(first or []) + list(second or []):
            if query and query not in merged:
                merged.append(query)
        return merged

    def _parse_query_lines(self, text: str) -> list[str]:
        queries = []
        for line in str(text or "").splitlines():
            cleaned = re.sub(r"^\s*[-*•\d.)、]+", "", line).strip()
            cleaned = cleaned.strip("\"'“”‘’`")
            if (
                not cleaned
                or cleaned.startswith(("{", "}", "[", "]", "```"))
                or '":' in cleaned
                or len(cleaned) > 80
            ):
                continue
            if cleaned and cleaned not in queries:
                queries.append(cleaned[:120])
        return queries[:5]

    def _has_request_command(self, text: str) -> bool:
        return any(
            marker in str(text or "")
            for marker in (
                "我想听",
                "想听",
                "想要听",
                "我要听",
                "帮我放",
                "给我放",
                "放点",
                "来点",
                "播放",
                "点一首",
            )
        )

    async def _search_candidate_pool(self, queries: list[str]) -> tuple[list[dict], str]:
        by_query = []
        seen_ids = set()
        used_queries = []
        for query in queries[:5]:
            try:
                candidates = self._pool_list(await self.netease.search(query, limit=8))
            except Exception:
                candidates = []
            if not candidates:
                continue
            used_queries.append(query)
            query_candidates = []
            for candidate in candidates:
                if not isinstance(candidate, dict):
                    continue
                candidate_id = str(candidate.get("id") or "").strip()
                dedupe_key = candidate_id or self._normalize_match_text(
                    f"{candidate.get('name')} {self._artist_name(candidate)} {self._album_name(candidate)}"
                )
                if dedupe_key in seen_ids:
                    continue
                seen_ids.add(dedupe_key)
                pooled_candidate = dict(candidate)
                pooled_candidate["matched_query"] = query
                query_candidates.append(pooled_candidate)
            if query_candidates:
                by_query.append(query_candidates)
        return self._interleave_candidates(by_query, limit=24), " / ".join(used_queries)

    def _interleave_candidates(self, candidate_groups: list[list[dict]], limit: int) -> list[dict]:
        pooled = []
        max_group_size = max((len(group) for group in candidate_groups), default=0)
        for index in range(max_group_size):
            for group in candidate_groups:
                if index < len(group):
                    pooled.append(group[index])
                    if len(pooled) >= limit:
                        return pooled
        return pooled

    def _chosen_song(self, candidates: list[dict], choice: dict) -> dict | None:
        chosen_id = str(choice.get("chosen_id") or "").strip()
        if chosen_id:
            for candidate in candidates:
                if str(candidate.get("id") or "").strip() == chosen_id:
                    return candidate
        try:
            index = int(choice.get("chosen_index", 0))
        except Exception:
            index = 0
        if 0 <= index < len(candidates):
            return candidates[index]
        return candidates[0] if candidates else None

    def _candidate_text(self, candidates: list[dict]) -> str:
        lines = []
        for index, song in enumerate(candidates[:8]):
            name = str(song.get("name") or "未知曲目").strip()
            artist = self._artist_name(song) or "未知艺人"
            album = self._album_name(song)
            aliases = self._aliases(song)
            bits = [f"{index}. {name} - {artist}", f"id={song.get('id')}"]
            if album:
                bits.append(f"专辑={album}")
            if aliases:
                bits.append(f"别名={aliases}")
            matched_query = song.get("matched_query")
            if matched_query:
                bits.append(f"来自搜索={matched_query}")
            publish_time = song.get("publishTime") or song.get("publish_time")
            if publish_time:
                bits.append(f"发布时间={publish_time}")
            lines.append(" | ".join(bits))
        return "\n".join(lines)

    def _fallback_intro(self, request_text: str, interpreted: str, song: dict) -> str:
        name = song.get("name") or "这一版"
        artist = self._artist_name(song)
        target = interpreted or request_text
        if artist:
            return f"我按“{target}”给你选了 {artist} 的《{name}》。先不把话说满，让这版自己把情绪铺开。"
        return f"我按“{target}”给你选了《{name}》。先不把话说满，让这一版自己把情绪铺开。"

    def _parse_json(self, text: str) -> dict:
        raw = str(text or "").strip()
        if raw.startswith("```"):
            raw = re.sub(r"^```(?:json)?", "", raw, flags=re.IGNORECASE).strip()
            raw = re.sub(r"```$", "", raw).strip()
        match = re.search(r"\{.*\}", raw, flags=re.DOTALL)
        if not match:
            return {}
        try:
            return json.loads(match.group(0))
        except json.JSONDecodeError:
            return {}

    def _normalize_match_text(self, value) -> str:
        text = str(value or "").casefold()
        return re.sub(r"[\W_]+", "", text, flags=re.UNICODE)

    def _pool_list(self, value) -> list[dict]:
        return value if isinstance(value, list) else []

    def _artist_name(self, song: dict | None) -> str:
        if not isinstance(song, dict):
            return ""
        artist = song.get("artist")
        if isinstance(artist, str) and artist.strip():
            return artist.strip()
        for key in ("ar", "artists"):
            artists = song.get(key)
            if isinstance(artists, list) and artists:
                names = [
                    item.get("name", "").strip()
                    for item in artists
                    if isinstance(item, dict) and item.get("name")
                ]
                if names:
                    return " / ".join(names[:3])
            elif isinstance(artists, dict):
                name = artists.get("name")
                if isinstance(name, str) and name.strip():
                    return name.strip()
        return ""

    def _album_name(self, song: dict | None) -> str:
        if not isinstance(song, dict):
            return ""
        album = song.get("al") or song.get("album")
        if isinstance(album, dict):
            return str(album.get("name") or "").strip()
        if isinstance(album, str):
            return album.strip()
        return ""

    def _aliases(self, song: dict | None) -> str:
        if not isinstance(song, dict):
            return ""
        aliases = song.get("alia") or song.get("alias")
        if not isinstance(aliases, list):
            return ""
        return "、".join(
            str(alias).strip()
            for alias in aliases[:3]
            if str(alias).strip()
        )

    def _compact_profile(self, profile: dict | None) -> str:
        if not isinstance(profile, dict):
            return "暂无"
        insights = profile.get("radio_insights")
        if not isinstance(insights, dict):
            traits = (profile.get("personality") or {}).get("traits", [])
            return "、".join(str(item) for item in traits[:4]) if traits else "暂无"
        parts = []
        for key in ("taste_summary", "comfort_zone", "discovery_direction", "emotional_hooks"):
            value = insights.get(key)
            if isinstance(value, list):
                parts.extend(str(item).strip() for item in value[:3] if str(item).strip())
            elif isinstance(value, str) and value.strip():
                parts.append(value.strip())
        return "；".join(parts[:6]) if parts else "暂无"

    def _compact_settings(self, user_settings: dict | None) -> str:
        if not isinstance(user_settings, dict):
            return "暂无"
        parts = []
        for key, label in (
            ("timezone_name", "时区"),
            ("region_hint", "地区"),
            ("current_mode", "状态"),
            ("music_notes", "备注"),
        ):
            value = str(user_settings.get(key) or "").strip()
            if value:
                parts.append(f"{label}：{value[:80]}")
        return "；".join(parts) if parts else "暂无"

    def _clean_text(self, value) -> str:
        return " ".join(str(value or "").split()).strip()
