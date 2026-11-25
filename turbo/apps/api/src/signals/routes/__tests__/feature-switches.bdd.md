# feature-switches

## feature-switches-001

- Vitest: "/api/feature-switches > stores the Antigravity opt-in only for the individual staff member"
- Mode: run
- Given: A signed-in member of a staff workspace, and a second member of the same staff workspace.
- When: The first member reads `GET /api/feature-switches`, enables `_geminiAntigravity` with `POST /api/feature-switches`, the peer reads, the first member reads again, and then disables the switch.
- Then: The switch is initially effective `false` and becomes `true` after the opt-in. The peer still reads `false`, the first member's opt-in persists as `true`, and disabling returns effective `false`.

## feature-switches-002

- Vitest: "/api/feature-switches > rejects a direct external Antigravity opt-in before writing any overrides"
- Mode: run
- Given: A signed-in admin of an ordinary (non-staff) workspace.
- When: The admin sends `POST /api/feature-switches` enabling `_geminiAntigravity` together with `_dummy`, then reads `GET /api/feature-switches`.
- Then: The update returns HTTP 403. The stored switches contain neither key, and `_geminiAntigravity` is effective `false`.

## feature-switches-003

- Vitest: "/api/feature-switches > enables presentation format for staff with personal opt-out overrides"
- Mode: run
- Given: A signed-in member of the staff workspace, and a peer in the same workspace.
- When: The member reads `presentationOutputFormat`, opts out with `POST /api/feature-switches`, reads again; the peer reads; the member resets with `DELETE /api/feature-switches` and reads.
- Then: The switch is initially effective `true`, becomes and stays `false` after the opt-out, remains `true` for the peer, and is `true` again after the reset.

## feature-switches-004

- Vitest: "/api/feature-switches > lets an ordinary member opt into presentation format without enabling it for peers"
- Mode: run
- Given: A signed-in member of an ordinary workspace, and a peer in the same workspace.
- When: The member reads `presentationOutputFormat`, opts in, reads; the peer reads; the member opts out, reads, opts in again, resets with `DELETE /api/feature-switches`, and reads.
- Then: The switch starts effective `false`; the opt-in stores and effects `true` and persists. The peer reads `false`. Opting out makes it `false`; after the reset the stored switches no longer contain the key and it is effective `false`.

## feature-switches-005

- Vitest: "/api/feature-switches > keeps presentation format enabled for its owner with personal opt-out and reset"
- Mode: run
- Given: The designated owner user of the presentation format feature is signed in to an ordinary workspace.
- When: The owner reads `presentationOutputFormat`, opts out, reads, opts in, resets with `DELETE /api/feature-switches`, and reads.
- Then: The switch is effective `true` initially, `false` after the opt-out and on reread, `true` after the opt-in, and `true` after the reset.

## feature-switches-006

- Vitest: "/api/feature-switches > keeps three-point timing available to its owner across workspaces with personal opt-out and opt-in"
- Mode: run
- Given: The designated owner user of three-point timing is signed in to an ordinary workspace that also has an admin peer.
- When: The owner reads `_artifactThreePointTimingV2`, opts out and reads; the admin peer reads; the owner reads from another workspace, then from the original workspace, and opts in again.
- Then: The switch is initially effective `true`; the opt-out stores and effects `false`, which persists. The peer reads `false`. In another workspace the owner reads `true`, while in the original workspace it is still `false`. Opting in stores and effects `true`, which persists.

## feature-switches-007

- Vitest: "/api/feature-switches > enables three-point timing for staff members with personal opt-out overrides"
- Mode: run
- Given: A signed-in member of a staff workspace, and a peer in the same workspace.
- When: The member reads `_artifactThreePointTimingV2`, opts out and reads; the peer reads; the member resets with `DELETE /api/feature-switches` and reads.
- Then: The switch is effective `true` initially, `false` after the opt-out and on reread, `true` for the peer, and `true` again after the reset.

## feature-switches-008

- Vitest: "/api/feature-switches > cannot grant three-point timing to an external admin through a stored opt-in"
- Mode: run
- Given: The designated owner user of three-point timing and an admin peer share an ordinary workspace.
- When: The owner reads `_artifactThreePointTimingV2`; the admin reads it, stores an opt-in with `POST /api/feature-switches`, and reads again; the owner reads again.
- Then: The owner reads effective `true`. The admin reads `false`; after the opt-in the stored switch is `true` but it remains effective `false` in the response and on reread. The owner still reads `true`.

## feature-switches-009

- Vitest: "/api/feature-switches > keeps a personal switch personal within one organization"
- Mode: run
- Given: Two signed-in members of the same workspace.
- When: The first member turns `_dummy` off with `POST /api/feature-switches`, the peer reads `GET /api/feature-switches`, and the first member reads again.
- Then: The first member's update returns `_dummy` effective `false`, the peer reads `_dummy` effective `true`, and the first member still reads `false`.

## feature-switches-010

