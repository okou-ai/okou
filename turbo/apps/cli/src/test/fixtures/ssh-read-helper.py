import base64
import json
import os
import signal
import sys


request = sys.stdin.read()
os.write(int(os.environ["NODE_CHANNEL_FD"]), (json.dumps(request) + "\n").encode())
if json.loads(request)["method"] == "ssh.diagnostics.capabilities":
    print(json.dumps({"type": "error", "code": "unknown_method", "delivery": "not_dispatched"}))
    sys.exit(1)
if os.environ["SSH_READ_MODE"] == "hang":
    signal.pause()
response = base64.b64decode(os.environ["SSH_READ_RESPONSE"])
sys.stdout.buffer.write(response)
if os.environ["SSH_READ_MODE"] == "extra":
    sys.stdout.buffer.write(response)
sys.stdout.buffer.flush()
sys.exit(int(os.environ["SSH_READ_EXIT"]))
