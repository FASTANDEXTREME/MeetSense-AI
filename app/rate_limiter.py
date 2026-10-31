import asyncio
import time
import logging
from collections import defaultdict

logger = logging.getLogger("meetsense")


class SummaryRateLimiter:
    """
    Per-room rate limiter for Groq summary calls.

    - min_interval: minimum seconds between calls for the same room
    - max_concurrent: global cap on simultaneous API calls
    """

    def __init__(self, min_interval: float = 60.0, max_concurrent: int = 2):
        self.min_interval = min_interval
        self.max_concurrent = max_concurrent
        self._last_call = defaultdict(float)
        self._semaphore = asyncio.Semaphore(max_concurrent)
        self._pending = defaultdict(bool)

    def can_call(self, room_id: str) -> bool:
        """Check if enough time has passed and no call is already pending."""
        if self._pending.get(room_id):
            return False
        elapsed = time.time() - self._last_call[room_id]
        return elapsed >= self.min_interval

    async def execute(self, room_id: str, coro_or_fn):
        """
        Execute the coroutine (or async callable) if rate limit allows, otherwise return None.
        Uses a semaphore to cap global concurrent API calls.
        """
        if not self.can_call(room_id):
            if asyncio.iscoroutine(coro_or_fn):
                coro_or_fn.close()
            logger.debug(f"Rate limiter: skipping summary for room '{room_id}' (too soon or pending)")
            return None

        self._pending[room_id] = True
        try:
            async with self._semaphore:
                self._last_call[room_id] = time.time()
                coro = coro_or_fn() if callable(coro_or_fn) else coro_or_fn
                return await coro
        finally:
            self._pending[room_id] = False

    def force_reset(self, room_id: str):
        """Allow immediate next call (used for manual summary requests)."""
        self._last_call[room_id] = 0
        self._pending[room_id] = False

    def cleanup_room(self, room_id: str):
        """Remove rate-limiter state for an empty room."""
        self._last_call.pop(room_id, None)
        self._pending.pop(room_id, None)


# Singleton: 60 seconds min interval, max 2 concurrent API calls globally
rate_limiter = SummaryRateLimiter(min_interval=60.0, max_concurrent=2)
