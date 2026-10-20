# Runner host provisioning

`playbooks/provision-runner.yml` is the shared host-dependency entry point used
by Runner build/release/preview provisioning. Its cache covers the complete
`ansible/` tree, including imported tasks.

```bash
ansible-playbook -i 'runner.example.org,' playbooks/provision-runner.yml \
  -e 'ansible_user=ubuntu'
```

## Installed ingress cleanup

Normal provisioning stops and disables the retired, dedicated
`okou-runner-caddy.service` when installed, removes its systemd unit, managed
Caddyfile and activation record, removes its dedicated installed binaries, and
reloads systemd. Cleanup can also be selected with `--tags runner_host_cleanup`.
Failures to stop or disable the service abort cleanup rather than removing a
running service's assets.

This service only hosted the retired Runner WebSocket route. Cleanup does not
manage generic `caddy.service`, SSH, VNC, other hosting services, firewall rules,
or DNS. It preserves `/var/cache/okou-runner-caddy`, private certificate/account
state under `/var/lib/okou-runner-caddy`, all Runner data and socket namespaces,
and the existing user/group identities that own retained files. It does not
create these accounts on fresh hosts.

Removing provisioning code alone cannot retire installed units. Keep the cleanup
until every affected host has applied it and supported provisioning/rollback
artifacts cannot reinstall the service. Running cleanup interrupts existing
WebSocket connections; deployment owners must coordinate consumer retirement,
old Runner exit and rollback exclusions before applying it. A source change or
successful Runner release is not evidence that host cleanup has run.
