# Discord connect page

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [discord-connect-page.test.tsx](discord-connect-page.test.tsx).

## discord-connect-page-001

Original test `An install link starts a new installation for an already connected user (approved: true)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/discord-connect-page.test.tsx#L40).

- **Given** The user is already connected to a different Discord server and opens an install link for the target server.
- **When** They choose “Join new server” and Discord approval succeeds.
- **Then** A new install starts for the target server, and the page reports “Connected to Discord.” The Discord callback receives a connected result, the popup remains open, and the page moves to the canonical Discord settings page with an Open Discord link to the target server.

## discord-connect-page-002

Original test `An install link starts a new installation for an already connected user (approved: false)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/discord-connect-page.test.tsx#L40).

- **Given** The user is already connected to a different Discord server and opens an install link for the target server.
- **When** They choose “Join new server” but Discord consent is not completed.
- **Then** A new install starts for the target server, and the page reports that Discord authorization could not be completed. The callback receives an error result, the popup remains open, and the page stays on the install page without an Open Discord link.

## discord-connect-page-003

Original test `The Discord bot link offers install directly and retains the target server`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/discord-connect-page.test.tsx#L129).

- **Given** The user opens Discord settings with a server hint and the current Discord status has no server attached.
- **When** They connect their Discord account and approve authorization.
- **Then** The connection starts directly for the hinted server, completes successfully, and the connected URL identifies the hinted server. An Open Discord link points to that server, and the authorization popup remains open.

## discord-connect-page-004

Original test `The Discord bot link offers connect directly and retains the target server`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/discord-connect-page.test.tsx#L129).

- **Given** The user opens Discord settings with a server hint matching the currently connected server.
- **When** They connect their Discord account and approve authorization.
- **Then** The connection starts directly for the hinted server, completes successfully, and the connected URL identifies that server. An Open Discord link points to it, and the authorization popup remains open.

## discord-connect-page-005

Original test `Discord consent finishes in place after the refreshed status is connected`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/discord-connect-page.test.tsx#L221).

- **Given** Discord consent is pending, and the status request made before completion reports an older connection to another server.
- **When** A connected completion arrives from the original window and the refreshed status reports connected.
- **Then** The page finishes in place with “Connected to Discord,” clears the consent fragment, and shows an Open Discord link for the target server.

## discord-connect-page-006

Original test `Discord consent finishes in place after the refreshed status is disconnected`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/discord-connect-page.test.tsx#L221).

- **Given** Discord consent is pending, and the status request made before completion reports an older connection to another server.
- **When** A connected completion arrives from the original window and the refreshed status reports disconnected.
- **Then** The page finishes in place with “Connect to Discord,” clears the consent fragment, and does not show an Open Discord link.

## discord-connect-page-007

Original test `Discord consent finishes in place after the refreshed status is error`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/discord-connect-page.test.tsx#L221).

- **Given** Discord consent is pending, and the status request made before completion reports an older connection to another server.
- **When** A connected completion arrives from the original window and the refreshed status request fails with 403 Forbidden.
- **Then** The page finishes in place with “Connection failed,” clears the consent fragment, and does not show an Open Discord link.

## discord-connect-page-008

Original test `Only the original window's same-origin connected result for this attempt can finish Discord consent`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/discord-connect-page.test.tsx#L309).

- **Given** The user is waiting for Discord consent completion for a specific attempt in the original window.
- **When** A connected result arrives from an untrusted origin, another window, a different attempt, or with an unknown status, followed by a valid connected result from the original window at the same origin for the attempt.
- **Then** The invalid results do not finish consent or change the pending status. Only the valid result finishes consent and shows “Connected to Discord.”

## discord-connect-page-009

Original test `Only the original window's same-origin error result for this attempt can finish Discord consent`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/discord-connect-page.test.tsx#L309).

- **Given** The user is waiting for Discord consent completion for a specific attempt in the original window.
- **When** An error result arrives from an untrusted origin, another window, a different attempt, or with an unknown status, followed by a valid error result from the original window at the same origin for the attempt.
- **Then** The invalid results do not finish consent or change the pending status. Only the valid result finishes consent and shows “Connection failed.”

## discord-connect-page-010

Original test `A terminal connected result renders before an in-flight approval response (200) and remains final`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/discord-connect-page.test.tsx#L378).

- **Given** Discord consent is pending while the approval request has not yet returned.
- **When** A connected completion arrives, then the approval request succeeds with status 200 and a later conflicting error result arrives.
- **Then** “Connected to Discord” appears before the approval response and remains final. The status stays connected, the Connect button remains absent, and the loading skeleton stays hidden.

## discord-connect-page-011

Original test `A terminal connected result renders before an in-flight approval response (403) and remains final`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/discord-connect-page.test.tsx#L378).

- **Given** Discord consent is pending while the approval request has not yet returned.
- **When** A connected completion arrives, then the approval request fails with status 403 and a later conflicting error result arrives.
- **Then** “Connected to Discord” appears before the approval response and remains final. The status stays connected, the Connect button remains absent, and the loading skeleton stays hidden.

## discord-connect-page-012

Original test `A terminal error result renders before an in-flight approval response (200) and remains final`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/discord-connect-page.test.tsx#L378).

- **Given** Discord consent is pending while the approval request has not yet returned.
- **When** An error completion arrives, then the approval request succeeds with status 200 and a later conflicting connected result arrives.
- **Then** “Connection failed” appears before the approval response and remains final. The status stays error, the Connect button remains absent, and the loading skeleton stays hidden.

## discord-connect-page-013

