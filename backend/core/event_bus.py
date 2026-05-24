import asyncio
from collections import defaultdict
from typing import Callable, Awaitable

EventHandler = Callable[..., Awaitable[None]]


class EventBus:
    def __init__(self):
        self._handlers: dict[str, list[EventHandler]] = defaultdict(list)

    def on(self, event: str, handler: EventHandler) -> None:
        self._handlers[event].append(handler)

    async def emit(self, event: str, **data) -> None:
        for handler in self._handlers.get(event, []):
            try:
                await handler(**data)
            except Exception as e:
                print(f"[EventBus] Error handling {event}: {e}")
