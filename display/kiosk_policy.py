"""Pure recovery and screen policies. Times are monotonic seconds supplied by the caller."""
from dataclasses import dataclass


@dataclass
class RecoveryPolicy:
    front: str = "offline"
    ready_samples: int = 0
    failed_since: float | None = None

    def update(self, now: float, ha_state: str, local_ready: bool) -> str:
        self.ready_samples = self.ready_samples + 1 if ha_state == "ready" else 0
        if ha_state == "ready":
            self.failed_since = None
        elif self.failed_since is None:
            self.failed_since = now
        if self.front == "ha" and ha_state == "ready":
            return self.front
        if self.front == "ha" and now - self.failed_since < 20:
            return self.front
        if self.ready_samples >= 2:
            self.front = "ha"
        else:
            self.front = "local" if local_ready else "offline"
        return self.front


@dataclass
class RestartPolicy:
    failures: int = 0
    started_at: float = 0

    def failed(self, now: float) -> float:
        if now - self.started_at >= 300:
            self.failures = 0
        delay = (5, 15, 30, 60)[min(self.failures, 3)]
        self.failures += 1
        return now + delay


@dataclass
class ScreenPolicy:
    awake_until: float = 0
    lit: bool = True
    consuming: bool = False
    was_touched: bool = False

    def update(self, now: float, hour: int, touched: bool) -> tuple[bool, bool]:
        day = 7 <= hour < 23
        if self.consuming and not touched:
            self.consuming = False
        if not self.lit and touched:
            self.consuming = True
        # Refresh while held and on release: sleep only after 120 idle seconds.
        if touched or self.was_touched:
            self.awake_until = now + 120
        self.was_touched = touched
        self.lit = day or now < self.awake_until or touched
        return self.lit, self.consuming or not self.lit
