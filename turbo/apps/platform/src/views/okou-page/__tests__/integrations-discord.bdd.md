# Integrations discord

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [integrations-discord.test.tsx](integrations-discord.test.tsx).

## integrations-discord-001

Original test `Discord explains setup to a unconfigured admin`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/integrations-discord.test.tsx#L89).

- **Given** An administrator’s organization has not configured Discord, so Discord is unavailable.
- **When** The administrator opens Works.
- **Then** The Discord card says it is not configured yet and offers no Connect, Install to Discord, or More options action.

## integrations-discord-002

Original test `Discord explains setup to a configured admin without a server`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/integrations-discord.test.tsx#L89).

- **Given** An administrator’s organization has Discord configured, but has no verified connection or server.
- **When** The administrator opens Works.
- **Then** The Discord card prompts them to mention Okou in a server or send the bot a direct message, and offers an enabled Connect action but no More options action.

## integrations-discord-003

Original test `Discord explains setup to a member without a server`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/integrations-discord.test.tsx#L89).

- **Given** A member has no verified Discord connection or server.
- **When** The member opens Works.
- **Then** The Discord card prompts them to mention Okou in a server or send the bot a direct message, and offers an enabled Connect action but no More options action.

## integrations-discord-004

Original test `Discord explains setup to a member without a verified connection`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/integrations-discord.test.tsx#L89).

- **Given** A member has Discord server details but no verified connection.
- **When** The member opens Works.
- **Then** The Discord card prompts them to mention Okou in a server or send the bot a direct message, and offers an enabled Connect action but no More options action.

## integrations-discord-005

Original test `Discord updates Works and notifies the separate authorization tab of success (admin: true)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/integrations-discord.test.tsx#L149).

- **Given** An administrator has started Discord authorization, and the Discord consent is awaiting approval in a separate tab.
- **When** The consent tab becomes ready and approval succeeds.
- **Then** Works shows the Discord connection as Connected, offers More options, and remains at /works without a query string. The separate tab stays open at the authorization URL and receives a connected result for this attempt.

## integrations-discord-006

Original test `Discord updates Works and notifies the separate authorization tab of success (admin: false)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/integrations-discord.test.tsx#L149).

- **Given** A member has started Discord authorization, and the Discord consent is awaiting approval in a separate tab.
- **When** The consent tab becomes ready and approval succeeds.
- **Then** Works shows the Discord connection as Connected, offers More options, and remains at /works without a query string. The separate tab stays open at the authorization URL and receives a connected result for this attempt.

## integrations-discord-007

Original test `Discord starts at the canonical API host from app.okou.ai, not an App proxy or web host`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/integrations-discord.test.tsx#L279).

- **Given** A user on app.okou.ai has an unconnected Discord account.
- **When** The user starts authorization and completes consent successfully.
- **Then** Discord authorization starts and completes through https://api.okou.ai, and the consent callback targets that canonical API host rather than an App proxy or web host. The authorization tab receives the successful result for the app.okou.ai origin and stays open.

## integrations-discord-008

Original test `Discord starts at the canonical API host from pr-37968-app.omby.ai, not an App proxy or web host`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/integrations-discord.test.tsx#L279).

- **Given** A user on pr-37968-app.omby.ai has an unconnected Discord account.
- **When** The user starts authorization and completes consent successfully.
- **Then** Discord authorization starts and completes through https://pr-37968-api.vm6.ai, and the consent callback targets that canonical API host rather than an App proxy or web host. The authorization tab receives the successful result for the app host origin and stays open.

## integrations-discord-009

Original test `Discord starts at the canonical API host from pr-37968-app-okou-app-preview.vm0.worke…, not an App proxy or web host`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/integrations-discord.test.tsx#L279).

- **Given** A user on pr-37968-app-okou-app-preview.vm0.workers.dev has an unconnected Discord account.
- **When** The user starts authorization and completes consent successfully.
- **Then** Discord authorization starts and completes through https://pr-37968-api.vm6.ai, and the consent callback targets that canonical API host rather than an App proxy or web host. The authorization tab receives the successful result for the app host origin and stays open.

## integrations-discord-010

Original test `A failed authorization start closes its tab, reports the error, without claiming success`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/integrations-discord.test.tsx#L350).

