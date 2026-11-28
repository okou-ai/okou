# computer-use-command-create

## computer-use-command-create-001

- Vitest: "Computer Use command creation > preserves exact session, PAT and bound Agent creation semantics with public read/claim/audit evidence"
- Mode: run
- Given: Three organization members have capable connected hosts, with a web session, an organization-admin CLI token and an assigned Run token bound to the respective hosts.
- When: The session queues an app listing, the CLI and bound Run queue Safari open commands, and each host claims and completes its command. Owners check command or audit readback.
- Then: The session response is exactly a queued command ID, and readback has the selected host, apps.list, empty payload and 11,001 ms timeout. It creates neither audit records nor object-store writes. Each accepted create publishes one commandsChanged notice on the exact host-connection channel. CLI and Run claims show app.open, Safari and 12,002 ms timeout. CLI audit has one event with null Run ID. Agent audit has one event with its Run, host and command IDs and app.open kind.

## computer-use-command-create-002

- Vitest: "Computer Use command creation > keeps authentication, bound-host and 404/409 eligibility precedence unchanged"
- Mode: run
- Given: An organization member attempts Computer Use with no host, then with one host that only lists apps, then with two online hosts. A Run without a host binding is available.
- When: Callers attempt anonymous creation and unbound Run creation, then the session requests read or write commands at each host configuration, including after 91 seconds.
- Then: Anonymous returns HTTP 401 and the unbound Run returns HTTP 403. No host returns HTTP 404 with `No linked computer-use host found`. A host without the write capability returns HTTP 409 with `No online computer-use host supports this command`. Two online read-capable hosts return HTTP 409 with `Multiple active computer-use hosts are online`. Once offline the read returns HTTP 409 with `No online computer-use host found`.
