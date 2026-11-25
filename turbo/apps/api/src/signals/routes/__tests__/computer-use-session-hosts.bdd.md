# computer-use-session-hosts

## computer-use-session-hosts-001

- Vitest: "Native Computer Use session authentication > enforces the supported Native version at registration"
- Mode: run
- Given: A signed-in workspace admin runs the Desktop app, and the minimum supported Desktop version is `0.54.0`.
- When: The Desktop calls `POST /api/computer-use/hosts/register` with app version `0.53.4`, then with `0.54.0`.
- Then: The old version is rejected with HTTP 426, error code `DESKTOP_UPDATE_REQUIRED` and `minimumSupportedVersion: "0.54.0"`; version `0.54.0` registers with HTTP 200.

## computer-use-session-hosts-002

- Vitest: "Native Computer Use session authentication > closes admission for existing old hosts but lets their claimed command finish and stop"
- Mode: run
- Given: A signed-in workspace admin's Desktop on version `0.53.4` is registered and has claimed an `apps.list` command; then the minimum supported version is raised to `0.54.0`.
- When: The old host polls `POST /api/computer-use/hosts/:hostId/commands/next` (with an `X-Client-Version: 99.0.0` header); the member lists hosts and creates a new command; the host heartbeats, completes its claimed command and stops.
- Then: The poll returns HTTP 426, the host is listed `offline`, and creating a new command returns HTTP 409. The heartbeat and completion still return HTTP 200, the command reads `succeeded` with `{ apps: [] }`, and the stop returns HTTP 200.

## computer-use-session-hosts-003

- Vitest: "Native Computer Use session authentication > preserves the GUI claim lifecycle for a supported Desktop"
- Mode: run
- Given: A signed-in workspace admin runs a supported Desktop (`X-Client-Type: Desktop`, version `0.54.0`, which is the minimum supported version).
- When: The Desktop registers, heartbeats, claims a member-created `apps.list` command, completes it, stops, and heartbeats again; the member reads the command and lists hosts.
- Then: Registration returns exactly a host ID, connection generation 1 and `commandNotifications` for channel `computer-use-host:<userId>:<orgId>:<hostId>:1` with event `commandsChanged`. The claim returns the command, which then reads `succeeded` with `{ apps: [] }`. After the stop, the heartbeat returns HTTP 409 and the host is listed `offline`.

## computer-use-session-hosts-004

- Vitest: "Native Computer Use session authentication > refreshes liveness for succeeded completion at 29999 ms and preserves the result through retries"
- Mode: run
- Given: A signed-in workspace admin's Desktop registered at a fixed time and claimed an `apps.list` command with a 60 s timeout (row: succeeded at 29999 ms).
- When: At +29,999 ms the Desktop completes the command as succeeded via `POST /api/computer-use/hosts/:hostId/commands/:commandId/complete`; then at +30,000 ms, +59,999 ms and +60,000 ms it retries the completion with the opposite outcome (failure), with the member listing hosts and reading the command after each step.
- Then: The first completion returns HTTP 200; the host is `online` with last-seen at the registration time, and the command reads `succeeded` with completion time +29,999 ms and result `{ apps: [] }`. Each retry returns exactly `{ ok: true }` and leaves the command read unchanged; last-seen is +30,000 ms for the retries at +30,000 and +59,999 ms and +60,000 ms for the last retry.

## computer-use-session-hosts-005

- Vitest: "Native Computer Use session authentication > refreshes liveness for succeeded completion at 30000 ms and preserves the result through retries"
- Mode: run
- Given: A signed-in workspace admin's Desktop registered at a fixed time and claimed an `apps.list` command with a 60 s timeout (row: succeeded at 30000 ms).
- When: At +30,000 ms the Desktop completes the command as succeeded via `POST /api/computer-use/hosts/:hostId/commands/:commandId/complete`; then at +30,000 ms, +59,999 ms and +60,000 ms it retries the completion with the opposite outcome (failure), with the member listing hosts and reading the command after each step.
- Then: The first completion returns HTTP 200; the host is `online` with last-seen at the +30,000 ms, and the command reads `succeeded` with completion time +30,000 ms and result `{ apps: [] }`. Each retry returns exactly `{ ok: true }` and leaves the command read unchanged; last-seen is +30,000 ms for the retries at +30,000 and +59,999 ms and +60,000 ms for the last retry.

