import ctypes
import json
import os
import resource
import signal
import sys

parent = int(sys.argv[1])
libc = ctypes.CDLL(None, use_errno=True)
if libc.prctl(1, signal.SIGKILL, 0, 0, 0):
    raise OSError(ctypes.get_errno(), "PR_SET_PDEATHSIG")
if os.getppid() != parent:
    os.kill(os.getpid(), signal.SIGKILL)
resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
signal.pthread_sigmask(signal.SIG_SETMASK, json.loads(sys.argv[2]))
os.execv(sys.argv[3], sys.argv[3:])
