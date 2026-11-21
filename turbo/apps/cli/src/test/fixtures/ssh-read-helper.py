import os
import sys


request = sys.stdin.buffer.read()
# Both the RPC request and Node's IPC frames are single-line JSON.
os.write(int(os.environ["NODE_CHANNEL_FD"]), request + b"\n")
if os.environ["SSH_READ_MODE"] == "hang":
    import signal

    signal.pause()
response = os.environb[b"SSH_READ_RESPONSE"] + b"\n"
sys.stdout.buffer.write(response)
if os.environ["SSH_READ_MODE"] == "extra":
    sys.stdout.buffer.write(response)
sys.stdout.buffer.flush()
sys.exit(int(os.environ["SSH_READ_EXIT"]))
