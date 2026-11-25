# remotes

## remotes-001

- Vitest: "GET /api/remotes/overview > requires an authenticated session with an organization"
- Mode: run
- Given: One caller is unauthenticated; another is signed in but has no active organization.
- When: Each caller requests `GET /api/remotes/overview`.
- Then: Both requests return HTTP 401 with error code `UNAUTHORIZED`.

## remotes-002

- Vitest: "GET /api/remotes/overview > returns defaults for an uninitialized member without requiring memory or preference initialization"
- Mode: run
- Given: A signed-in workspace member who has never initialized memory or preferences and has no remote hosts.
- When: The member requests `GET /api/remotes/overview`.
- Then: The request returns HTTP 200 with `cache-control: no-store` and exactly no Computer Use hosts, `cloudBrowserAvailable` false, `cloudBrowserEnabledByDefault` true, and no SSH or VNC hosts.

## remotes-003

- Vitest: "GET /api/remotes/overview > keeps member browser defaults distinct from thread Computer Use and browser selections"
- Mode: run
- Given: An onboarded member on the limited free plan has a conversation whose Computer Use host is a running Desktop named `Selected Desktop`.
- When: The member reads `GET /api/remotes/overview`, turns off `cloudBrowserEnabledByDefault` in user preferences, switches the conversation to the cloud browser with no Desktop, and reads the overview again.
- Then: The first overview has the cloud browser available and enabled by default and lists the Desktop as `online` with its host and display name. After the changes the cloud browser is still available but no longer enabled by default, and the Desktop list is unchanged.

## remotes-004

- Vitest: "GET /api/remotes/overview > projects only the current member's Desktop hosts across users and organizations"
- Mode: run
- Given: A member runs a Desktop named `Owned Desktop`; a colleague in the same organization and the same user in another organization each run their own Desktop.
- When: The member requests `GET /api/remotes/overview`.
- Then: The Computer Use host list contains exactly the member's `Owned Desktop`, `online`.

## remotes-005

- Vitest: "GET /api/remotes/overview > returns independent SSH and VNC host defaults, not thread overrides or credentials"
- Mode: run
- Given: A member has a conversation, an SSH host `SSH server` and a VNC host `VNC desktop`, both enabled by default for all chats, and has disabled both for the conversation. A colleague in the same organization and the same user in another organization also sign in.
- When: The member, the colleague and the other-organization identity request `GET /api/remotes/overview`; then the member requests it again after the organization's membership list comes back empty.
- Then: The member sees exactly one SSH host and one VNC host, each with `defaultEnabled: true` and no credential data, and the cloud browser enabled by default. The colleague and the other-organization identity see no SSH or VNC hosts. After the membership list is empty, the VNC hosts list is empty while the SSH hosts list is unchanged.
