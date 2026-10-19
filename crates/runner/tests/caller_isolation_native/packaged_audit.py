"""Bounded kernel denial evidence for one owned native operation."""

import errno
import os
from contextlib import contextmanager


@contextmanager
def capture():
    observed = {}
    with os.fdopen(
        os.open("/dev/kmsg", os.O_RDONLY | os.O_NONBLOCK | os.O_CLOEXEC),
        "rb",
        buffering=0,
    ) as source:
        os.lseek(source.fileno(), 0, os.SEEK_END)
        try:
            yield observed
        finally:
            raw = b""
            overruns = 0
            while len(raw) < 262144:
                try:
                    chunk = os.read(source.fileno(), 16384)
                except BlockingIOError:
                    break
                except OSError as error:
                    if error.errno != errno.EPIPE or overruns >= 8:
                        raise
                    overruns += 1
                    continue
                if not chunk:
                    break
                raw += chunk
            observed["denials"] = "\n".join(
                line
                for line in raw.decode(errors="replace").splitlines()
                if "avc:" in line
            )[-6000:]
            if overruns:
                observed["denials"] = (
                    f"kernel ring overruns: {overruns}\n" + observed["denials"]
                )
