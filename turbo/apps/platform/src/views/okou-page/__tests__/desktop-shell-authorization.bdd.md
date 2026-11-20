# Desktop shell authorization

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [desktop-shell-authorization.test.tsx](desktop-shell-authorization.test.tsx).

## desktop-shell-authorization-001

Original test `A user approves and revokes directly from the card`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/desktop-shell-authorization.test.tsx#L103).

- **Given** A chat contains a pending Shell access request for Work Mac with the reason “Run the project tests.”
- **When** The user allows access for one hour and then revokes it.
- **Then** The card changes to show access allowed for this chat, then shows access revoked. The revoke action disappears after revocation.

## desktop-shell-authorization-002

Original test `The direct page explains run_active before allowing approval`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/desktop-shell-authorization.test.tsx#L147).

- **Given** The standalone authorization page has a pending request blocked because the requesting Run is active.
- **When** The user views the request, then a shell event clears the blocker.
- **Then** The page explains, “Wait for the requesting Run to finish before approving.” Allow is disabled while blocked, Deny remains enabled, and Allow becomes enabled after the event clears the blocker.

## desktop-shell-authorization-003

Original test `The direct page explains run_unavailable before allowing approval`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/desktop-shell-authorization.test.tsx#L147).

- **Given** The standalone authorization page has a pending request whose requesting Run is unavailable.
- **When** The user views the request, then a shell event clears the blocker.
- **Then** The page explains, “The requesting Run is unavailable. Ask for a new request in this chat.” Allow is disabled while blocked, Deny remains enabled, and Allow becomes enabled after the event clears the blocker.

## desktop-shell-authorization-004

Original test `The direct page explains chat_busy before allowing approval`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/desktop-shell-authorization.test.tsx#L147).

- **Given** The standalone authorization page has a pending request blocked because the chat is busy.
- **When** The user views the request, then a shell event clears the blocker.
- **Then** The page explains, “Wait for the current Run in this chat to finish before approving.” Allow is disabled while blocked, Deny remains enabled, and Allow becomes enabled after the event clears the blocker.

## desktop-shell-authorization-005

Original test `The direct page explains computer_changed before allowing approval`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/desktop-shell-authorization.test.tsx#L147).

- **Given** The standalone authorization page has a pending request blocked because the selected computer changed.
- **When** The user views the request, then a shell event clears the blocker.
- **Then** The page explains, “Select Work Mac again before approving.” Allow is disabled while blocked, Deny remains enabled, and Allow becomes enabled after the event clears the blocker.

## desktop-shell-authorization-006

Original test `The complete authorization reason is readable directly in the card`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/desktop-shell-authorization.test.tsx#L169).

- **Given** A chat contains a pending Shell access request with a long reason repeated ten times.
- **When** The user views and focuses the reason region.
- **Then** The complete reason is readable in the card, and Allow for one hour remains enabled.

## desktop-shell-authorization-007

Original test `A blocked card shows the reason and approval blocker together`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/desktop-shell-authorization.test.tsx#L187).

- **Given** A chat contains a pending Shell access request for Work Mac blocked because the computer changed.
- **When** The user views the card.
- **Then** The card displays both the request reason and “Select Work Mac again before approving.” Allow is disabled and Deny is enabled.

## desktop-shell-authorization-008

Original test `A user denies directly from the card and can inspect the result`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/desktop-shell-authorization.test.tsx#L202).

- **Given** A chat contains a pending Shell access request with its reason visible.
- **When** The user denies the request directly from the card.
- **Then** The card reports that access was denied, retains the request reason, and no longer offers Allow.

## desktop-shell-authorization-009

Original test `The card disables both actions during approval and shows an approval failure`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/desktop-shell-authorization.test.tsx#L223).

- **Given** A chat contains a pending Shell access request with Allow and Deny actions enabled.
- **When** The user starts approval while the approval request is pending, then the approval service fails.
- **Then** Both actions are disabled during approval. After failure, the card reports “Could not update authorization.” and both actions are enabled again.

