# connector-permissions.expiration

## connector-permissions.expiration-001

- Vitest: "Connector permission expiration > preserves a patch deadline unless the caller explicitly changes the duration or replaces the grant"
- Mode: run
- Given: An authenticated owner has completed Slack OAuth and holds no prior expiry for the chat:write permission.
- When: The owner sends PUT /api/connector-permissions with a one-hour allow patch, revisits it after ten minutes without a duration, then sends patches with 24h, always and 1h respectively, followed by a replace with no duration.
- Then: Each request returns HTTP 200. The first deadline is one hour from the initial grant. The durationless patch keeps that deadline. The 24h patch computes its deadline from the later request, always produces null, and the durationless replace clears the renewed one-hour deadline.

## connector-permissions.expiration-002

- Vitest: "Connector permission expiration > clears expiry on deny and does not preserve an already expired allow deadline"
- Mode: run
- Given: An authenticated owner has a connected Slack account and a one-hour chat:write allow grant.
- When: The owner patches chat:write to deny, restores a one-hour allow and at its expiry patches allow without a duration through PUT /api/connector-permissions.
- Then: The deny response returns HTTP 200 with action deny and a null expiry. The durationless allow at expiry returns HTTP 200 with action allow and a null expiry.
