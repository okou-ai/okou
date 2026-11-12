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

Runner control uses `/runners/<runnerId>/control/...`; future platform sandbox
services reserve `/runners/<runnerId>/sandbox/runs/<runId>/services/<service>/...`.
Paths are unversioned. HTTP and classic WebSocket upgrades share TLS, routing
and the Unix upstream. Application handlers own operation/upgrade validation,
authorization and exact live Run/service assignment. No arbitrary client IP,
port or Unix path is accepted. Arbitrary untrusted web applications additionally
need a separately designed browser origin; path isolation does not supply it.

An official non-local Runner binds its listener and requests its own
`https://<hostname>/runners/<runnerId>/control/health` before publishing the first
Running heartbeat or entering `running`. The ten-second HTTPS request uses normal
CA validation, no redirects, its Runner-ID/generation-bound health credential,
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

Only authenticated `GET /runners/<runnerId>/control/health` is implemented now.
The health-only bearer is the lowercase hex HMAC-SHA256 under the existing
official Runner service credential over these UTF-8 lines, including the final
newline: `okou-runner-ingress-health`, canonical Runner UUID, decimal heartbeat
generation, canonical hostname. Compare in constant time; it
cannot authorize future dispatch or browser/sandbox operations. Do not log it.
The API's general signing/KMS keys are never copied to Runner. Reserved routes
and WebSocket application operations remain rejected until their own handlers
are implemented; native fixture backends establish proxy transport support only.

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
