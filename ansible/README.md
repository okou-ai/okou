# Runner host provisioning

## Shared Runner ingress

Normal host provisioning installs the independent `okou-runner-caddy.service`;
use `--tags runner_caddy` to reapply only this component. Its exact public
inventory hostname must match the Runner's configured hostname, and DNS-only
A/AAAA records must point to that host. Authorize TCP 443 separately. Caddy uses
TLS-ALPN-01 for public-CA issuance/renewal; no port-80 listener or Cloudflare
Origin CA certificate is configured. Public DNS, firewall and certificate
renewal acceptance are operator checks, not a systemd-ready assertion.

The dedicated `okou-runner-caddy` account/group owns private persistent
certificate state in `/var/lib/okou-runner-caddy`; keep it across provisioning.
Configuration is in `/etc/okou-runner-caddy`, and checksum-pinned binaries are
versioned under `/usr/local/lib/okou-runner-caddy`. Changed/repaired deployments
are activated with a readiness-bound apply fingerprint. Healthy unchanged
provisioning preserves the running Caddy process; an ingress restart interrupts
existing streams and clients must reconnect.

Static `/runners/<runnerId>/...` routes select only the matching Unix socket at
`/var/lib/vm0-runner/ingress/<runnerId>.sock`, preserving the whole URI. Multiple
serving/draining Runner IDs coexist without per-Run Caddy configuration edits.
Runner creates and validates its namespace/socket; provisioning rejects unsafe
existing ancestors, owners, modes, ACLs or symlinks instead of changing private
live state. Missing sockets return 502 until their Runner starts.

Runner control uses `/runners/<runnerId>/control/...`; future sandbox access
reserves only `/runners/<runnerId>/sandbox/runs/<runId>/`. Paths below that
prefix, destination resolution and sandbox authorization remain future design.
Paths are unversioned. HTTP and classic WebSocket upgrades share TLS, routing
and the Unix upstream. No sandbox handler is implemented in this slice.

An official non-local Runner binds its listener and requests its own
`https://<hostname>/runners/<runnerId>/control/health` before publishing the first
Running heartbeat or entering `running`. The ten-second HTTPS request uses normal
CA validation, no redirects, the existing official Runner service credential,
and a `200 OK` response containing only the plain text `ok`. Missing hostname,
listener failure or unreachable ingress fails startup and rolls back its
resources. Provision public Caddy, DNS, firewall and certificates before starting
this Runner artifact.

This check runs only at startup. Running Runners and accepted Runs continue
through Caddy restart; there is no hard systemd lifetime dependency or ongoing
health watchdog. Caddy recovery restores connections to the same live sockets;
existing WebSocket clients reconnect. Local queue and personal-token Runners
retain their existing behavior.
The ordered official heartbeat reports only `ingressServiceActive`, sampled
with a bounded best-effort host probe. Missing, inactive or unqueryable service
state reports false. Older or nonofficial heartbeats clear it to false, and
freshness uses the existing heartbeat timestamp. Service activity does not prove
public reachability, a working listener or support for direct dispatch.

Deploy the additive schema/API heartbeat reader before Runner writers. This PR
does not activate a direct sender or change current Claim/Ably/poll execution.
Later PRs replace job acquisition with API-owned full direct delivery, failing
the Run when no Runner is available. Service loss never revokes existing Run
ownership or accepted-work cleanup.

Runner control uses the existing official Runner service credential in
`Authorization: Bearer <token>`, compared in constant time. Health and future
Run dispatch share this service identity; there are no per-interface credentials
or health-specific HMACs. API owns user permission checks and Run assignment;
Runner owns local admission and execution deduplication. Browser/Guest sandbox
access needs its own authorization design and never receives this service
credential. The API's general signing/KMS keys remain API-owned.

Only authenticated `GET /runners/<runnerId>/control/health` is implemented now.
Reserved routes and WebSocket application operations remain rejected until
their own handlers are implemented; native fixture backends establish proxy
transport support only.

`playbooks/provision-runner.yml` is the shared host-dependency entry point used
by Runner build/release/preview provisioning. Its cache covers the complete
`ansible/` tree.