- **Given** A user has an unconnected Discord account and starts Discord authorization.
- **When** The authorization-start service returns a 503 error saying Discord OAuth is not configured.
- **Then** The authorization tab closes, the error is shown, Connect becomes enabled again, and the card does not show Connected.

## integrations-discord-011

Original test `Blocked popups explain recovery without same-window fallback (standalone: false)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/integrations-discord.test.tsx#L382).

- **Given** A user with an unconnected Discord account has popups blocked, and the app is not in standalone display mode.
- **When** The user selects Connect.
- **Then** The app explains that the Discord authorization popup was blocked and Connect remains enabled; it does not fall back to same-window navigation.

## integrations-discord-012

Original test `Blocked popups explain recovery without same-window fallback (standalone: true)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/integrations-discord.test.tsx#L382).

- **Given** A user with an unconnected Discord account has popups blocked, and the app is in standalone display mode.
- **When** The user selects Connect.
- **Then** The app explains that the Discord authorization popup was blocked and Connect remains enabled; it does not fall back to same-window navigation.

## integrations-discord-013

Original test `Leaving Works after consent opens cancels the retained opener proof without completing`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/integrations-discord.test.tsx#L406).

- **Given** A user has started Discord authorization and the consent tab has opened, but approval is still pending.
- **When** The user leaves Works for Chat and later returns to Works.
- **Then** The consent tab closes without completing authorization. The Discord setup prompt is shown again and Connect is enabled.

## integrations-discord-014

Original test `Leaving Works aborts an in-flight authenticated completion request`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/integrations-discord.test.tsx#L454).

- **Given** A user has started Discord authorization and the authenticated completion request is in flight.
- **When** The user leaves Works for Chat.
- **Then** The completion request is aborted, the authorization tab closes, and the Discord integration is no longer displayed on the Chat page.

## integrations-discord-015

Original test `Leaving Works cancels a pending authorization request and closes its blank tab`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/integrations-discord.test.tsx#L497).

- **Given** A user has started Discord authorization, and its authorization-start request is still pending with a blank tab open.
- **When** The user leaves Works for Chat.
- **Then** The blank authorization tab closes and the Discord integration is no longer displayed on the Chat page.

## integrations-discord-016

Original test `A Discord callback indicator connected is not proof of a verified connection`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/integrations-discord.test.tsx#L529).

- **Given** A user opens a Discord callback URL marked connected, but the account status says there is no verified connection.
- **When** The callback page loads.
- **Then** The user is taken to /settings/discord with status=connected and sees the Connect to Discord heading. No Connect action, Open Discord link, provider error detail, or completion request appears.

## integrations-discord-017

Original test `A Discord callback indicator pending is not proof of a verified connection`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/integrations-discord.test.tsx#L529).

- **Given** A user opens a Discord callback URL marked pending, but the account status says there is no verified connection.
- **When** The callback page loads.
- **Then** The user is taken to /settings/discord with status=pending and sees the Connection failed heading. No Connect action, Open Discord link, provider error detail, or completion request appears.

## integrations-discord-018

Original test `A Discord callback indicator error is not proof of a verified connection`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/integrations-discord.test.tsx#L529).

- **Given** A user opens a Discord callback URL marked error, but the account status says there is no verified connection.
- **When** The callback page loads.
- **Then** The user is taken to /settings/discord with status=error and sees the Connection failed heading and a generic authorization-completion error, not the provider detail. No Connect action, Open Discord link, or completion request appears.

## integrations-discord-019

Original test `Consent browser at /works?discord=pending verifies the current account and stays open while completion is pending`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/integrations-discord.test.tsx#L573).

- **Given** A consent browser opens at /works?discord=pending with a valid approval fragment, an opener, and an account that is not yet connected.
- **When** The consent browser verifies the account and the approval request succeeds.
- **Then** The fragment is cleared, the page says it is verifying the connection, and it does not close or show Open Discord while completion is pending.

## integrations-discord-020

Original test `Consent browser at /settings/discord?status=pending verifies the current account and stays open while completion is pending`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/integrations-discord.test.tsx#L573).

- **Given** A consent browser opens at /settings/discord?status=pending with a valid approval fragment, an opener, and an account that is not yet connected.
- **When** The consent browser verifies the account and the approval request succeeds.
- **Then** The fragment is cleared, the page says it is verifying the connection, and it does not close or show Open Discord while completion is pending.

## integrations-discord-021

