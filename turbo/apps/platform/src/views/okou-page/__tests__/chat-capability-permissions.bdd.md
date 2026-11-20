# Chat capability permissions

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [chat-capability-permissions.test.tsx](chat-capability-permissions.test.tsx).

## chat-capability-permissions-001

Original test `Expose the full permission scope on the card itself`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-capability-permissions.test.tsx#L133).

- **Given** A chat response requests permission for a connector, and valid permission details and an empty grant list are available.
- **When** The user views the permission card.
- **Then** The card shows the connector's permission scope, including “Scope Service permissions” and “Allow meeting:read:list_meetings,” and offers an enabled Confirm button.

## chat-capability-permissions-002

Original test `Fail closed on permission load and save errors`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-capability-permissions.test.tsx#L167).

- **Given** A chat response requests records.read permission, but loading permission status initially fails; saving the permission also fails.
- **When** The permission service recovers, the user confirms, and the save request returns an error.
- **Then** While loading fails, the card says “Couldn't load permission status,” hides Confirm, and does not send a chat message. After recovery, Confirm is enabled; after saving fails, the card says “Couldn't update permissions,” does not say “Permissions updated,” and still sends no chat message.

## chat-capability-permissions-003

Original test `Hide confirmation when connector permission details are invalid`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-capability-permissions.test.tsx#L230).

- **Given** A chat response requests permission for one connector whose permission details return forbidden, and another connector permission not listed in the returned details.
- **When** The user views both permission cards.
- **Then** The forbidden card shows “Couldn't load permission status,” and the incomplete-details card shows “Unknown permission.” Neither card offers Confirm.

## chat-capability-permissions-004

Original test `Reflect current connector permission decisions`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-capability-permissions.test.tsx#L285).

- **Given** A chat response requests allow for records.read, deny for records.write, and allow for records.archive. Current grants allow records.read until 2027, deny records.write, and allow records.archive only until 2025.
- **When** The user views the cards, then an external permission update changes records.archive to an allow grant lasting until 2027.
- **Then** The first card says “Already allowed,” the second says “Already denied,” and the expired archive grant says “Expired” with Confirm enabled. After the external update, the archive card says “Already allowed” and no longer offers Confirm.

## chat-capability-permissions-005

Original test `Permission cards keep the full operation pending and expose callback failure`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-capability-permissions.test.tsx#L367).

- **Given** A chat response requests reports.read permission with a follow-up chat prompt. The permission save succeeds, but the follow-up chat request remains pending and will fail.
- **When** The user confirms the permission and the follow-up request is pending, then it fails.
- **Then** The card remains in a disabled “Saving...” state while the follow-up is pending, does not yet say “Permissions updated,” and eventually shows “Couldn't update permissions” after the follow-up fails.

## chat-capability-permissions-006

Original test `Review and confirm connector permissions individually`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-capability-permissions.test.tsx#L427).

- **Given** A chat response requests allow for reports.read with a seven-day default, allow for an unknown permission, deny for reference.read, and allow for exports.run with a follow-up prompt. All are for the same connector, and the connector lists the three known permissions.
- **When** The user changes reports.read duration to 24 hours and confirms it, confirms the unknown permission, confirms the denial, and then confirms exports.run while its follow-up is pending.
- **Then** The reports.read card says “Permissions updated” and applies allow for 24 hours. The unknown permission can still be confirmed and applies allow for **unknown**; reference.read applies deny and shows “Permission denied.” While exports.run is pending, its button says “Saving...” and no chat message has been sent; after the pending request completes, the follow-up prompt is sent.
