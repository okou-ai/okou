# feishu-message-delivery

## feishu-message-delivery-001

- Vitest: "feishu integration > switches a failed conversation's model through its native card callback"
- Mode: run
- Given: A connected Feishu member has debug visibility enabled and sent an encrypted DM that started a run. The Runner completes it with `account_verification_required` and the bot posts its failure card tied to the thread's failed event.
- When: An unrelated sender tries the card action. The owner opens the native selector, chooses Auto, then resubmits stale selector state with another model. The authenticated Runner later completes the continued run.
- Then: The other sender and stale submission receive error toasts. The owner gets a native selector and `Switched to Auto`, thread readback stays on `auto`, and the thread and Runner input contain a new `continue` prompt. The provider receives one new reaction when continuation starts and one removal after its HTTP 200 completion.

## feishu-message-delivery-002

- Vitest: "feishu integration > rejects account rebinding and replaces the connected identity"
- Mode: run
- Given: A workspace member is connected to a Feishu bot and has a working managed connector source. Another workspace member can open the account's old connection link.
- When: The second member tries to complete OAuth for the already-bound provider identity. The original owner then completes OAuth for a new identity through the legacy browser connect link, and both old and new identities send a DM.
- Then: The attempted rebind redirects to the provider settings with `This Feishu account is already connected.`. The legacy link returns HTTP 307 to the provider, and replacing the identity keeps the existing managed connector source ID. The old identity receives a connection prompt and the new one gets command help. Status remains installed, connected, verified, and shows the original app and tenant.

## feishu-message-delivery-003

- Vitest: "feishu integration > handles connected commands and disconnects the current user"
- Mode: run
- Given: A workspace user is connected to a configured Feishu bot.
- When: The user sends encrypted `/help`, `/connect`, and an unknown command by DM, then sends `/disconnect` twice and checks integration status.
- Then: Provider replies include text command help and `Already connected`. The first disconnect is confirmed and the second says `You are not connected.`. HTTP 200 status shows the installation remains while the current user is disconnected.

## feishu-message-delivery-004

- Vitest: "feishu integration > imports a private Feishu image before dispatch"
- Mode: run
- Given: A linked Feishu member sends an encrypted DM containing a private image; the provider can serve it as `image/png` using the installation tenant token.
- When: The webhook receives the message. The member and Runner read the imported attachment, then the same webhook is replayed and a distinct message supplies the same provider file key.
- Then: Exactly one authenticated provider download and one upload occur. The Runner prompt exposes an Okou file ID under `[Web file]` rather than the raw provider key, the preview returns the original bytes and MIME type, and the two distinct input parts share that file ID.

## feishu-message-delivery-005

- Vitest: "feishu integration > imports a private Feishu file before dispatch"
- Mode: run
- Given: A linked Feishu member sends an encrypted DM containing a private file; the provider can serve it as `application/pdf` using the installation tenant token.
- When: The webhook receives the message. The member and Runner read the imported attachment, then the same webhook is replayed and a distinct message supplies the same provider file key.
- Then: Exactly one authenticated provider download and one upload occur. The Runner prompt exposes an Okou file ID under `[Web file]` rather than the raw provider key, the preview returns the original bytes and MIME type, and the two distinct input parts share that file ID.

## feishu-message-delivery-006

- Vitest: "feishu integration > applies Slack retry policy to Feishu file HTTP 403 across messages"
- Mode: run
- Given: A linked Feishu member sends the same private PDF resource in two messages. Its first download returns HTTP 403; the provider can serve the PDF by the time the second message arrives.
- When: The encrypted webhooks arrive with distinct message IDs. The Runner reads the first run and then the next steerable input.
- Then: The first input has a stored file ID, but no `[Web file]` prompt entry. Both stored input parts reference the same file ID. HTTP 403 is treated as permanent, with one total download attempt, no upload, and no `[Web file]` entry in the second input.

## feishu-message-delivery-007

- Vitest: "feishu integration > applies Slack retry policy to Feishu file HTTP 429 across messages"
- Mode: run
- Given: A linked Feishu member sends the same private PDF resource in two messages. Its first download returns HTTP 429; the provider can serve the PDF by the time the second message arrives.
- When: The encrypted webhooks arrive with distinct message IDs. The Runner reads the first run and then the next steerable input.
- Then: The first input has a stored file ID, but no `[Web file]` prompt entry. Both stored input parts reference the same file ID. The transient failure is retried on the second message, producing two total downloads and one upload. The second prompt references the stable ID, and authenticated preview returns the recovered PDF bytes.

## feishu-message-delivery-008

- Vitest: "feishu integration > applies Slack retry policy to Feishu file HTTP 503 across messages"
- Mode: run
- Given: A linked Feishu member sends the same private PDF resource in two messages. Its first download returns HTTP 503; the provider can serve the PDF by the time the second message arrives.
- When: The encrypted webhooks arrive with distinct message IDs. The Runner reads the first run and then the next steerable input.
- Then: The first input has a stored file ID, but no `[Web file]` prompt entry. Both stored input parts reference the same file ID. The transient failure is retried on the second message, producing two total downloads and one upload. The second prompt references the stable ID, and authenticated preview returns the recovered PDF bytes.

