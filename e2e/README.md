# E2E HTTP proxy

The hosted-browser tests, Playwright smoke and runner credential provisioning
can use an authenticated HTTP proxy. Add all four repository Actions secrets:

| Secret                    | Value                                                                                          |
| ------------------------- | ---------------------------------------------------------------------------------------------- |
| `E2E_HTTP_PROXY_SERVER`   | Proxy hostname, optionally prefixed with `http://` or `https://`; no port, path or credentials |
| `E2E_HTTP_PROXY_PORT`     | Proxy port                                                                                     |
| `E2E_HTTP_PROXY_USERNAME` | Proxy username                                                                                 |
| `E2E_HTTP_PROXY_PASSWORD` | Proxy password                                                                                 |

Configure them at **Settings → Secrets and variables → Actions**. Keep actual
credentials out of workflow files, pull requests, command arguments and chat.
All four unset preserves the existing direct execution. Partial or invalid
configuration fails before the test command starts.

`scripts/with-http-proxy.mjs <command> [arguments...]` owns a temporary,
loopback-only forwarder that authenticates to the upstream proxy. All HTTP and
HTTPS requests made by curl, Node.js and the CI browsers use that forwarder;
there is no domain filter or automatic direct fallback. HTTPS uses CONNECT
tunnels and existing TLS verification settings. Node.js must be at least
22.21.0 for `NODE_USE_ENV_PROXY` (the CI jobs use 22.23.4).

The child processes only receive the credential-free local proxy URL. The
upstream credentials are removed from their environment and never placed in
Playwright options or reports. The wrapper closes its forwarder when the child
exits and forwards cancellation signals to the child.

This affects the wrapped E2E processes, not deployment jobs, native Runner
traffic or software installation steps. The proxy must be reachable from the
GitHub runner and support CONNECT to the tested HTTPS services. Verify the
actual proxy exit path before treating it as an IAD workaround.