## computer-use-session-hosts-006

- Vitest: "Native Computer Use session authentication > refreshes liveness for failed completion at 29999 ms and preserves the result through retries"
- Mode: run
- Given: A signed-in workspace admin's Desktop registered at a fixed time and claimed an `apps.list` command with a 60 s timeout (row: failed at 29999 ms).
- When: At +29,999 ms the Desktop completes the command as failed via `POST /api/computer-use/hosts/:hostId/commands/:commandId/complete`; then at +30,000 ms, +59,999 ms and +60,000 ms it retries the completion with the opposite outcome (success), with the member listing hosts and reading the command after each step.
- Then: The first completion returns HTTP 200; the host is `online` with last-seen at the registration time, and the command reads `failed` with completion time +29,999 ms and the `app_not_found` error. Each retry returns exactly `{ ok: true }` and leaves the command read unchanged; last-seen is +30,000 ms for the retries at +30,000 and +59,999 ms and +60,000 ms for the last retry.

## computer-use-session-hosts-007

- Vitest: "Native Computer Use session authentication > refreshes liveness for failed completion at 30000 ms and preserves the result through retries"
- Mode: run
- Given: A signed-in workspace admin's Desktop registered at a fixed time and claimed an `apps.list` command with a 60 s timeout (row: failed at 30000 ms).
- When: At +30,000 ms the Desktop completes the command as failed via `POST /api/computer-use/hosts/:hostId/commands/:commandId/complete`; then at +30,000 ms, +59,999 ms and +60,000 ms it retries the completion with the opposite outcome (success), with the member listing hosts and reading the command after each step.
- Then: The first completion returns HTTP 200; the host is `online` with last-seen at the +30,000 ms, and the command reads `failed` with completion time +30,000 ms and the `app_not_found` error. Each retry returns exactly `{ ok: true }` and leaves the command read unchanged; last-seen is +30,000 ms for the retries at +30,000 and +59,999 ms and +60,000 ms for the last retry.

## computer-use-session-hosts-008

- Vitest: "Native Computer Use session authentication > acknowledges a completion that loses to timeout during screenshot storage without refreshing liveness"
- Mode: run
- Given: A signed-in workspace admin's Desktop has claimed an `app.state` Calculator command with a 1000 ms timeout. While its screenshot is being stored, the clock reaches +30 s and a member read marks the command `failed` with `timeout`.
- When: The Desktop completes the command successfully with a PNG screenshot via `POST /api/computer-use/hosts/:hostId/commands/:commandId/complete`.
- Then: The completion returns exactly `{ ok: true }`, but the command still reads `failed` with code `timeout`, completed at +30 s, and has no `result`. The host stays `online` with last-seen at the registration time.

## computer-use-session-hosts-009

- Vitest: "Native Computer Use session authentication > rejects another user, organization, session, and replaced connection"
- Mode: run
- Given: A signed-in workspace admin registered a Desktop host (generation 1).
- When: Callers with a different user, a different organization and a different session each poll `POST /api/computer-use/hosts/:hostId/commands/next`; the owner re-registers, then tries to stop generation 1 and heartbeats generation 2.
- Then: Each foreign poll returns HTTP 409. Re-registration returns the same host ID with connection generation 2 and its channel name. Stopping generation 1 returns HTTP 409 and the generation 2 heartbeat returns HTTP 200.

## computer-use-session-hosts-010

- Vitest: "Native Computer Use session authentication > expires cached authority after remote session revocation before heartbeat"
- Mode: run
- Given: A signed-in workspace admin's Desktop registered and claimed an `apps.list` command; then the user's sign-in session is revoked at the identity provider (row: session revocation before heartbeat).
- When: At +29,999 ms the Desktop heartbeats; at +30,000 ms it sends `POST /api/computer-use/hosts/:hostId/heartbeat`; the member lists hosts.
- Then: The heartbeat at +29,999 ms still returns HTTP 200 from cached authority. The request at +30,000 ms returns HTTP 409, and the host is listed `offline`.

## computer-use-session-hosts-011