Original test `Malformed approval fragment is cleared and cannot authorize from callback markers`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/integrations-discord.test.tsx#L620).

- **Given** A user opens a pending Discord callback with a valid state but an empty approval proof in the fragment.
- **When** The page processes the malformed approval fragment.
- **Then** The fragment is cleared, the interrupted-or-refreshed message appears, no Open Discord link appears, and no approval request is made.

## integrations-discord-022

Original test `Malformed approval fragment invalid-proof is cleared and cannot authorize from callback markers`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/integrations-discord.test.tsx#L620).

- **Given** A user opens a pending Discord callback with a valid state but an invalid-proof approval fragment.
- **When** The page processes the malformed approval fragment.
- **Then** The fragment is cleared, the interrupted-or-refreshed message appears, no Open Discord link appears, and no approval request is made.

## integrations-discord-023

Original test `A rejected consent-browser owner or proof shows restart guidance without connected state`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/integrations-discord.test.tsx#L644).

- **Given** A consent browser has an opener, but Discord rejects its approval owner or proof.
- **When** The user submits the approval proof.
- **Then** The page shows Connection failed and guidance to sign in with the original Okou account and organization or restart authorization. It does not show connected state or Open Discord, and the consent browser does not close.

## integrations-discord-024

Original test `Leaving the consent route cancels automatic verification and destroys its proof`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/integrations-discord.test.tsx#L674).

- **Given** A consent browser is automatically verifying a valid approval proof while its approval request is pending.
- **When** The user leaves the consent route by selecting Back to settings.
- **Then** The approval request is aborted, the Works page shows the Discord setup prompt, and later connected or error messages from the old consent attempt do not alter the page. The approval proof is not reused for another approval request, and the browser does not close.

## integrations-discord-025

Original test `Unapproved popup closure shows cancellation without failure capture`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/integrations-discord.test.tsx#L735).

- **Given** A user has started Discord authorization, but has not approved it.
- **When** The user closes the authorization popup.
- **Then** The app reports that Discord authorization was cancelled, keeps the connection absent and Connect enabled, and does not display the approval-required error or change the Works URL. No failure is reported to Sentry.

## integrations-discord-026

Original test `A terminal completion error CONFLICT shows the result in the authorization tab`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/integrations-discord.test.tsx#L783).

- **Given** A user has started Discord authorization, and the completion service returns CONFLICT with “Discord could not complete authorization.”
- **When** The completion attempt fails and the matching consent tab announces readiness.
- **Then** The error appears in Works, Connect is re-enabled, the connection remains absent, and the authorization tab receives one error result for this attempt while staying open. Sentry records the expected CONFLICT response with status 409.

## integrations-discord-027

Original test `A terminal completion error DISCORD_OAUTH_FAILED shows the result in the authorization tab`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/integrations-discord.test.tsx#L783).

- **Given** A user has started Discord authorization, and the completion service returns DISCORD_OAUTH_FAILED with “Discord could not complete authorization.”
- **When** The completion attempt fails and the matching consent tab announces readiness.
- **Then** The error appears in Works, Connect is re-enabled, the connection remains absent, and the authorization tab receives one error result for this attempt while staying open. Sentry records the expected DISCORD_OAUTH_FAILED response with status 400.

## integrations-discord-028

Original test `A terminal completion error DISCORD_OAUTH_UNAVAILABLE shows the result in the authorization tab`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/integrations-discord.test.tsx#L783).

- **Given** A user has started Discord authorization, and the completion service returns DISCORD_OAUTH_UNAVAILABLE with “Discord could not complete authorization.”
- **When** The completion attempt fails and the matching consent tab announces readiness.
- **Then** The error appears in Works, Connect is re-enabled, the connection remains absent, and the authorization tab receives one error result for this attempt while staying open. Sentry records the expected DISCORD_OAUTH_UNAVAILABLE response with status 503.

## integrations-discord-029

Original test `A terminal completion error FORBIDDEN shows the result in the authorization tab`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/integrations-discord.test.tsx#L783).

- **Given** A user has started Discord authorization, and the completion service returns FORBIDDEN with “Discord could not complete authorization.”
- **When** The completion attempt fails and the matching consent tab announces readiness.
- **Then** The error appears in Works, Connect is re-enabled, the connection remains absent, and the authorization tab receives one error result for this attempt while staying open. Sentry records the expected FORBIDDEN response with status 403.

