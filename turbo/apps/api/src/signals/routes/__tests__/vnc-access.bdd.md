# vnc-access

## vnc-access-001

- Vitest: "live chat VNC Run inventory > advertises the exact client-certificate profile without revealing private material"
- Mode: run
- Given: A Pro member has a running chat Run with an Agent token. The member creates a VNC host "Client certificate QEMU" with `x509_none` security and a `client_certificate` credential (certificate chain and private key), and enables its chat host default via `PUT /api/remote-access/hosts/vnc/:connectionId/default`.
- When: The Agent calls `GET /api/vnc/hosts` with its Agent token.
- Then: The response is HTTP 200 and lists the host with `authMethod: "client_certificate"`, `securityType: "x509_none"` and availability `ready`. The body contains neither the private key nor the text `certificateChain`. Identities contain the host ID and generation with a microsecond `createdAt`. No additional KMS decryptions occur.

## vnc-access-002

- Vitest: "live chat VNC Run inventory > lists the owner-selected QEMU SCRAM pair without exposing its password"
- Mode: run
- Given: A Pro member has a running chat Run with an Agent token and creates a VNC host "QEMU SCRAM desktop" with `qemu_x509_sasl` security and a `qemu_scram_sha256` credential (user `operator`, a password).
- When: The Agent calls `GET /api/vnc/hosts` before and after the member enables the host's VNC chat default.
- Then: Before enabling, the inventory is `{ hosts: [], identities: [] }`. After enabling, it contains the host exactly with host `qemu.example.com`, port 5900, `authMethod: "qemu_scram_sha256"`, `securityType: "qemu_x509_sasl"` and availability `ready`. The body never contains the password and no KMS decryption occurs.

## vnc-access-003

- Vitest: "live chat VNC Run inventory > filters live chat inventory by VNC access and the exact SSH dependency"
- Mode: run
- Given: A Pro member has a running chat Run with an Agent token and a VNC host whose chat default is initially off.
- When: The Agent lists `GET /api/vnc/hosts` after each step: the member enables the VNC default; creates an SSH connection via `POST /api/ssh/connections` and switches the VNC host to an SSH transport through it via `PATCH /api/vnc/connections/:connectionId`; enables the SSH host default; and disables SSH for the thread via `PUT /api/chat-threads/:threadId/remote-access/ssh/:connectionId`.
- Then: The listed host IDs are, in order: none; the VNC host; none (SSH dependency not enabled); the VNC host; none (SSH disabled for the thread).

## vnc-access-004

- Vitest: "live chat VNC Run inventory > keeps first-host and recreated-host chat access default off"
- Mode: run
- Given: A Pro member has a running chat Run with an Agent token and no VNC hosts.
- When: The member creates a first VNC host via `POST /api/vnc/connections`, the Agent lists `GET /api/vnc/hosts`, the member deletes the host and creates a replacement host, and the Agent lists again.
- Then: The deletion returns HTTP 204, and both inventory reads return `{ hosts: [], identities: [] }`.

## vnc-access-005

- Vitest: "live chat VNC Run inventory > commits concurrent first hosts without implicit chat access"
- Mode: run
- Given: A Pro member has a running chat Run with an Agent token and no VNC hosts.
- When: The member concurrently creates two VNC hosts via `POST /api/vnc/connections`, lists `GET /api/vnc/connections`, and the Agent lists `GET /api/vnc/hosts`.
- Then: The member's list contains two connections, and the Agent inventory is `{ hosts: [], identities: [] }`.

## vnc-access-006

- Vitest: "live chat VNC Run inventory > lists a chat-enabled host for an Agent without decrypting credentials"
- Mode: run
- Given: A Pro member has a running chat Run with an Agent token and a VNC host "VNC desktop" (`vnc.example.com`, VNC password, `x509_vnc`) whose chat default is enabled.
- When: The Agent lists `GET /api/vnc/hosts`, lists again, the member creates a second VNC host without enabling it, and the Agent lists once more.
- Then: The inventory is exactly that host with port 5900, `authMethod: "vnc_password"`, `securityType: "x509_vnc"`, availability `ready`, and an identity with generation 1 and a microsecond `createdAt`. The repeated listing performs no KMS decryption, and the listing after the second host is created is unchanged.

## vnc-access-007

- Vitest: "live chat VNC Run inventory > returns an authorized empty inventory for current and later Agents"
- Mode: run
- Given: A Pro member with no VNC hosts has a running chat Run, and later starts a second Run.
- When: Each Run's Agent calls `GET /api/vnc/hosts` with its own Agent token.
- Then: Both responses are HTTP 200 with `{ hosts: [], identities: [] }`.

## vnc-access-008

- Vitest: "live chat VNC Run inventory > requires both VNC and SSH chat host permissions for SSH-backed inventory rows"
- Mode: run
- Given: A Pro member has a running chat Run, an SSH connection, a direct VNC host and a VNC host tunneled through that SSH connection, with VNC chat defaults enabled for both VNC hosts.
- When: The Agent lists `GET /api/vnc/hosts` before enabling the SSH default, after enabling it, and after disabling it again.
- Then: The listed IDs are only the direct host, then the direct and tunneled hosts, then only the direct host. No inventory body contains the SSH connection ID.

