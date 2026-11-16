"""Infrastructure startup failures cannot be constructed through HTTP input.

Exercise the factory with real workers. Failed submit() calls expose no future,
so observe the real pool to verify that inaccessible bootstrap work is cleaned
up. Isolate scenarios in processes so a rollback deadlock cannot hang pytest.
"""

import multiprocessing
import signal
import threading
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import patch

import pytest

import thread_pool


class _StartupInterrupted(BaseException):
    pass


def _assert_full_capacity(pool: ThreadPoolExecutor, workers: int) -> None:
    rendezvous = threading.Barrier(workers)

    def run() -> str:
        rendezvous.wait(timeout=5)
        return threading.current_thread().name

    # After startup, payload submissions must not depend on creating threads,
    # even when all requested workers need to run concurrently.
    with patch.object(threading.Thread, "start", side_effect=RuntimeError("unexpected new worker")):
        futures = [pool.submit(run) for _ in range(workers)]
        names = {future.result(timeout=5) for future in futures}
    assert len(names) == workers


def _start_and_use_pool(workers: int) -> None:
    with thread_pool.start_thread_pool(
        max_workers=workers, thread_name_prefix="thread-pool-success"
    ) as pool:
        _assert_full_capacity(pool, workers)


def _fail_start_and_recover(error_type: type[BaseException], failed_worker: int) -> None:
    pools: list[ThreadPoolExecutor] = []
    failure = error_type("worker creation failed")
    start = threading.Thread.start

    class ObservedPool(ThreadPoolExecutor):
        def __init__(self, **kwargs) -> None:
            super().__init__(**kwargs)
            pools.append(self)

    def fail_start(thread: threading.Thread) -> None:
        if thread.name == f"thread-pool-failure_{failed_worker}":
            raise failure
        start(thread)

    with (
        patch.object(thread_pool, "ThreadPoolExecutor", ObservedPool),
        patch.object(threading.Thread, "start", fail_start),
        pytest.raises(error_type, match="worker creation failed") as raised,
    ):
        thread_pool.start_thread_pool(max_workers=4, thread_name_prefix="thread-pool-failure")

    assert raised.value is failure
    [failed_pool] = pools
    assert len(failed_pool._threads) == failed_worker
    assert all(not worker.is_alive() for worker in failed_pool._threads)
    with pytest.raises(RuntimeError, match="shutdown"):
        failed_pool.submit(lambda: None)
    # A shutdown sentinel is allowed; queued bootstrap work is not. Keep the
    # failed pool alive so garbage collection cannot conceal missing cleanup.
    assert failed_pool._work_queue.get_nowait() is None
    assert failed_pool._work_queue.empty()

    with thread_pool.start_thread_pool(
        max_workers=4, thread_name_prefix="thread-pool-recovered"
    ) as recovered:
        _assert_full_capacity(recovered, 4)


def _interrupt_release_and_recover() -> None:
    assert signal.getsignal(signal.SIGINT) is signal.default_int_handler
    pools: list[ThreadPoolExecutor] = []
    interruptions: list[KeyboardInterrupt] = []
    event_set = threading.Event.set
    main_thread_id = threading.get_ident()
    interrupted = False

    class ObservedPool(ThreadPoolExecutor):
        def __init__(self, **kwargs) -> None:
            super().__init__(**kwargs)
            pools.append(self)

    def interrupt_release(event: threading.Event) -> None:
        nonlocal interrupted
        # Thread.start() signals its own Event in the worker. Interrupt only
        # the factory's first main-thread release, after worker startup.
        if threading.get_ident() == main_thread_id and not interrupted:
            interrupted = True
            try:
                signal.raise_signal(signal.SIGINT)
            except KeyboardInterrupt as error:
                interruptions.append(error)
                raise
        event_set(event)

    with (
        patch.object(thread_pool, "ThreadPoolExecutor", ObservedPool),
        patch.object(threading.Event, "set", interrupt_release),
        pytest.raises(KeyboardInterrupt) as raised,
    ):
        thread_pool.start_thread_pool(max_workers=4, thread_name_prefix="thread-pool-release")

    assert raised.value is interruptions[0]
    [failed_pool] = pools
    assert len(failed_pool._threads) == 4
    assert all(not worker.is_alive() for worker in failed_pool._threads)
    with pytest.raises(RuntimeError, match="shutdown"):
        failed_pool.submit(lambda: None)

    with thread_pool.start_thread_pool(
        max_workers=4, thread_name_prefix="thread-pool-release-recovered"
    ) as recovered:
        _assert_full_capacity(recovered, 4)


def _run_in_process(target: Callable[..., None], *args: object) -> None:
    process = multiprocessing.get_context("spawn").Process(target=target, args=args)
    process.start()
    try:
        process.join(timeout=15)
        assert not process.is_alive(), "thread-pool startup or cleanup deadlocked"
        assert process.exitcode == 0
    finally:
        if process.is_alive():
            process.kill()
            process.join(timeout=5)
        process.close()


@pytest.mark.parametrize("workers", [1, 4])
def test_returned_pool_has_all_workers_available(workers: int) -> None:
    _run_in_process(_start_and_use_pool, workers)


@pytest.mark.parametrize("error_type", [RuntimeError, OSError, _StartupInterrupted])
@pytest.mark.parametrize("failed_worker", [0, 2], ids=["first-worker", "partial-start"])
def test_start_failure_cleans_up_and_allows_recovery(
    error_type: type[BaseException], failed_worker: int
) -> None:
    _run_in_process(_fail_start_and_recover, error_type, failed_worker)


def test_release_interruption_joins_workers_and_allows_recovery() -> None:
    _run_in_process(_interrupt_release_and_recover)