## feishu-message-delivery-009

- Vitest: "lark integration > switches a failed conversation's model through its native card callback"
- Mode: run
- Given: A connected Lark member has debug visibility enabled and sent an encrypted DM that started a run. The Runner completes it with `account_verification_required` and the bot posts its failure card tied to the thread's failed event.
- When: An unrelated sender tries the card action. The owner opens the native selector, chooses Auto, then resubmits stale selector state with another model. The authenticated Runner later completes the continued run.
- Then: The other sender and stale submission receive error toasts. The owner gets a native selector and `Switched to Auto`, thread readback stays on `auto`, and the thread and Runner input contain a new `continue` prompt. The provider receives one new reaction when continuation starts and one removal after its HTTP 200 completion.

## feishu-message-delivery-010

- Vitest: "lark integration > rejects account rebinding and replaces the connected identity"
- Mode: run
- Given: A workspace member is connected to a Lark bot and has a working managed connector source. Another workspace member can open the account's old connection link.
- When: The second member tries to complete OAuth for the already-bound provider identity. The original owner then completes OAuth for a new identity through the legacy browser connect link, and both old and new identities send a DM.
- Then: The attempted rebind redirects to the provider settings with `This Lark account is already connected.`. The legacy link returns HTTP 307 to the provider, and replacing the identity keeps the existing managed connector source ID. The old identity receives a connection prompt and the new one gets command help. Status remains installed, connected, verified, and shows the original app and tenant.

## feishu-message-delivery-011

- Vitest: "lark integration > handles connected commands and disconnects the current user"
- Mode: run
- Given: A workspace user is connected to a configured Lark bot.
- When: The user sends encrypted `/help`, `/connect`, and an unknown command by DM, then sends `/disconnect` twice and checks integration status.
- Then: Provider replies include text command help and `Already connected`. The first disconnect is confirmed and the second says `You are not connected.`. HTTP 200 status shows the installation remains while the current user is disconnected.

## feishu-message-delivery-012

- Vitest: "lark integration > imports a private Feishu image before dispatch"
- Mode: run
- Given: A linked Lark member sends an encrypted DM containing a private image; the provider can serve it as `image/png` using the installation tenant token.
- When: The webhook receives the message. The member and Runner read the imported attachment, then the same webhook is replayed and a distinct message supplies the same provider file key.
- Then: Exactly one authenticated provider download and one upload occur. The Runner prompt exposes an Okou file ID under `[Web file]` rather than the raw provider key, the preview returns the original bytes and MIME type, and the two distinct input parts share that file ID.

## feishu-message-delivery-013

- Vitest: "lark integration > imports a private Feishu file before dispatch"
- Mode: run
- Given: A linked Lark member sends an encrypted DM containing a private file; the provider can serve it as `application/pdf` using the installation tenant token.
- When: The webhook receives the message. The member and Runner read the imported attachment, then the same webhook is replayed and a distinct message supplies the same provider file key.
- Then: Exactly one authenticated provider download and one upload occur. The Runner prompt exposes an Okou file ID under `[Web file]` rather than the raw provider key, the preview returns the original bytes and MIME type, and the two distinct input parts share that file ID.

## feishu-message-delivery-014

- Vitest: "lark integration > applies Slack retry policy to Feishu file HTTP 403 across messages"
- Mode: run
- Given: A linked Lark member sends the same private PDF resource in two messages. Its first download returns HTTP 403; the provider can serve the PDF by the time the second message arrives.
- When: The encrypted webhooks arrive with distinct message IDs. The Runner reads the first run and then the next steerable input.
- Then: The first input has a stored file ID, but no `[Web file]` prompt entry. Both stored input parts reference the same file ID. HTTP 403 is treated as permanent, with one total download attempt, no upload, and no `[Web file]` entry in the second input.

## feishu-message-delivery-015

- Vitest: "lark integration > applies Slack retry policy to Feishu file HTTP 429 across messages"
- Mode: run
- Given: A linked Lark member sends the same private PDF resource in two messages. Its first download returns HTTP 429; the provider can serve the PDF by the time the second message arrives.
- When: The encrypted webhooks arrive with distinct message IDs. The Runner reads the first run and then the next steerable input.
- Then: The first input has a stored file ID, but no `[Web file]` prompt entry. Both stored input parts reference the same file ID. The transient failure is retried on the second message, producing two total downloads and one upload. The second prompt references the stable ID, and authenticated preview returns the recovered PDF bytes.

## feishu-message-delivery-016

- Vitest: "lark integration > applies Slack retry policy to Feishu file HTTP 503 across messages"
- Mode: run
- Given: A linked Lark member sends the same private PDF resource in two messages. Its first download returns HTTP 503; the provider can serve the PDF by the time the second message arrives.
- When: The encrypted webhooks arrive with distinct message IDs. The Runner reads the first run and then the next steerable input.
- Then: The first input has a stored file ID, but no `[Web file]` prompt entry. Both stored input parts reference the same file ID. The transient failure is retried on the second message, producing two total downloads and one upload. The second prompt references the stable ID, and authenticated preview returns the recovered PDF bytes.