## desktop-shell-authorization-010

Original test `Attaching realtime does not refetch a shell card, but a shell event updates its status`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/desktop-shell-authorization.test.tsx#L254).

- **Given** A chat card shows a pending Shell access request while realtime attachment is delayed.
- **When** Realtime attaches, and then shell events report approved and revoked statuses.
- **Then** Attaching realtime alone does not change the card or refetch its status. A shell event updates the card to show access allowed with Revoke, and a later event shows access revoked with no Revoke action.

## desktop-shell-authorization-011

Original test `The direct page automatically removes and restores the approval blocker on shell events`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/desktop-shell-authorization.test.tsx#L291).

- **Given** The standalone authorization page shows a pending request blocked by an active Run while realtime attachment is delayed.
- **When** Realtime attaches and shell events first clear and then restore the blocker.
- **Then** Allow becomes enabled after the clearing event and disabled again after the event restores the active-Run blocker.

## desktop-shell-authorization-012

Original test `A shell card retains pending content and actions while desktopShellAuthorizationChanged refreshes`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/desktop-shell-authorization.test.tsx#L336).

- **Given** A chat card shows a pending Shell access request with its reason and Allow action enabled.
- **When** A desktop shell authorization change begins a refresh that later reports the request denied.
- **Then** While refresh is pending, the card retains the computer name, reason, and enabled Allow action. After refresh, it reports access denied and offers neither Allow nor Revoke.

## desktop-shell-authorization-013

Original test `A shell card retains approved content and actions while desktopShellAuthorizationChanged refreshes`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/desktop-shell-authorization.test.tsx#L336).

- **Given** A chat card shows an approved Shell access grant with its reason and Revoke action enabled.
- **When** A desktop shell authorization change begins a refresh that later reports the grant revoked.
- **Then** While refresh is pending, the card retains the computer name, reason, and enabled Revoke action. After refresh, it reports access revoked and offers neither Allow nor Revoke.

## desktop-shell-authorization-014

Original test `A shell card retains pending content and actions while computerUseHostsChanged refreshes`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/desktop-shell-authorization.test.tsx#L336).

- **Given** A chat card shows a pending Shell access request with its reason and Allow action enabled.
- **When** A computer-use-host change begins a refresh that later reports the request denied.
- **Then** While refresh is pending, the card retains the computer name, reason, and enabled Allow action. After refresh, it reports access denied and offers neither Allow nor Revoke.

## desktop-shell-authorization-015

Original test `A shell card retains approved content and actions while computerUseHostsChanged refreshes`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/desktop-shell-authorization.test.tsx#L336).

- **Given** A chat card shows an approved Shell access grant with its reason and Revoke action enabled.
- **When** A computer-use-host change begins a refresh that later reports the grant revoked.
- **Then** While refresh is pending, the card retains the computer name, reason, and enabled Revoke action. After refresh, it reports access revoked and offers neither Allow nor Revoke.

## desktop-shell-authorization-016

Original test `A failed background read stops offering access and a later shell event recovers`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/desktop-shell-authorization.test.tsx#L383).

- **Given** A chat card shows an approved Shell access grant with Revoke enabled.
- **When** A background read fails, then a later shell event triggers a successful read showing the grant revoked.
- **Then** After the failed read, the card reports access unavailable, shows a disabled Authorization unavailable action, and removes Revoke. The later event restores the card and reports access revoked.

## desktop-shell-authorization-017

Original test `A host change makes an unavailable authorization stop offering approval`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/desktop-shell-authorization.test.tsx#L412).

- **Given** A chat card shows a pending Shell access request with Allow enabled.
- **When** A computer-use-host change makes the authorization unavailable.
- **Then** The card reports access unavailable and no longer offers Allow.

## desktop-shell-authorization-018

Original test `A request update rearms its deadline and expires it without another event`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/desktop-shell-authorization.test.tsx#L438).