Original test `A terminal error result renders before an in-flight approval response (403) and remains final`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/discord-connect-page.test.tsx#L378).

- **Given** Discord consent is pending while the approval request has not yet returned.
- **When** An error completion arrives, then the approval request fails with status 403 and a later conflicting connected result arrives.
- **Then** “Connection failed” appears before the approval response and remains final. The status stays error, the Connect button remains absent, and the loading skeleton stays hidden.

## discord-connect-page-014

Original test `The Discord success URL uses verified connection data (connected: false)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/discord-connect-page.test.tsx#L443).

- **Given** The page URL claims Discord is connected and includes an unverified workspace name, but the status request says the account is disconnected.
- **When** The Discord settings page loads.
- **Then** The unverified workspace name is not shown, the page says “Connect to Discord,” and a Connect button is available without an Open Discord link.

## discord-connect-page-015

Original test `The Discord success URL uses verified connection data (connected: true)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/discord-connect-page.test.tsx#L443).

- **Given** The page URL claims Discord is connected and includes an unverified workspace name, and the status request confirms the account is connected.
- **When** The Discord settings page loads.
- **Then** The unverified workspace name is not shown, the page says “Connected to Discord,” and an Open Discord link targets the verified server.

## discord-connect-page-016

Original test `A blocked Discord popup keeps authorization incomplete`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/discord-connect-page.test.tsx#L469).

- **Given** The user is on Discord settings and the browser blocks opening the authorization popup.
- **When** They choose Connect.
- **Then** An alert says the Discord authorization popup was blocked, and no Open Discord link is shown.

## discord-connect-page-017

Original test `Closing Discord consent shows cancellation without failure capture`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/discord-connect-page.test.tsx#L485).

- **Given** The user has started Discord authorization in a popup, but consent has not been approved.
- **When** They close the consent popup.
- **Then** An alert says Discord authorization was cancelled. No Open Discord link or connected status appears, the consent failure message is not shown, and no Sentry report is captured.

## discord-connect-page-018

Original test `Closing consent does not hide a real 409 CONFLICT completion failure on the canonical page`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/discord-connect-page.test.tsx#L540).

- **Given** The user has started Discord authorization, completion is in progress, and the consent popup is closed before the completion response returns.
- **When** Completion fails with HTTP 409 and code CONFLICT.
- **Then** The page reports that Discord authorization could not be completed and shows the verification failure message. No Open Discord link or connected status appears, and the failure is captured as an unexpected exception.

## discord-connect-page-019

Original test `Closing consent does not hide a real 403 FORBIDDEN completion failure on the canonical page`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/discord-connect-page.test.tsx#L540).

- **Given** The user has started Discord authorization, completion is in progress, and the consent popup is closed before the completion response returns.
- **When** Completion fails with HTTP 403 and code FORBIDDEN.
- **Then** The page reports that Discord authorization could not be completed and shows the verification failure message. No Open Discord link or connected status appears, and the failure is captured as an unexpected exception.

## discord-connect-page-020

Original test `Closing consent does not hide a real 400 DISCORD_OAUTH_FAILED completion failure on the canonical page`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/discord-connect-page.test.tsx#L540).

- **Given** The user has started Discord authorization, completion is in progress, and the consent popup is closed before the completion response returns.
- **When** Completion fails with HTTP 400 and code DISCORD_OAUTH_FAILED.
- **Then** The page reports that Discord authorization could not be completed and shows the verification failure message. No Open Discord link or connected status appears, and the failure is captured as an unexpected exception.

## discord-connect-page-021

Original test `Closing consent does not hide a real 503 DISCORD_OAUTH_APPROVAL_REQUIRED completion failure on the canonical page`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/discord-connect-page.test.tsx#L540).

- **Given** The user has started Discord authorization, completion is in progress, and the consent popup is closed before the completion response returns.
- **When** Completion fails with HTTP 503 and code DISCORD_OAUTH_APPROVAL_REQUIRED.
- **Then** The page reports that Discord authorization could not be completed and shows the verification failure message. No Open Discord link or connected status appears, and the failure is captured as an unexpected exception.

## discord-connect-page-022

Original test `A Discord DM link can connect without a server hint`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/discord-connect-page.test.tsx#L596).

- **Given** The user opens Discord settings without a server hint and the status request succeeds.
- **When** The settings page loads.
- **Then** The Connect button is enabled.

## discord-connect-page-023

Original test `A failed Discord status request exposes the error page and its back link`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/discord-connect-page.test.tsx#L607).

- **Given** The Discord status request fails with 403 Forbidden.
- **When** The user opens Discord settings.
- **Then** The page shows “Connection failed” and a Back to settings link to /works. No Connect button is shown.

## discord-connect-page-024

Original test `A server link is independent of the workspace's previous server`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/discord-connect-page.test.tsx#L629).

- **Given** The user's current Discord status names a different server and says they are not an administrator there.
- **When** They open Discord settings with a server link for another server.
- **Then** The Connect button is enabled.

## discord-connect-page-025

Original test `A malformed server link cannot start consent`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/discord-connect-page.test.tsx#L643).

- **Given** The user opens Discord settings with a malformed server identifier.
- **When** The page loads.
- **Then** The page says the connection link is invalid and to open a new link from Discord. No Connect button is shown.

## discord-connect-page-026

Original test `A Discord connection link requires sign-in and preserves its server`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/discord-connect-page.test.tsx#L659).

- **Given** The user is signed out and opens a Discord connection link containing a server identifier.
- **When** The page redirects them to sign in.
- **Then** The sign-in redirect URL preserves the Discord connection link, including its server identifier.
