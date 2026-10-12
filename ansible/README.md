# Runner host provisioning

`playbooks/provision-runner.yml` is the shared host-dependency entry point used
by Runner build/release/preview provisioning. Its cache covers the complete
`ansible/` tree, including imported tasks and templates.

## Optional Runner Caddy ingress

`okou-runner-caddy` names the service, dedicated user and its primary group.
Configuration lives in `/etc/okou-runner-caddy`, private certificate/account
state in `/var/lib/okou-runner-caddy`, versioned binaries in
`/usr/local/lib/okou-runner-caddy/<version>`, and verified downloads in
`/var/cache/okou-runner-caddy`. These names belong to the Caddy component;
the current WSS backend keeps its protocol-specific `/var/lib/vm0-runner/wss`
namespace. Future HTTPS routes can extend the same Caddy configuration while
their backend owns its own paths and authorization.

Host provisioning preserves the existing access group's numeric GID. Runner owns
creation and validation of its namespace; provisioning leaves existing namespace,
socket and lock ownership unchanged.

Set `runner_caddy_enabled: true` in a host's Ansible configuration to manage
the dedicated `okou-runner-caddy.service`. Ordinary provisioning omits these tasks
unless explicitly opted in; omission does not stop an already deployed service.
Keep the host setting in `playbooks/host_vars/<inventory_hostname>.yml` for
consistent cached CI provisioning. A one-off `-e` override is not persisted.

First provision the normal Runner dependencies and start a Runner. Runner creates
`/var/lib/vm0-runner/wss` as `root:okou-runner-caddy 0710`; ingress provisioning
validates that existing namespace and its trusted ancestors without repairing or
creating them. Missing state, symlinks, wrong metadata or ACLs stop ingress setup.
Private Runner directories and owner/lock files remain inaccessible to Caddy.

For a separately authorized ingress deployment, use the same entry point:

```bash
ansible-playbook -i 'runner.example.org,' playbooks/provision-runner.yml \
  -e 'ansible_user=ubuntu' -e 'runner_caddy_enabled=true' \
  --tags runner_caddy
```

The exact public inventory hostname must match the hostname written into Runner
configuration. Its DNS-only A/AAAA records must point to this host; do not proxy
through Cloudflare or use a Cloudflare Origin CA certificate. Authorize public
TCP 443 separately. Caddy uses TLS-ALPN-01 for automatic browser-trusted
certificate issuance and renewal without an HTTP listener on port 80. HTTP/3
also needs UDP 443; DNS, firewall and public activation are not playbook tasks.

The checksum-pinned Caddy binary has its own system user and service, independent
of Runner releases. Provisioning compares cached extraction with the verified
archive and atomically installs the binary, repairing interrupted installations.
Its certificate/account state stays private and persistent
under `/var/lib/okou-runner-caddy`; retain it across reprovisioning. Only canonical
lowercase UUID `/ws/<runner_id>` paths are forwarded to matching Unix sockets.
The Runner's first-frame ticket admission still authorizes the Run.

Reprovisioning restarts Caddy for changed configuration, unit/binary or service
account settings, waits for its systemd readiness notification and verifies that
the service remains active before recording completion. This applies
repaired group membership to the running process; unchanged settings leave it
running. A root-only applied-state record binds the published files and account
to the ready service invocation. If provisioning stops before activation completes,
the next run reloads the unit and restarts Caddy even when those files already
match. The record is updated only after readiness; a new service invocation is
also verified by restarting once on reprovisioning. Runner promotion/drain does
not restart Caddy. An ingress
restart interrupts WebSocket streams; clients reconnect with fresh tickets.
There is no admin API, per-Runner Caddy mutation, ticket-revocation switch or
alternate upstream.

Before activation, verify each serving/draining hostname independently: DNS,
browser trust, certificate renewal, exact socket route and real WSS admission.
Rollback must preserve live/draining hostnames and certificate state. Stopping
ingress interrupts transport and eventually denies new tickets through the
existing heartbeat observation; it does not revoke issued tickets.

Loopback TLS/Unix-socket tests establish proxy routing and access behavior.
Native systemd tests cover interrupted publication, failed startup and unchanged
reprovisioning. Public ACME renewal, HTTP/2/3 extended CONNECT and the complete
browser/Runner/Guest path still need environment verification in #37030.
No dedicated filesystem-persistence reboot fixture is required.
