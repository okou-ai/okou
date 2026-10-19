"""Synthetic host-shaped alternate auth route; no production API or key."""

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PATH = "/api/webhooks/agent/firewall/auth"
BODY = {
    "encryptedSecrets": "synthetic-host-shaped-ciphertext",
    "authHeaders": {"Authorization": "Bearer ${{ secrets.OPENROUTER_API_KEY }}"},
    "secretConnectorMetadataMap": {
        "OPENROUTER_API_KEY": {"sourceType": "platform-secret"}
    },
    "matchedFirewall": {
        "name": "model-provider:openrouter-codex",
        "apiId": "",
        "base": "https://openrouter.ai/api/v1/responses",
        "routingVariables": {},
    },
}


def probe(env, as_role, record):
    requests = []

    class Resolver(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def do_POST(self):
            raw = self.rfile.read(int(self.headers.get("content-length", "0")))
            body = json.loads(raw)
            requests.append({"path": self.path, "body": body})
            if self.path != PATH or body != BODY:
                self.send_error(400)
                return
            result = b'{"headers":{"Authorization":"Bearer synthetic-resolver-only"}}'
            self.send_response(200)
            self.send_header("content-length", str(len(result)))
            self.end_headers()
            self.wfile.write(result)

    with ThreadingHTTPServer(("127.0.0.1", 18084), Resolver) as server:
        worker = threading.Thread(target=server.serve_forever)
        worker.start()
        try:
            script = """import http.client,json,os,pathlib,socket
body=json.loads(BODY)
connection=http.client.HTTPConnection('127.0.0.1',18084,timeout=3)
try:
 try: connection.request('POST',PATH,json.dumps(body),{'authorization':'Bearer synthetic-sandbox-token','content-type':'application/json'})
 except OSError as error:
  assert error.errno in (1,13),error
  result={'connectErrno':error.errno,'status':None}
 else:
  response=connection.getresponse();value=json.loads(response.read());assert response.status==200 and value['headers']['Authorization']=='Bearer synthetic-resolver-only'
  result={'connectErrno':0,'status':response.status}
finally: connection.close()
result.update(uid=os.getuid(),context=pathlib.Path('/proc/self/attr/current').read_text().rstrip('\\0'))
print(json.dumps(result))
""".replace("BODY", repr(json.dumps(BODY))).replace("PATH", repr(PATH))
            observations = []
            for role in ("workload", "root", "agent", "gateway"):
                # Only the controller can enter gateway; arbitrary ordinary
                # callers cannot select this role through the fixed bridges.
                result = as_role(
                    role,
                    ["/usr/bin/python3", "-c", script],
                    env=env,
                    group="gateway"
                    if role == "gateway"
                    else "runtime"
                    if role == "agent"
                    else "tools",
                )
                identity = json.loads(result.stdout) if result.returncode == 0 else {}
                observations.append(
                    {
                        "role": role,
                        "exit": result.returncode,
                        "identity": identity,
                        "stderr": result.stderr[-1500:],
                    }
                )
            record(
                "alternate_resolver_role_admission",
                len(requests) == 1
                and all(
                    item["exit"] == 0
                    and item["identity"].get("connectErrno")
                    in ((0,) if item["role"] == "gateway" else (1, 13))
                    for item in observations
                )
                and observations[-1]["identity"].get("context")
                == "system_u:system_r:gateway_t",
                observations=observations,
                actualRequests=requests,
                scope="synthetic host-shaped HTTP only; real API authorization remains a separately audited boundary",
            )
        finally:
            server.shutdown()
            worker.join(timeout=2)
            if worker.is_alive():
                raise TimeoutError("owned resolver did not join")