- Vitest: "/api/feature-switches > shares larkIntegration overrides only within the same organization"
- Mode: run
- Given: Row `larkIntegration`: a signed-in member, a peer in the same workspace, and the same member in a different workspace.
- When: The member reads `larkIntegration`, enables it with `POST /api/feature-switches`, then the peer reads and the member reads from the other workspace.
- Then: The switch is initially off, the peer reads it on, and the member's other workspace reads it off.

## feature-switches-011

- Vitest: "/api/feature-switches > shares composerVoiceMessages overrides only within the same organization"
- Mode: run
- Given: Row `composerVoiceMessages`: a signed-in member, a peer in the same workspace, and the same member in a different workspace.
- When: The member reads `composerVoiceMessages`, enables it with `POST /api/feature-switches`, then the peer reads and the member reads from the other workspace.
- Then: The switch is initially off, the peer reads it on, and the member's other workspace reads it off.

## feature-switches-012

- Vitest: "/api/feature-switches > merges concurrent unrelated personal keys without losing either override"
- Mode: run
- Given: A signed-in member with no stored overrides.
- When: The member concurrently sends two `POST /api/feature-switches` updates, one setting `_realAgentInPreview: true` and one setting `_dummy: false`, then reads `GET /api/feature-switches`.
- Then: Both updates return HTTP 200 and the stored switches are exactly `{ _realAgentInPreview: true, _dummy: false }`.

## feature-switches-013

- Vitest: "/api/feature-switches > returns registered switches while merging known overrides for App 0.1162.3"
- Mode: run
- Given: Row App client at minimum supported version 0.1162.3: a signed-in member sends App client type and version headers and has stored `_realAgentInPreview: true` and `_dummy: false`.
- When: The member updates with `_realAgentInPreview: false`, an unregistered key, and legacy keys `batchConnectorPermissions: false` and `agentSuggestion: false`, then reads `GET /api/feature-switches`.
- Then: The update's stored switches are exactly `{ _realAgentInPreview: false, _dummy: false }`; effective switches include those values with `batchConnectorPermissions` and `agentSuggestion` still `true`, and have exactly the registered keys plus those two legacy keys. The later read returns the same stored and effective switches.

## feature-switches-014

- Vitest: "/api/feature-switches > returns registered switches while merging known overrides for iOS 0.51.12"
- Mode: run
- Given: Row iOS client at TestFlight minimum supported version 0.51.12: a signed-in member sends iOS client type and version headers and has stored `_realAgentInPreview: true` and `_dummy: false`.
- When: The member updates with `_realAgentInPreview: false`, an unregistered key, and legacy keys `batchConnectorPermissions: false` and `agentSuggestion: false`, then reads `GET /api/feature-switches`.
- Then: The update's stored switches are exactly `{ _realAgentInPreview: false, _dummy: false }`; effective switches include those values with `batchConnectorPermissions` and `agentSuggestion` still `true`, and have exactly the registered keys plus those two legacy keys. The later read returns the same stored and effective switches.

## feature-switches-015

- Vitest: "/api/feature-switches > deletes the caller's overrides and organization keys without deleting a peer's personal override"
- Mode: run
- Given: In one workspace, the caller stored `larkIntegration: true` (workspace-shared) and `_realAgentInPreview: true` (personal), and a peer stored `_dummy: true`.
- When: The caller sends `DELETE /api/feature-switches`, then the caller and peer each read `GET /api/feature-switches`.
- Then: The delete reports `deleted: true`. The caller's stored switches are `{}`. The peer's stored switches are exactly `{ _dummy: true }` and `larkIntegration` is off for the peer.

## feature-switches-016

- Vitest: "/api/feature-switches > merges a mixed-scope update without exposing the caller's personal override to a peer"
- Mode: run
- Given: In one workspace, a peer stored `_dummy: true`.
- When: Another member updates `larkIntegration: true` and `_realAgentInPreview: false` with `POST /api/feature-switches`, and the peer reads `GET /api/feature-switches`.
- Then: The member's stored switches are exactly `{ larkIntegration: true, _realAgentInPreview: false }`. The peer's stored switches are exactly `{ _dummy: true, larkIntegration: true }`.

## feature-switches-017

- Vitest: "/api/feature-switches > echoes and persists a stored org-scoped override as true"
- Mode: run
- Given: Row `true`: a signed-in member with no stored overrides.
- When: The member sets `larkIntegration: true` with `POST /api/feature-switches` and reads `GET /api/feature-switches`.
- Then: Both responses have stored switches exactly `{ larkIntegration: true }` and effective `larkIntegration` `true`.

## feature-switches-018

- Vitest: "/api/feature-switches > echoes and persists a stored org-scoped override as false"
- Mode: run
- Given: Row `false`: a signed-in member with no stored overrides.
- When: The member sets `larkIntegration: false` with `POST /api/feature-switches` and reads `GET /api/feature-switches`.
- Then: Both responses have stored switches exactly `{ larkIntegration: false }` and effective `larkIntegration` `false`.
