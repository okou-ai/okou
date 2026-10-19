"""Apply limits and owner-death fencing before exec of the fixture-owned VMM."""

import ctypes
import json
import os
import resource
import signal
import sys


def main():
    parent_pid = int(sys.argv[1])
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(1, signal.SIGKILL, 0, 0, 0) != 0:
        raise OSError(ctypes.get_errno(), "PR_SET_PDEATHSIG failed")
    if os.getppid() != parent_pid:
        os.kill(os.getpid(), signal.SIGKILL)
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    resource.setrlimit(resource.RLIMIT_FSIZE, (131072, 131072))
    signal.pthread_sigmask(signal.SIG_SETMASK, json.loads(sys.argv[2]))
    os.execv(sys.argv[3], sys.argv[3:])


if __name__ == "__main__":
    main()
