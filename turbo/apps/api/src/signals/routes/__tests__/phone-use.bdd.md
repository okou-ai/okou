# phone-use

## phone-use-001

- Vitest: "Phone Use native connection authority > returns temporary unavailability without making the device ready when Clerk times out"
- Mode: run
- Given: A signed-in member of a staff organization has Phone Use enabled, has registered an iPhone, and the phone is present on the realtime presence channel. The identity provider's session lookup hangs and does not return within the request.
- When: The native app sends `POST /api/phone-use/devices/:deviceId/heartbeat` with its generation and `ready: true`, then lists `GET /api/phone-use/devices`.
- Then: The heartbeat returns HTTP 503 with error code `PROVIDER_UNAVAILABLE`. The device list returns HTTP 200 with the registered device marked `online: false`.

## phone-use-002

- Vitest: "Phone Use native connection authority > advertises online only while native control and presence are available and fences replaced connections"
- Mode: run
- Given: A signed-in member with Phone Use enabled has registered an iPhone and obtained a realtime token for it; the phone is present only on its own realtime channel.
- When: The member lists devices after the clock advances 2 minutes, sends a ready heartbeat, lists again, lets the clock advance a further 45,001 ms, sends another ready heartbeat, then the phone leaves presence, then rejoins and the device is registered again.
- Then: `POST /api/phone-use/devices/:deviceId/realtime` returns HTTP 200. The device is `online: false` before any ready heartbeat, `online: true` right after it, `online: false` once the heartbeat expires, and `online: false` when presence is gone despite a fresh heartbeat. After re-registration the same device ID reports generation incremented by 1 and `online: false`.

## phone-use-003

- Vitest: "Phone Use native connection authority > reports presence lookup failures without pretending all phones are offline"
- Mode: run
- Given: A signed-in member with Phone Use enabled has a registered phone. The realtime presence lookup fails, then later returns no members.
- When: The member lists `GET /api/phone-use/devices` while presence fails and again after it recovers.
- Then: The first list returns HTTP 503 with error code `PROVIDER_UNAVAILABLE` instead of reporting phones offline. After recovery the list returns HTTP 200 with the device `online: false`.

## phone-use-004

- Vitest: "Phone Use native connection authority > replaces a connection without allowing its previous generation to go online"
- Mode: run
- Given: A signed-in member with Phone Use enabled has registered a phone and sent a ready heartbeat for its first generation.
- When: The phone registers again via `POST /api/phone-use/devices`, then sends a ready heartbeat using the old generation, and the member lists devices.
- Then: The re-registration returns the same device ID with generation incremented by 1 and `online: false`. The heartbeat with the old generation returns HTTP 409, and the device remains listed as `online: false`.

## phone-use-005

- Vitest: "Phone Use native connection authority > fences a delayed disconnect after a replacement connection goes online"
- Mode: run
- Given: A signed-in member with Phone Use enabled has registered a phone. A disconnect request for the first generation is delayed while its session check is in progress.
- When: While the disconnect is pending, the phone re-registers and sends a ready heartbeat for the new generation; then the delayed `POST /api/phone-use/devices/:deviceId/disconnect` completes and the member lists devices with the phone present.
- Then: The delayed disconnect returns HTTP 409. The device list shows the same device ID at the replacement generation with `online: true`.

## phone-use-006

- Vitest: "Phone Use native connection authority > keeps device ownership private and prevents another account from disconnecting it"
- Mode: run
- Given: One signed-in member with Phone Use enabled has registered a phone. A second account in the same organization also enables Phone Use.
- When: The second account lists `GET /api/phone-use/devices` and sends `POST /api/phone-use/devices/:deviceId/disconnect` for the first member's device and generation.
- Then: The second account's device list is empty, and its disconnect attempt returns HTTP 409.

## phone-use-007

- Vitest: "Phone Use native connection authority > requires explicit opt-in and a live native session in a staff organization"
- Mode: run
- Given: A member of a staff organization signs in with a live native session and has not opted into Phone Use.
- When: The member reads feature switches, registers a phone, enables Phone Use, registers again, disables Phone Use, lists devices, disconnects the registered device, re-enables Phone Use, and registers again after the native session is revoked.
- Then: The Phone Use switch is initially off and registration returns HTTP 403 with a message containing `disabled`. After enabling, the switch is on and registration returns HTTP 200. With the switch off, listing returns HTTP 403 but disconnect still returns HTTP 200. With a revoked native session, registration returns HTTP 403.

## phone-use-008

- Vitest: "Phone Use native connection authority > requires explicit opt-in and a live native session in another organization"
- Mode: run
- Given: A member of a non-staff organization signs in with a live native session and has not opted into Phone Use.
- When: The member reads feature switches, registers a phone, enables Phone Use, registers again, disables Phone Use, lists devices, disconnects the registered device, re-enables Phone Use, and registers again after the native session is revoked.
- Then: The Phone Use switch is initially off and registration returns HTTP 403 with a message containing `disabled`. After enabling, the switch is on and registration returns HTTP 200. With the switch off, listing returns HTTP 403 but disconnect still returns HTTP 200. With a revoked native session, registration returns HTTP 403.

## phone-use-009

- Vitest: "chat consent stays owner-scoped and can be revoked without native readiness"
- Mode: run
- Given: A member owns a chat thread and has registered a phone from a native session with Phone Use enabled. The member also has a web session, and another member exists in the same organization.
- When: From the web session the member calls `POST /api/phone-use/grants` with a wrong generation, then with the correct device and generation, and reads `GET /api/phone-use/grants/:threadId`. The other member reads and grants on the same thread. The owner then grants while the native session is revoked, disables Phone Use, and revokes the grant with `allow: false`.
- Then: The wrong-generation grant returns HTTP 404; the correct grant returns HTTP 200 and the chat grant shows that device and generation. The other member receives HTTP 404 for both read and grant. With the native session revoked, granting returns HTTP 403, while revoking with Phone Use disabled returns HTTP 200 and the chat grant selection becomes `null`.

## phone-use-010

- Vitest: "binds real Run tokens to a replaceable chat grant and validates every native commit"
- Mode: run
- Given: A member owns a chat thread, has registered a phone from a native session with Phone Use enabled, and grants it to the thread from a web session. Runs in the thread receive Okou tokens.
- When: The member launches Runs in the thread and drives operations: the Run token creates `POST /api/phone-use/operations`, polls `GET /api/phone-use/operations/:operationId`, and stops the session; the native app claims work via `POST /api/phone-use/devices/:deviceId/next`, validates and completes operations, and finally re-registers.
- Then: A web-session heartbeat returns HTTP 409 while the native heartbeat returns 200, and the Run's system prompt says it captured a Phone Use grant; a Run token cannot grant (403). The operation is queued with a per-operation subscribe-only realtime channel, a retry with the same ID succeeds even when the notification fails, and reusing the ID with another action returns 409. An `approval_required` result stays reviewable past the dispatch deadline with an unchanged expiry, becomes `unknown` after expiry and stays `unknown` despite a late success; validation returns 403, and a revoked native session makes reads return 403 with `session has ended`. After the grant is replaced, `next` reports `sessionEnded` and new operations return 403 mentioning the grant. A following Run's observe operation succeeds, `session.stop` succeeds with `admissionClosed: true` and closes pending review as `unknown`, `next` reports `stopRequested`, further operations return 409, and after re-registration a new Run is told no phone is authorized and gets 403 asking to enable the phone in the chat's Connectors menu.