- **Given** The standalone page shows a blocked pending request with a one-hour deadline.
- **When** A shell event updates it to a new request expiring in 250 milliseconds, with a different reason, and no further event occurs.
- **Then** The card shows the new reason and then reports “Request expired.” Allow and Deny are no longer available.

## desktop-shell-authorization-019

Original test `Approving a request arms the grant deadline and removes revoke when access expires`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/desktop-shell-authorization.test.tsx#L463).

- **Given** A chat card shows a pending Shell access request.
- **When** The user approves it and the resulting grant expires in 250 milliseconds.
- **Then** The card reports access allowed and then access expired. Neither Revoke nor Allow remains available.

## desktop-shell-authorization-020

Original test `A shell event expires its grant when the timer elapses before the wall-clock deadline sample`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/desktop-shell-authorization.test.tsx#L490).

- **Given** A chat card shows a pending request at a fixed time; its grant deadline is 250 milliseconds later.
- **When** A shell event reports an approved grant, then the timer fires while the application clock is still one millisecond short of that deadline.
- **Then** The card reports access expired and no longer offers Revoke.

## desktop-shell-authorization-021

Original test `A delayed approval event restores a later grant after the local request deadline elapsed`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/desktop-shell-authorization.test.tsx#L516).

- **Given** A chat card shows a request that expires one millisecond after a fixed time, and it first reports access expired.
- **When** A delayed shell event reports that it was approved before that expiry with a grant lasting one hour, after the clock has passed the request deadline.
- **Then** The card restores the grant, reports access allowed, enables Revoke, and no longer reports access expired.

## desktop-shell-authorization-022

Original test `A request for another chat stays unavailable in this transcript`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/desktop-shell-authorization.test.tsx#L552).

- **Given** A chat transcript contains a Shell authorization URL for a request belonging to a different chat.
- **When** The user views the transcript.
- **Then** The card reports Authorization unavailable and does not offer Allow.

## desktop-shell-authorization-023

Original test `An external URL with the same path remains an ordinary link`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/desktop-shell-authorization.test.tsx#L569).

- **Given** A chat message contains an external URL whose path matches the Shell authorization path.
- **When** The user views the message.
- **Then** The URL remains an ordinary link to the external site, and no Shell authorization card appears.

## desktop-shell-authorization-024

Original test `Shell approval resumes only with an explicit callback (false)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/desktop-shell-authorization.test.tsx#L581).

- **Given** A chat transcript contains a Shell authorization link without a callback prompt.
- **When** The user approves the request.
- **Then** The card shows Revoke, and no prompt is sent to the chat.

## desktop-shell-authorization-025

Original test `Shell approval resumes only with an explicit callback (true)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/desktop-shell-authorization.test.tsx#L581).

- **Given** A chat transcript contains a Shell authorization link with the current chat ID and a callback prompt.
- **When** The user approves the request.
- **Then** The card shows Revoke, and the callback prompt is sent to the chat exactly once.

## desktop-shell-authorization-026

Original test `A failed Shell callback can retry without extending the grant`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/desktop-shell-authorization.test.tsx#L615).

- **Given** A chat transcript contains a Shell authorization link with callback prompt “Continue.” The grant can be created only once, and the first callback send fails with a service-unavailable response.
- **When** The user approves, then retries after the card reports an authorization update failure.
- **Then** The retry succeeds and Revoke is enabled, but the grant was created only once. Both callback send attempts use the authorization ID as their client event ID.

## desktop-shell-authorization-027

Original test `The standalone Shell page honors the optional callback (false)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/desktop-shell-authorization.test.tsx#L651).

- **Given** The standalone Shell page has no callback prompt.
- **When** The user approves the request.
- **Then** Revoke becomes available, and no prompt is sent to the chat.

## desktop-shell-authorization-028

Original test `The standalone Shell page honors the optional callback (true)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/desktop-shell-authorization.test.tsx#L651).

- **Given** The standalone Shell page has callback prompt “Continue” and a chat ID.
- **When** The user approves the request.
- **Then** Revoke becomes available, and “Continue” is sent to the chat.