## vnc-access-009

- Vitest: "live chat VNC Run inventory > lists the authorized Mac classic password profile without exposing its secret"
- Mode: run
- Given: A Pro member has a running chat Run, an SSH connection "Mac SSH", and a VNC host "Classic desktop" at `127.0.0.1` with `apple_vnc_password` security and a VNC password `testpass`, tunneled through that SSH connection. Both the VNC and SSH chat defaults are enabled.
- When: The Agent lists `GET /api/vnc/hosts`, then the member disables the SSH default and the Agent lists again.
- Then: The first inventory is exactly the classic host with port 5900, `authMethod: "vnc_password"`, `securityType: "apple_vnc_password"`, availability `ready`, and its identity. The body does not contain `testpass` and no KMS decryption occurs. After disabling SSH, the inventory is empty.

## vnc-access-010

- Vitest: "live chat VNC Run inventory > returns both exact supported pairs without decrypting credentials"
- Mode: run
- Given: A Pro member has a running chat Run. The member creates "Plain desktop" with a `username_password` credential and `x509_plain` security, and later a standard VNC-password `x509_vnc` host, enabling the VNC chat default for each.
- When: The Agent lists `GET /api/vnc/hosts` after the first host is enabled and again after the second.
- Then: The create response reports security type `x509_plain`. The first inventory is exactly the plain host (`username_password`, `x509_plain`, port 5900, ready). The second inventory is exactly both hosts in creation order with their identities. No KMS decryption occurs.

## vnc-access-011

- Vitest: "live chat VNC Run inventory > isolates a shared Agent's inventory by the Run owner"
- Mode: run
- Given: A creator has a running Run with a chat-enabled VNC host. A second member of the same workspace completes onboarding, selects a personal model and starts their own Run.
- When: The second member's Agent lists `GET /api/vnc/hosts`; the second member then creates and enables their own VNC host and the Agent lists again; the creator's Agent and the second member's Agent each list once more.
- Then: The second member's first inventory is empty, then contains only their own host. The creator's Agent lists only the creator's host, and the second member's Agent still lists only their own host.

## vnc-access-012

- Vitest: "live chat VNC Run inventory > does not accept another organization or Run owner from a valid token"
- Mode: run
- Given: A Pro member has a running chat Run with a chat-enabled VNC host. Validly signed sandbox tokens with `vnc:read` are issued for the same user in a different organization, a different user in the same organization, and the owner with a random Run ID.
- When: Each token calls `GET /api/vnc/hosts`.
- Then: All three requests return HTTP 404.

## vnc-access-013

- Vitest: "live chat VNC Run inventory > rechecks membership for already issued tokens"
- Mode: run
- Given: A Pro member has a running chat Run with an issued Agent token and a chat-enabled VNC host. The identity provider then reports that the member has no organization memberships.
- When: The Agent calls `GET /api/vnc/hosts` with the already issued token.
- Then: The response is HTTP 404 with error code `VNC_UNAVAILABLE`.

## vnc-access-014

- Vitest: "live chat VNC Run inventory > rejects inventory for a completed Run despite an enabled host default"
- Mode: run
- Given: A member has a VNC host with its chat default enabled and starts a Run that a Runner receives. Parameter row `completed`: the Runner reports a system event and completes the Run with exit code 0, so the Run reads back as `completed`.
- When: A signed `vnc:read` token for that Run calls `GET /api/vnc/hosts`.
- Then: The response is HTTP 404 with error code `VNC_UNAVAILABLE`.

## vnc-access-015

- Vitest: "live chat VNC Run inventory > rejects inventory for a cancelled Run despite an enabled host default"
- Mode: run
- Given: A member has a VNC host with its chat default enabled and starts a Run that a Runner receives. Parameter row `cancelled`: the owner cancels the Run and the Runner then reports completion with exit code 1, so the Run reads back as `cancelled`.
- When: A signed `vnc:read` token for that Run calls `GET /api/vnc/hosts`.
- Then: The response is HTTP 404 with error code `VNC_UNAVAILABLE`.

## vnc-access-016

- Vitest: "live chat VNC Run inventory > rejects inventory for a failed Run despite an enabled host default"
- Mode: run
- Given: A member has a VNC host with its chat default enabled and starts a Run that a Runner receives. Parameter row `failed`: the Runner reports completion with exit code 1 and an error, so the Run reads back as `failed`.
- When: A signed `vnc:read` token for that Run calls `GET /api/vnc/hosts`.
- Then: The response is HTTP 404 with error code `VNC_UNAVAILABLE`.

## vnc-access-017

- Vitest: "live chat VNC Run inventory > keeps VNC inventory Agent-token and capability-specific"
- Mode: run
- Given: A Pro member has a running chat Run with a chat-enabled VNC host.
- When: `GET /api/vnc/hosts` is called with the member's browser session, with the Run's sandbox token, with signed Run tokens carrying no capabilities, `ssh:read`+`ssh:write`, `computer-use:write` or `vnc:write`, with a valid `vnc:read` token, and with an expired `vnc:read` token.
- Then: The browser session, sandbox token and every wrong-capability token return HTTP 403. The valid `vnc:read` token returns HTTP 200, and the expired token returns HTTP 401.