## integrations-discord-030

Original test `A terminal completion error DISCORD_OAUTH_APPROVAL_REQUIRED shows the result in the authorization tab`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/integrations-discord.test.tsx#L783).

- **Given** A user has started Discord authorization, and the completion service returns DISCORD_OAUTH_APPROVAL_REQUIRED with “Discord could not complete authorization.”
- **When** The completion attempt fails and the matching consent tab announces readiness.
- **Then** The error appears in Works, Connect is re-enabled, the connection remains absent, and the authorization tab receives one error result for this attempt while staying open. Sentry records the expected DISCORD_OAUTH_APPROVAL_REQUIRED response with status 503.

## integrations-discord-031

Original test `A connected member disconnects from the overflow menu on Works`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/integrations-discord.test.tsx#L839).

- **Given** A connected Discord member is viewing Works.
- **When** The member opens More options and selects Disconnect Discord.
- **Then** The connection is removed, Connect becomes enabled, and More options and Disconnect Discord are no longer available.

## integrations-discord-032

Original test `A failed disconnect preserves the connection`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/integrations-discord.test.tsx#L869).

- **Given** A connected Discord user is viewing Works.
- **When** The user selects Disconnect Discord and the service rejects the request with FORBIDDEN.
- **Then** The error “Discord disconnect denied” appears and the Discord connection remains displayed as Connected.

## integrations-discord-033

Original test `A connected admin can open and dismiss their account menu with the keyboard`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/integrations-discord.test.tsx#L892).

- **Given** A connected Discord administrator is viewing Works.
- **When** The administrator opens the account menu with the keyboard, dismisses it with Escape, then opens it again with Enter.
- **Then** The menu offers enabled Join new server and Disconnect Discord actions, but no Uninstall action. Escape closes the menu and returns focus to More options; Enter opens the menu again.

## integrations-discord-034

Original test `Joining a server from the shared Works menu retains the connection (approved: true)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/integrations-discord.test.tsx#L915).

- **Given** A connected Discord user opens the shared Works menu and starts joining a new server; approval later succeeds.
- **When** The user selects Join new server and completes the consent flow.
- **Then** The authorization starts with the install flow, Join new server and Disconnect Discord are disabled while approval is pending, and the existing connection remains visible. On success both actions are enabled, the popup stays open and receives a connected result, Works stays at /works without a query string, and the connection remains visible.

## integrations-discord-035

Original test `Joining a server from the shared Works menu retains the connection (approved: false)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/integrations-discord.test.tsx#L915).

- **Given** A connected Discord user opens the shared Works menu and starts joining a new server; approval later fails with “Consent was not completed.”
- **When** The user selects Join new server and completes the consent flow.
- **Then** The authorization starts with the install flow, Join new server and Disconnect Discord are disabled while approval is pending, and the existing connection remains visible. On failure both actions are enabled, the popup stays open and receives an error result, the consent error appears, Works stays at /works without a query string, and the existing connection remains visible.

## integrations-discord-036

Original test `Discord status converges after a connection change from another surface`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/integrations-discord.test.tsx#L985).

- **Given** The Discord integration is disconnected and the user is an admin. Another surface changes its status to connected with the team name “Updated team,” then changes it back to disconnected.
- **When** A Discord status-change event is received for each change.
- **Then** The card first shows Connected, then offers Connect and no longer shows More options.

## integrations-discord-037

Original test `Returning to Works preserves Discord status while refreshing (connected: false)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/integrations-discord.test.tsx#L1031).

- **Given** Discord is disconnected, and the user leaves Works for Chat while Discord status refresh is pending.
- **When** The user returns to Works before the refresh completes.
- **Then** The Discord card continues to show its description and an enabled Connect button; after refresh it shows Connected.

## integrations-discord-038

Original test `Returning to Works preserves Discord status while refreshing (connected: true)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/integrations-discord.test.tsx#L1031).

- **Given** Discord is connected, and the user leaves Works for Chat while Discord status refresh is pending.
- **When** The user returns to Works before the refresh completes.
- **Then** The Discord card continues to show its description and Connected status; after refresh it still shows Connected.

## integrations-discord-039

Original test `Works keeps its startup screen until Discord and Slack status are ready`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/integrations-discord.test.tsx#L1087).

