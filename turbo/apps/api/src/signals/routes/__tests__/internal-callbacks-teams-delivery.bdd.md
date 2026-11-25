# internal-callbacks-teams-delivery

## internal-callbacks-teams-delivery-001

- Vitest: "Teams completion delivery > does not retry a failed Teams delivery when completion is replayed"
- Mode: run
- Given: A connected, onboarded Teams user with paid native execution sends a message and the run is available to an authenticated Runner. The Teams token service returns HTTP 503 and a bot activity delivery can fail with HTTP 500.
- When: The Runner submits successful completion to `POST /api/webhooks/run/complete` with its sandbox bearer token and repeats the identical completion after delivery settles.
- Then: Both completions return HTTP 200. The user's run reads as `completed`. Teams receives one delivery attempt after the first callback and none after the replay.
