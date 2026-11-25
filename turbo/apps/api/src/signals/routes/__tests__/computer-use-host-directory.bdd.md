# computer-use-host-directory

## computer-use-host-directory-001

- Vitest: "standalone Computer Use host directory > preserves session, PAT and Agent auth controls at the route boundary"
- Mode: run
- Given: A signed-in workspace member has a registered Desktop host, a personal access token, and a chat Run launched without a selected Desktop whose Agent token therefore has no host binding.
- When: `GET /api/computer-use/hosts` is called without credentials, by a user without an organization, by the member's session, with the personal access token and with the unbound Agent token.
- Then: The unauthenticated and organization-less requests return HTTP 401 with an API error. The session lists exactly the member's host and the personal access token returns the identical directory. The unbound Agent token returns HTTP 403 with an API error.

## computer-use-host-directory-002

- Vitest: "standalone Computer Use host directory > returns the complete ordered online, stale and stopped-installation directory without foreign hosts"
- Mode: run
- Given: A signed-in member has a Desktop host last seen at start ("Stale Desktop"), a host registered one second later and then stopped, and a "Current Desktop" registered two seconds in and heartbeating at +120 s. A same-workspace peer and a member of another workspace each have their own host.
- When: At +120 s the member calls `GET /api/computer-use/hosts`.
- Then: The directory lists exactly the current, stopped and stale hosts in that order with statuses `online`, `offline`, `offline`. The current host entry is exactly its ID, host and display name, app version `0.52.1`, OS `macOS 15`, capabilities `apps.list` and `element.click`, accessibility true, screen recording false, unknown Chrome and Safari automation status, `online`, last seen at +120 s and created at +2 s. Peer and foreign hosts are absent, and the read publishes no realtime messages.

## computer-use-host-directory-003

- Vitest: "standalone Computer Use host directory > keeps actual claimed Agent discovery bound to its selected host after that host stops"
- Mode: run
- Given: A signed-in member has two Desktop hosts and a chat Run launched with the second ("Bound Offline Desktop") selected; that host then stops.
- When: The Run's Agent calls `GET /api/computer-use/hosts` with its token.
- Then: The directory contains only the bound host, named "Bound Offline Desktop" with status `offline`, and does not mention the other host.