- Vitest: "Native Computer Use session authentication > expires cached authority after remote session revocation before next"
- Mode: run
- Given: A signed-in workspace admin's Desktop registered and claimed an `apps.list` command; then the user's sign-in session is revoked at the identity provider (row: session revocation before next).
- When: At +29,999 ms the Desktop heartbeats; at +30,000 ms it sends `POST /api/computer-use/hosts/:hostId/commands/next`; the member lists hosts.
- Then: The heartbeat at +29,999 ms still returns HTTP 200 from cached authority. The request at +30,000 ms returns HTTP 409, and the host is listed `offline`.

## computer-use-session-hosts-012

- Vitest: "Native Computer Use session authentication > expires cached authority after remote session revocation before complete"
- Mode: run
- Given: A signed-in workspace admin's Desktop registered and claimed an `apps.list` command; then the user's sign-in session is revoked at the identity provider (row: session revocation before complete).
- When: At +29,999 ms the Desktop heartbeats; at +30,000 ms it sends a successful completion via `POST /api/computer-use/hosts/:hostId/commands/:commandId/complete`; the member lists hosts.
- Then: The heartbeat at +29,999 ms still returns HTTP 200 from cached authority. The request at +30,000 ms returns HTTP 409, and the host is listed `offline`.

## computer-use-session-hosts-013

- Vitest: "Native Computer Use session authentication > expires cached authority after remote session revocation before stop"
- Mode: run
- Given: A signed-in workspace admin's Desktop registered and claimed an `apps.list` command; then the user's sign-in session is revoked at the identity provider (row: session revocation before stop).
- When: At +29,999 ms the Desktop heartbeats; at +30,000 ms it sends `POST /api/computer-use/hosts/:hostId/stop`; the member lists hosts.
- Then: The heartbeat at +29,999 ms still returns HTTP 200 from cached authority. The request at +30,000 ms returns HTTP 409, and the host is listed `offline`.

## computer-use-session-hosts-014

- Vitest: "Native Computer Use session authentication > expires cached authority after remote membership revocation before heartbeat"
- Mode: run
- Given: A signed-in workspace admin's Desktop registered and claimed an `apps.list` command; then the user's workspace membership is removed at the identity provider (row: membership revocation before heartbeat).
- When: At +29,999 ms the Desktop heartbeats; at +30,000 ms it sends `POST /api/computer-use/hosts/:hostId/heartbeat`; the member lists hosts.
- Then: The heartbeat at +29,999 ms still returns HTTP 200 from cached authority. The request at +30,000 ms returns HTTP 409, and the host is listed `offline`.

## computer-use-session-hosts-015

- Vitest: "Native Computer Use session authentication > expires cached authority after remote membership revocation before next"
- Mode: run
- Given: A signed-in workspace admin's Desktop registered and claimed an `apps.list` command; then the user's workspace membership is removed at the identity provider (row: membership revocation before next).
- When: At +29,999 ms the Desktop heartbeats; at +30,000 ms it sends `POST /api/computer-use/hosts/:hostId/commands/next`; the member lists hosts.
- Then: The heartbeat at +29,999 ms still returns HTTP 200 from cached authority. The request at +30,000 ms returns HTTP 409, and the host is listed `offline`.

## computer-use-session-hosts-016

- Vitest: "Native Computer Use session authentication > expires cached authority after remote membership revocation before complete"
- Mode: run
- Given: A signed-in workspace admin's Desktop registered and claimed an `apps.list` command; then the user's workspace membership is removed at the identity provider (row: membership revocation before complete).
- When: At +29,999 ms the Desktop heartbeats; at +30,000 ms it sends a successful completion via `POST /api/computer-use/hosts/:hostId/commands/:commandId/complete`; the member lists hosts.
- Then: The heartbeat at +29,999 ms still returns HTTP 200 from cached authority. The request at +30,000 ms returns HTTP 409, and the host is listed `offline`.

## computer-use-session-hosts-017

- Vitest: "Native Computer Use session authentication > expires cached authority after remote membership revocation before stop"
- Mode: run
- Given: A signed-in workspace admin's Desktop registered and claimed an `apps.list` command; then the user's workspace membership is removed at the identity provider (row: membership revocation before stop).
- When: At +29,999 ms the Desktop heartbeats; at +30,000 ms it sends `POST /api/computer-use/hosts/:hostId/stop`; the member lists hosts.
- Then: The heartbeat at +29,999 ms still returns HTTP 200 from cached authority. The request at +30,000 ms returns HTTP 409, and the host is listed `offline`.

