"""Real gateway resource, bounded IO and fail-closed local OOM observations."""

import json
import os
import select
import subprocess
import time
from contextlib import contextmanager
from pathlib import Path


def values(path):
    return dict(line.split() for line in path.read_text().splitlines())


@contextmanager
def running(cgroup, fixture):
    started = time.monotonic()
    with (fixture / "gateway.stderr").open("a") as stderr:
        process = subprocess.Popen(
            [
                str(fixture / "entry"),
                "gateway",
                "/usr/bin/python3",
                str(fixture / "packaged_gateway.py"),
                str(started),
            ],
            stdout=subprocess.PIPE,
            stderr=stderr,
            text=True,
            cwd="/home/user/workspace",
        )
        try:
            if not select.select([process.stdout], [], [], 10)[0]:
                raise TimeoutError("gateway readiness")
            line = process.stdout.readline(4096)
            if not line:
                raise ValueError(
                    "gateway startup: "
                    + (fixture / "gateway.stderr").read_text()[-2000:]
                )
            identity = json.loads(line)
            if (
                identity.get("context") != "system_u:system_r:gateway_t"
                or identity.get("cgroup") != "0::/vm0-exec/exec-native/workload/gateway"
            ):
                raise ValueError("gateway authority or accounting mismatch")
            yield process, identity
        finally:
            if process.poll() is None:
                process.kill()
            process.wait(timeout=5)
            process.stdout.close()


def prepare(resources, cgroup, fixture, label):
    gateway = cgroup / "gateway"
    gateway.mkdir()
    for name, value in (
        ("memory.max", str(256 * 1024**2)),
        ("memory.oom.group", "1"),
        ("pids.max", "64"),
    ):
        (gateway / name).write_text(value)
    key = fixture / "gateway-key"
    key.write_text("synthetic-gateway-only-no-provider-authority")
    key.chmod(0o444)
    label(key, "gateway_key_t")
    label(fixture / "gateway-tls-key.pem", "gateway_key_t")
    log = fixture / "gateway-requests.jsonl"
    log.write_text("")
    os.chown(log, 1000, 1000)
    log.chmod(0o600)
    label(log, "gateway_log_t")
    return gateway


CLIENT = r"""import hashlib,http.client,json,socket,time
observations=[]
for port in (18083,18080):
 for size in (1024,65536,32*1024*1024):
  data=b'x'*size
  peer=http.client.HTTPConnection('127.0.0.1',port,timeout=10)
  start=time.monotonic()
  peer.request('POST','/gateway-bench/body',data)
  response=peer.getresponse(); result=json.loads(response.read()); peer.close()
  assert response.status==200 and result=={'bytes':size,'sha256':hashlib.sha256(data).hexdigest()},result
  observations.append({'port':port,'bodyBytes':size,'seconds':time.monotonic()-start})
 peer=http.client.HTTPConnection('127.0.0.1',port,timeout=10)
 start=time.monotonic(); peer.request('GET','/gateway-bench/stream'); response=peer.getresponse()
 initial=response.read(1); first=time.monotonic(); total=len(initial); digest=hashlib.sha256(initial)
 while chunk:=response.read(4096):
  total+=len(chunk); digest.update(chunk)
  # Explicit slow receiver applies bounded backpressure to both identical peers.
  time.sleep(.0002)
 peer.close()
 expected=(b'data: '+b's'*1016+b'\n\n')*4096
 assert response.status==200 and total==len(expected) and digest.hexdigest()==hashlib.sha256(expected).hexdigest()
 observations.append({'port':port,'sseBytes':total,'firstByteSeconds':first-start,'seconds':time.monotonic()-start})
peer=http.client.HTTPConnection('127.0.0.1',18080,timeout=10)
peer.putrequest('POST','/gateway-bench/body');peer.putheader('content-length',str(32*1024*1024+1));peer.endheaders()
response=peer.getresponse();assert response.status==413;response.read();peer.close()
for count,length in ((4,32*1024*1024),(16,10)):
 held=[]
 try:
  for _ in range(count):
   sock=socket.create_connection(('127.0.0.1',18080),timeout=5)
   sock.sendall(('POST /gateway-bench/body HTTP/1.1\r\nHost: fixture\r\nContent-Length: '+str(length)+'\r\nExpect: 100-continue\r\n\r\n').encode())
   assert b'100 Continue' in sock.recv(4096)
   held.append(sock)
  sock=socket.create_connection(('127.0.0.1',18080),timeout=5)
  try:
   sock.sendall(('POST /gateway-bench/body HTTP/1.1\r\nHost: fixture\r\nContent-Length: '+str(length)+'\r\nExpect: 100-continue\r\n\r\n').encode())
   observed=b''
   while b'\r\n\r\n' not in observed:
    chunk=sock.recv(4096)
    assert chunk,'overload response closed before its headers'
    observed+=chunk
   assert b'503' in observed,observed
   if count==4: assert b'body-budget' in observed,observed
  finally: sock.close()
 finally:
  for sock in held:
   sock.shutdown(socket.SHUT_WR)
   while sock.recv(4096): pass
   sock.close()
for port in (18082,):
 sock=socket.socket()
 try:
  assert sock.connect_ex(('127.0.0.1',port)) in (1,13)
 finally: sock.close()
print(json.dumps({'observations':observations,'overLimitStatus':413,'concurrentLimitStatus':503,'aggregateBodyLimitStatus':503,'directUpstreamDenied':True}))
"""


def probe(resources, cgroup, fixture, env, as_role, record, process, identity):
    cpu_before = int(values(cgroup / "cpu.stat")["usage_usec"])
    result = as_role("agent", ["/usr/bin/python3", "-c", CLIENT], env=env, timeout=30)
    observed = json.loads(result.stdout) if result.returncode == 0 else {}
    record(
        "gateway_bounded_streaming_accounting",
        result.returncode == 0
        and observed.get("directUpstreamDenied") is True
        and int(values(cgroup / "cpu.stat")["usage_usec"]) > cpu_before
        and 32 * 1024**2 <= int((cgroup / "memory.peak").read_text()) <= 256 * 1024**2
        and 18 <= int((cgroup / "pids.peak").read_text()) <= 64,
        identity=identity,
        observed=observed,
        memoryPeakBytes=int((cgroup / "memory.peak").read_text()),
        pidsPeak=int((cgroup / "pids.peak").read_text()),
        cpu=values(cgroup / "cpu.stat"),
        stderr=result.stderr[-2000:],
    )
    before = int(values(cgroup / "memory.events")["oom_kill"])
    (cgroup / "memory.max").write_text("1")
    process.wait(timeout=10)
    unavailable = as_role(
        "agent",
        [
            "/usr/bin/python3",
            "-c",
            "import socket; s=socket.socket(); assert s.connect_ex(('127.0.0.1',18080))==111; s.close()",
        ],
        env=env,
    )
    record(
        "gateway_local_oom_fails_closed",
        process.returncode == -9
        and int(values(cgroup / "memory.events")["oom_kill"]) > before
        and values(cgroup / "cgroup.events")["populated"] == "0"
        and unavailable.returncode == 0
        and Path("/sys/fs/selinux/enforce").read_text().strip() == "1",
        exit=process.returncode,
        events=values(cgroup / "memory.events"),
        policy="abort active gateway IO; no direct fallback; controller-owned restart only",
        stderr=unavailable.stderr[-1000:],
    )
    (cgroup / "memory.max").write_text(str(256 * 1024**2))
    _, restarted = resources.enter_context(running(cgroup, fixture))
    record(
        "gateway_controller_restart", restarted.get("ready") is True, identity=restarted
    )
