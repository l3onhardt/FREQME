from dataclasses import dataclass, field


@dataclass
class PlaybackQueueItem:
    song: dict
    url: str
    status: str = "ready"
    selection_reason: dict = field(default_factory=dict)
    segue_text: str = ""
    tts_hash: str = ""


class PlaybackQueue:
    def __init__(self, prewarm_depth: int = 3):
        self.prewarm_depth = prewarm_depth
        self.items: list[PlaybackQueueItem] = []

    def add_ready(
        self,
        song: dict,
        url: str,
        selection_reason: dict | None = None,
        segue_text: str = "",
        tts_hash: str = "",
    ) -> PlaybackQueueItem:
        item = PlaybackQueueItem(
            song=song,
            url=url,
            status="ready",
            selection_reason=selection_reason or song.get("selection_reason", {}) or {},
            segue_text=segue_text,
            tts_hash=tts_hash,
        )
        self.items.append(item)
        return item

    def current(self) -> PlaybackQueueItem | None:
        return next((item for item in self.items if item.status == "playing"), None)

    def ready_items(self) -> list[PlaybackQueueItem]:
        return [item for item in self.items if item.status == "ready"]

    def clear_ready(self) -> int:
        ready_count = sum(1 for item in self.items if item.status == "ready")
        self.items = [item for item in self.items if item.status != "ready"]
        return ready_count

    def promote_next(self, previous_event: str = "played") -> PlaybackQueueItem | None:
        current = self.current()
        if current:
            current.status = previous_event
        next_item = next((item for item in self.items if item.status == "ready"), None)
        if next_item:
            next_item.status = "playing"
        self._trim_old_items()
        return next_item

    def mark_current(self, status: str) -> None:
        current = self.current()
        if current:
            current.status = status

    def prewarm_needed(self) -> int:
        active_count = sum(
            1 for item in self.items
            if item.status in {"playing", "ready", "prewarming"}
        )
        return max(0, self.prewarm_depth - active_count)

    def _trim_old_items(self) -> None:
        old = [item for item in self.items if item.status in {"played", "skipped", "failed"}]
        if len(old) <= 10:
            return
        keep_old = {id(item) for item in old[-10:]}
        self.items = [
            item for item in self.items
            if item.status not in {"played", "skipped", "failed"} or id(item) in keep_old
        ]
