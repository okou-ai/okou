# runner-ingress-heartbeat

## runner-ingress-heartbeat-001

- Vitest: "Runner ingress service heartbeat contract > accepts old, unavailable, recovered and omitted service observations without blocking heartbeats"
- Mode: run
- Given: An officially authenticated Runner reports a whole-state heartbeat with a fixed Runner identity.
- When: The Runner sends a legacy heartbeat with no ingress-service field, then reports unavailable, active, unavailable, omitted and an older active observation.
- Then: Every heartbeat returns HTTP 200, and the legacy response is exactly `{ "ok": true }`.

## runner-ingress-heartbeat-002

- Vitest: "Runner ingress service heartbeat contract > does not let execution service activity bypass heartbeat authentication"
- Mode: run
- Given: A heartbeat caller has no authorization header and advertises an active ingress service.
- When: The caller posts the heartbeat.
- Then: The API returns HTTP 401.
