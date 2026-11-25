# connector-runtime-wakeups

## connector-runtime-wakeups-001

- Vitest: "connector runtime wakeups > notifies eligible Runner groups after connector deletion even if one batch fails"
- Mode: run
- Given: An authenticated Team owner has a custom connector and five eligible runs on different Runner groups, plus a cancelled run. Another workspace also has an active run. The first Ably batch will fail.
- When: The owner sends DELETE /api/custom-connectors/:id.
- Then: The response is HTTP 204 and the connector is absent from the list. The API attempts exactly one connector-runtime-sync batch per eligible group and run, with at most four concurrent publications. It continues after the rejected batch and omits the cancelled and other-workspace runs.

## connector-runtime-wakeups-002

- Vitest: "connector runtime wakeups > uses the native Ably HTTP batch contract: accepted"
- Mode: run
- Given: An authenticated owner has a custom connector and a running run. Ably returns a successful per-channel result.
- When: The owner sends DELETE /api/custom-connectors/:id.
- Then: Ably receives exactly one application/x-msgpack HTTP POST /messages containing the Runner group's channel and a connector-runtime-sync payload naming the run and custom connector. The connector deletion still returns HTTP 204 and the connector is absent from the owner's list.

## connector-runtime-wakeups-003

- Vitest: "connector runtime wakeups > uses the native Ably HTTP batch contract: channel-rejected"
- Mode: run
- Given: An authenticated owner has a custom connector and a running run. Ably returns a per-channel 429 rejection.
- When: The owner sends DELETE /api/custom-connectors/:id.
- Then: Ably receives exactly one application/x-msgpack HTTP POST /messages containing the Runner group's channel and a connector-runtime-sync payload naming the run and custom connector. The connector deletion still returns HTTP 204 and the connector is absent from the owner's list.

## connector-runtime-wakeups-004

- Vitest: "connector runtime wakeups > uses the native Ably HTTP batch contract: http-rejected"
- Mode: run
- Given: An authenticated owner has a custom connector and a running run. Ably returns HTTP 429.
- When: The owner sends DELETE /api/custom-connectors/:id.
- Then: Ably receives exactly one application/x-msgpack HTTP POST /messages containing the Runner group's channel and a connector-runtime-sync payload naming the run and custom connector. The connector deletion still returns HTTP 204 and the connector is absent from the owner's list.

## connector-runtime-wakeups-005

- Vitest: "connector runtime wakeups > uses the native Ably HTTP batch contract: missing-result"
- Mode: run
- Given: An authenticated owner has a custom connector and a running run. Ably returns a batch response with no per-channel result.
- When: The owner sends DELETE /api/custom-connectors/:id.
- Then: Ably receives exactly one application/x-msgpack HTTP POST /messages containing the Runner group's channel and a connector-runtime-sync payload naming the run and custom connector. The connector deletion still returns HTTP 204 and the connector is absent from the owner's list.