## computer-use-session-hosts-018

- Vitest: "Native Computer Use session authentication > denies a missing session and an inactive provider session at registration"
- Mode: run
- Given: A Desktop caller's sign-in has no session ID, and later the caller's session is revoked at the identity provider.
- When: The Desktop calls `POST /api/computer-use/hosts/register` in each state.
- Then: Both registrations return HTTP 401 with error code `UNAUTHORIZED`.

## computer-use-session-hosts-019

- Vitest: "Native Computer Use session authentication > does not let a new connection report an older connection's action"
- Mode: run
- Given: A signed-in workspace admin's Desktop (generation 1) claimed an `apps.list` command, and the Desktop then re-registered as generation 2.
- When: The Desktop completes the command via `POST /api/computer-use/hosts/:hostId/commands/:commandId/complete` with generation 1 and then with generation 2.
- Then: The generation 1 completion returns HTTP 409, the generation 2 completion returns HTTP 404, and the command still reads `running`.

## computer-use-session-hosts-020

- Vitest: "Native Computer Use session authentication > rejects a connection replaced during screenshot upload without confirming its result"
- Mode: run
- Given: A signed-in workspace admin's Desktop claimed an `app.state` Calculator command. While its screenshot is being uploaded, the same installation re-registers (row: replaced) and receives generation 2 with its channel name.
- When: The original connection completes the command successfully with a PNG screenshot.
- Then: The completion returns HTTP 409 with error code `HOST_CONNECTION_INVALID`, and the command still reads `running`.

## computer-use-session-hosts-021

- Vitest: "Native Computer Use session authentication > rejects a connection stopped during screenshot upload without confirming its result"
- Mode: run
- Given: A signed-in workspace admin's Desktop claimed an `app.state` Calculator command. While its screenshot is being uploaded, the connection is stopped (row: stopped), returning `{ ok: true, hostId }`.
- When: The stopped connection completes the command successfully with a PNG screenshot.
- Then: The completion returns HTTP 409 with error code `HOST_CONNECTION_INVALID`, and the command still reads `running`.

## computer-use-session-hosts-022

- Vitest: "Native Computer Use session authentication > cancels a stalled Clerk session read and recovers the same connection"
- Mode: run
- Given: A signed-in workspace admin's Desktop registered 31 seconds ago, so authority must be revalidated, and the identity provider's session lookup stalls (row: session).
- When: The Desktop polls `POST /api/computer-use/hosts/:hostId/commands/next`, then polls again after the stalled request ends.
- Then: The first poll returns HTTP 503 after the API cancels the stalled provider request. The next poll on the same connection returns HTTP 200 with status `idle`.

## computer-use-session-hosts-023

- Vitest: "Native Computer Use session authentication > cancels a stalled Clerk membership read and recovers the same connection"
- Mode: run
- Given: A signed-in workspace admin's Desktop registered 31 seconds ago, so authority must be revalidated, and the identity provider's organization membership lookup stalls (row: membership).
- When: The Desktop polls `POST /api/computer-use/hosts/:hostId/commands/next`, then polls again after the stalled request ends.
- Then: The first poll returns HTTP 503 after the API cancels the stalled provider request. The next poll on the same connection returns HTTP 200 with status `idle`.

## computer-use-session-hosts-024

- Vitest: "Native Computer Use session authentication > pauses after expired validation during a Clerk outage and recovers the same connection"
- Mode: run
- Given: A signed-in workspace admin's Desktop registered 31 seconds ago and the identity provider's session lookup returns 503.
- When: The Desktop polls `POST /api/computer-use/hosts/:hostId/commands/next`, then polls again after the provider recovers.
- Then: The first poll returns HTTP 503, and after recovery the same connection's poll returns exactly `{ status: "idle" }`.

## computer-use-session-hosts-025

- Vitest: "Native Computer Use session authentication > exposes provider rate limits without creating a host connection"
- Mode: run
- Given: A Desktop caller is signed in but the identity provider rate-limits the session lookup with a 7 second retry-after.
- When: The Desktop calls `POST /api/computer-use/hosts/register`, and the member lists `GET /api/computer-use/hosts`.
- Then: Registration returns HTTP 429 with a `Retry-After: 7` header, and the host list is empty.
