# computer-use-host-start

## computer-use-host-start-001

- Vitest: "Computer Use host START > preserves START auth and normalization without importing the command capability gate"
- Mode: run
- Given: A signed-in organization member can register a desktop. The same actor also has an organization-admin PAT and a Run token.
- When: Callers try to start a host anonymously, without an organization, with the organization session, with the PAT and with the Run token. The session request contains padded name and version fields, duplicate and padded capabilities, and explicit accessibility and screen recording permissions.
- Then: Anonymous and organization-less requests return HTTP 401. The session returns HTTP 200 and the host list reports trimmed name and versions, deduplicated trimmed capabilities and unchanged permissions. The PAT and Run token get HTTP 403 and the Run token receives `This endpoint is not available for sandbox tokens`.

## computer-use-host-start-002

- Vitest: "Computer Use host START > retains installation identity, connection generation advancement, partial-index ownership, revoked-row and concurrent upsert semantics"
- Mode: run
- Given: A signed-in member has started a host for an installation ID. A peer in the same organization and a user in a different organization can also start hosts.
- When: The owner restarts the installation with updated metadata, then checks both connections, stops and restarts again. The other users use the same installation ID, and the owner performs two concurrent starts for a fresh installation.
- Then: Restart preserves the host ID and creation time, updates name, versions, capabilities and permissions, and publishes one owner notification. The old connection gets HTTP 409 on heartbeat and the new one gets HTTP 200. The peer and foreign user receive distinct host IDs. Restart after stop retains the original identity and creation time. Concurrent starts share a host ID and yield one HTTP 200 and one HTTP 409 on heartbeat.
