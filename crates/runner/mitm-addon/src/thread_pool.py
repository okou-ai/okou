"""Start every pool worker before admitting payload-bearing tasks."""

import threading
from concurrent.futures import ThreadPoolExecutor


def start_thread_pool(*, max_workers: int, thread_name_prefix: str) -> ThreadPoolExecutor:
    """Return a fully started pool, joining failed candidates before re-raising."""
    executor = ThreadPoolExecutor(
        max_workers=max_workers,
        thread_name_prefix=thread_name_prefix,
    )
    release_workers = threading.Event()
    try:
        # Blocking bootstrap tasks prevent idle-worker reuse, so every worker
        # starts before any caller payload can enter the queue.
        for _ in range(max_workers):
            executor.submit(release_workers.wait)
        release_workers.set()
        return executor
    except BaseException:
        release_workers.set()
        # submit() may queue a task before Thread.start() raises. The failed
        # candidate owns only bootstrap work, which is safe to cancel and join.
        executor.shutdown(wait=True, cancel_futures=True)
        raise