Native Caddy installation, routing and systemd activation fixtures live in
`tests/`. Run them through `.github/scripts/tests/provision-runner-caddy-test.sh`
from the repository root; the CI adapter resolves and verifies the pinned Caddy
binary before invoking these fixtures. The complete suite requires Linux,
Ansible, passwordless sudo and a running systemd instance.

```bash
ansible-playbook -i 'runner.example.org,' playbooks/provision-runner.yml \
  -e 'ansible_user=ubuntu'
```

## Ingress monitoring

`provision-monitoring.yml` installs one Python implementation,
`vm0-monitoring-runner-collect`, with two independently scheduled roles:

- `status`: the existing lifecycle service/timer collects local state every
  15 seconds and writes `runner-status.prom`.
- `ingress --hostname=<inventory hostname>`: a separate oneshot service/timer
  writes `runner-ingress.prom`. Its timer uses `OnBootSec=15s` for the first
  activation and `OnUnitInactiveSec=60s` thereafter, including after failure.
  Enabling it after the boot deadline starts the first round immediately.

systemd prevents another activation of the ingress unit while it is running;
its processes have a separate 35-second start timeout and kill group. Local
status collection does not wait for HTTP. Direct script invocation performs one
diagnostic round; production cadence belongs to the timer, without a Python
cooldown file or background scheduler.

The ingress role reads the existing private managed `runner.yaml`, `runner_id`,
`heartbeat_generation` and lifecycle status in each version directory. It does
not require Runner executable or status format changes. Running and draining
official targets are checked separately; prepared, stopped and nonofficial
instances are excluded. Hostname must match inventory before sending a credential.
Manual credential overrides or config drift can make configured health fail;
the collector does not read live-process credentials. The status role retains
its broader lifecycle input contract without requiring private health config.

Each target receives one request per collection, with a ten-second timeout and
no retries or redirects. Up to four requests run concurrently within a
30-second collection budget. A failed health publication does not immediately
restart its service or block lifecycle output. The existing 15-second Alloy
scrape only reads the results and never triggers network probes.

The collector atomically replaces `runner-ingress.prom` with two host gauges:

- `vm0_runner_ingress_success_count`: unique Runner targets whose authenticated
  HTTPS health succeeded in the latest round, requiring ordinary TLS validation,
  HTTP 200, the exact `ok` body and unchanged process identity.
- `vm0_runner_ingress_failure_count`: unique Runner targets for which that round
  did not establish healthy ingress, including failed requests and known-target
  input errors. Conflicting duplicate identities count once as failed.

These are current counts, not cumulative counters; they can decrease each round.
They use only the existing Alloy `env` and `instance` labels, so Runner replacement
does not create additional series. UUIDs and generations stay internal to route,
deduplicate and validate probes. Successful discovery with no eligible targets
publishes `0/0`; whole-discovery failure publishes no count samples. Neither means
healthy ingress. The counts do not identify an individual failing Runner.

The observation checks HTTPS/Caddy/Runner routing from the host, not dispatch
admission or API-origin network policy. Credentials stay in private input files
and a curl stdin pipe, never in metrics, command arguments, diagnostics or Alloy
configuration.

Always gate the display on the ingress file's own freshness. Repeated Alloy
scrapes can keep old count samples current after the collector stops. This query
applies the guard to both counts:

```promql
{__name__=~"vm0_runner_ingress_(success|failure)_count"}
and on (env, instance)
  (time() - node_textfile_mtime_seconds{file=~".*runner-ingress[.]prom"} < 180)
and on (env, instance)
  (node_textfile_mtime_seconds{file=~".*runner-ingress[.]prom"} <= time())
```

Missing/stale data, `0/0`, or a zero failure count alone must not display as healthy.
Normal host provisioning applies
collector changes through the existing Ansible-tree hash; merged source alone
does not prove the host was provisioned or Grafana received the new series.
Run the real-files/curl/TLS fixtures with
`.github/scripts/tests/vm0-monitoring-runner-ingress-collect-test.sh`.
The Linux fixture requires Python/PyYAML, curl, OpenSSL and `systemd-analyze`.
It exercises both modes, strict health/count behavior, isolation during blocked
HTTP and failure, and verifies the rendered service/timer pairs.
