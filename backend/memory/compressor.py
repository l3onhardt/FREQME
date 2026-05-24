class ContextCompressor:
    def __init__(self, max_rounds: int = 20):
        self.max_rounds = max_rounds
        self.recent_context: list[dict] = []

    def add_round(self, round_data: dict) -> list[dict] | None:
        self.recent_context.append(round_data)
        if len(self.recent_context) > self.max_rounds:
            overflow = self.recent_context[: -self.max_rounds]
            self.recent_context = self.recent_context[-self.max_rounds:]
            return overflow
        return None

    async def compress(self, overflow: list[dict], llm_router) -> str:
        text = "\n".join(r.get("text", "") for r in overflow)
        prompt = f"用一句话总结以下电台对话内容（不超过50字）：\n{text}"
        summary = await llm_router.chat(prompt, max_tokens=80)
        return summary

    def get_context(self) -> list[dict]:
        return self.recent_context

    def to_prompt_text(self) -> str:
        return "\n".join(
            f"[{r.get('timestamp', '')}] {r.get('speaker', 'memo')}: {r.get('text', '')}"
            for r in self.recent_context[-10:]
        )