- **Given** Slack is connected to “Okou HQ,” while the Discord status request is still pending.
- **When** The user opens Works.
- **Then** The Slack connection and Discord card description are visible, but the startup screen remains visible and the app root is inert with no Discord buttons. Once Discord status becomes ready, the startup screen hides and the app root is no longer inert.

## integrations-discord-040

Original test `A status error hides stale controls and recovers when returning to Works`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/integrations-discord.test.tsx#L1127).

- **Given** Discord initially shows Connected, then a status refresh is denied with a 403 error.
- **When** The user returns to Works after leaving for Chat, once status access is available again.
- **Then** During the error, the card shows “Discord access denied” and its description, with no buttons or stale Connected status. On returning, it shows Connected again.

## integrations-discord-041

Original test `Direct messages require an explicit workspace choice and a failed save keeps the prior choice`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/integrations-discord.test.tsx#L1178).

- **Given** Discord has two direct-message workspace bindings, “Design team” and “Operations,” and no default workspace is selected. Saving a selection initially fails with a 403 error.
- **When** The user chooses Operations, then retries after the failure and another surface changes the selected workspace to Design team.
- **Then** The failed save leaves the choice at “Choose a workspace.” The retry selects Operations, and the later status change updates the selection to Design team.

## integrations-discord-042

Original test `A pending DM choice remains disabled through a successful refresh`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/integrations-discord.test.tsx#L1261).

- **Given** The default Discord direct-message workspace is Design team, and a save of Operations is pending while a status refresh succeeds.
- **When** The user selects Operations and a Discord status-change event triggers the refresh.
- **Then** The workspace selector remains disabled throughout the refresh and shows Design team; Design team is not offered as an option while disabled. After the save completes, the selector is enabled and shows Operations.

## integrations-discord-043

Original test `A pending DM choice remains disabled through a failed refresh and recovery`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/integrations-discord.test.tsx#L1261).

- **Given** The default Discord direct-message workspace is Design team, and a save of Operations is pending while a status refresh is denied with a 403 error.
- **When** The user selects Operations and a Discord status-change event triggers the failed refresh, followed by a recovery refresh.
- **Then** The selector remains disabled throughout the failed refresh and recovery, showing Design team with no Design team option available. After the save completes, it is enabled and shows Operations.

## integrations-discord-044

Original test `A missing bot configuration shows one unavailable state to an installed admin`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/integrations-discord.test.tsx#L1380).

- **Given** An admin views an installed Discord integration that is connected, but Discord is unavailable and has no bot configuration.
- **When** The integrations page loads.
- **Then** One unavailable message says existing connections are kept. The card shows Connected and its More options menu offers Disconnect Discord, but no Disconnect Discord button appears outside the menu. Join new server is not offered.

## integrations-discord-045

Original test `A missing bot configuration shows one unavailable state to an installed connected member`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/integrations-discord.test.tsx#L1380).

- **Given** A connected member who is not an admin views an installed Discord integration, but Discord is unavailable and has no bot configuration.
- **When** The integrations page loads.
- **Then** One unavailable message says existing connections are kept. The card shows Connected and its More options menu offers Disconnect Discord, but no Disconnect Discord button appears outside the menu. Join new server is not offered.

## integrations-discord-046

Original test `A missing bot configuration shows one unavailable state to an installed member without a connection`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/integrations-discord.test.tsx#L1380).

- **Given** A member without a Discord connection views an installed integration that is unavailable and has no bot configuration.
- **When** The integrations page loads.
- **Then** One message says Discord is not configured for the organization yet. The card does not show Connected or a More options menu, and no Disconnect Discord or Join new server action is offered.

## integrations-discord-047

Original test `Saving a Discord workspace stays pending until the refreshed choice arrives`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/integrations-discord.test.tsx#L1423).

- **Given** The Discord integration has two available workspaces, Design team and Operations, with Design team selected as the default.
- **When** The user selects Operations as the default workspace.
- **Then** The workspace choice remains disabled while refreshed status is pending. After refreshed status arrives, the choice is enabled and displays Operations.

## integrations-discord-048

Original test `Disconnecting stays pending until the refreshed status arrives`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/integrations-discord.test.tsx#L1488).

- **Given** The user is connected to Discord.
- **When** The user chooses Disconnect Discord.
- **Then** While refreshed status is pending, the disconnect action is disabled and says Disconnecting…. After refreshed status arrives, the Connect action is enabled and the card no longer shows Connected.
