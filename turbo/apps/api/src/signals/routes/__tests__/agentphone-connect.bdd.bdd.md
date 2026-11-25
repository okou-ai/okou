# agentphone-connect.bdd

## agentphone-connect.bdd-001

- Vitest: "AgentPhone connection status and explicit phone switching > checks a signed connection without linking, then recognizes the connected number"
- Mode: run
- Given: AgentPhone is configured with a signed webhook. A sender texts `/connect` over SMS and receives a signed connect link for their number. A signed-in member has no linked phone.
- When: The member calls `GET /api/integrations/agentphone/connect-status` with the signed proof, reads `GET /api/integrations/agentphone/link`, connects with `POST /api/agentphone/connect`, and checks the connect status again.
- Then: The first status check returns HTTP 200 with exactly `{ kind: "connect" }` and the link read shows `linked: false`, so checking does not link. Connecting returns HTTP 200, and the second status check returns `{ kind: "connected", phoneHandle }` for that number.

## agentphone-connect.bdd-002

- Vitest: "AgentPhone connection status and explicit phone switching > requires explicit switching and releases the previous number only after success"
- Mode: run
- Given: AgentPhone is configured with a signed webhook. A signed-in member has connected a first number and holds a fresh signed connect proof for a second number.
- When: The member checks `GET /api/integrations/agentphone/connect-status` for the second number, calls `POST /api/agentphone/connect` without and then twice with `replacePhoneHandle` set to the first number, and a different member then connects the first number.
- Then: The status returns `{ kind: "phone_mismatch", currentPhoneHandle }` with the first number. Connecting without a replacement returns HTTP 409 and the member stays linked to the first number. Both explicit switch requests return HTTP 200 and the member is linked to the second number. The other member can then connect the released first number (HTTP 200) and is linked to it.

## agentphone-connect.bdd-003

- Vitest: "AgentPhone connection status and explicit phone switching > preserves both bindings when another account claims the requested number after the status check"
- Mode: run
- Given: AgentPhone is configured with a signed webhook. A signed-in member has connected a first number and holds a fresh signed proof for a second number; the status check reports `phone_mismatch`.
- When: Another member connects the second number via `POST /api/agentphone/connect`, then the first member checks `GET /api/integrations/agentphone/connect-status` and attempts `POST /api/agentphone/connect` with `replacePhoneHandle` set to their first number.
- Then: The status now returns exactly `{ kind: "phone_in_use" }`, the switch returns HTTP 409, the first member stays linked to the first number, and the other member stays linked to the second number.

## agentphone-connect.bdd-004

- Vitest: "AgentPhone connection status and explicit phone switching > allows only one competing replacement of the confirmed binding"
- Mode: run
- Given: AgentPhone is configured with a signed webhook. A signed-in member has connected a first number and holds fresh signed proofs for two other numbers.
- When: The member sends two concurrent `POST /api/agentphone/connect` requests, each replacing the first number with one of the two new numbers.
- Then: One request returns HTTP 200 and the other HTTP 409, and `GET /api/integrations/agentphone/link` shows the member linked to the winning number.

## agentphone-connect.bdd-005

- Vitest: "AgentPhone connection status and explicit phone switching > switches from an iMessage email handle to a phone number"
- Mode: run
- Given: AgentPhone is configured with a signed webhook. A signed-in member has connected an iMessage email handle and holds a fresh signed SMS proof for a phone number.
- When: The member calls `POST /api/agentphone/connect` with the phone proof and `replacePhoneHandle` set to the email handle.
- Then: The switch succeeds with HTTP 200 and the member is linked to the phone number.

## agentphone-connect.bdd-006

- Vitest: "AgentPhone connection status and explicit phone switching > rejects a stale confirmation after the current number changes"
- Mode: run
- Given: AgentPhone is configured with a signed webhook. A signed-in member has connected a first number and holds fresh signed proofs for a second and a third number.
- When: The member switches from the first number to the second via `POST /api/agentphone/connect` with `replacePhoneHandle`, then tries to switch to the third number still naming the first number as the one to replace.
- Then: The first switch returns HTTP 200 and the stale switch returns HTTP 409; the member remains linked to the second number.

## agentphone-connect.bdd-007

- Vitest: "AgentPhone connection status and explicit phone switching > rejects a tampered proof for status and switching without removing the old number"
- Mode: run
- Given: AgentPhone is configured with a signed webhook. A signed-in member has connected a first number and holds a proof for a second number whose signature is replaced with 64 zeros (tampered).
- When: The member calls `GET /api/integrations/agentphone/connect-status` with the tampered proof and `POST /api/agentphone/connect` with it and `replacePhoneHandle` set to the first number.
- Then: Both requests return HTTP 400, and the member stays linked to the first number.

## agentphone-connect.bdd-008

- Vitest: "AgentPhone connection status and explicit phone switching > rejects a expired proof for status and switching without removing the old number"
- Mode: run
- Given: AgentPhone is configured with a signed webhook. A signed-in member has connected a first number and holds a signed proof for a second number, and the clock advances 601 seconds so the proof has expired.
- When: The member calls `GET /api/integrations/agentphone/connect-status` with the expired proof and `POST /api/agentphone/connect` with it and `replacePhoneHandle` set to the first number.
- Then: Both requests return HTTP 400, and the member stays linked to the first number.

## agentphone-connect.bdd-009

- Vitest: "AgentPhone connection status and explicit phone switching > requires authentication for connection status"
- Mode: run
- Given: AgentPhone is configured with a signed webhook and a sender holds a valid signed connect proof, but the caller is not signed in.
- When: The unauthenticated caller requests `GET /api/integrations/agentphone/connect-status` with the proof.
- Then: The API responds with HTTP 401.
