# Telegram oauth connect

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [telegram-oauth-connect.test.tsx](telegram-oauth-connect.test.tsx).

## telegram-oauth-connect-001

Original test `Works refreshes Telegram connections in realtime and disconnects the displayed account`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/telegram-oauth-connect.test.tsx#L130).

- **Given** A user is on Works with Telegram initially unconnected.
- **When** A realtime Telegram status update connects an account, then the user chooses Disconnect from the displayed account's options.
- **Then** Works shows the connected Telegram username and removes Connect while connected. After disconnecting, it confirms the account was disconnected, restores enabled Connect, removes the connected label, and stays on Works.

## telegram-oauth-connect-002

Original test `Works disables Telegram Connect when the official bot is not configured`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/telegram-oauth-connect.test.tsx#L160).

- **Given** A user is on Works and the official Telegram bot is not configured.
- **When** The integration status loads.
- **Then** The page explains that official bot configuration is missing and disables Connect, while the Slack integration remains visible.

## telegram-oauth-connect-003

Original test `The official bot connects from its new OAuth tab and ignores other windows and origins`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/telegram-oauth-connect.test.tsx#L185).

- **Given** A user is on Works with the official Telegram bot configured and opens a new authorization tab.
- **When** The authorization tab returns an identity, after unrelated-window and untrusted-origin results are sent.
- **Then** The authorization opens from a blank tab and requests write access for the configured bot. Only the result from the opened Telegram authorization tab is accepted; the connected username and success message appear, Connect disappears, and the user remains on Works.

## telegram-oauth-connect-004

Original test `A blocked authorization tab shows an error and leaves Connect available`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/telegram-oauth-connect.test.tsx#L239).

- **Given** A user is on Works with Telegram configured, but the browser cannot open an authorization tab.
- **When** The user selects Connect.
- **Then** An error explains that the authorization window could not be opened, Connect remains enabled, and the user stays on Works.

## telegram-oauth-connect-005

Original test `Connect explains an unverified domain reported by an old… without opening a middle page`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/telegram-oauth-connect.test.tsx#L317).

- **Given** A user starts Connect on Works and the older status response reports an unverified Telegram login domain.
- **When** The readiness check fails.
- **Then** The app explains that Telegram login could not be verified and advises contacting support if the problem continues. The authorization tab closes, Connect is restored, no error is reported to Sentry, and no intermediate page is opened.

## telegram-oauth-connect-006

Original test `Connect explains a bot whose installation is no longer a… without opening a middle page`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/telegram-oauth-connect.test.tsx#L317).

- **Given** A user starts Connect on Works and the status response says the bot installation is no longer available.
- **When** The readiness check fails.
- **Then** The app says the Telegram connection is not configured and advises contacting support. The authorization tab closes, Connect is restored, no error is reported to Sentry, and no intermediate page is opened.

## telegram-oauth-connect-007

Original test `Connect explains a missing bot configuration without opening a middle page`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/telegram-oauth-connect.test.tsx#L317).

- **Given** A user starts Connect on Works and the status response reports missing bot configuration.
- **When** The readiness check fails.
- **Then** The app says the Telegram connection is not configured and advises contacting support. The authorization tab closes, Connect is restored, no error is reported to Sentry, and no intermediate page is opened.

## telegram-oauth-connect-008

Original test `Connect explains an unsuccessful Telegram domain verific… without opening a middle page`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/telegram-oauth-connect.test.tsx#L317).

- **Given** A user starts Connect on Works and the status response reports unsuccessful Telegram domain verification.
- **When** The readiness check fails.
- **Then** The app explains that Telegram login could not be verified and advises contacting support if the problem continues. The authorization tab closes, Connect is restored, no error is reported to Sentry, and no intermediate page is opened.

## telegram-oauth-connect-009

Original test `Connect explains an unreachable Telegram authorization s… without opening a middle page`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/telegram-oauth-connect.test.tsx#L317).

- **Given** A user starts Connect on Works and the status response says the Telegram authorization service is unreachable.
- **When** The readiness check fails.
- **Then** The app explains that it could not reach Telegram to check the connection. The authorization tab closes, Connect is restored, no error is reported to Sentry, and no intermediate page is opened.

## telegram-oauth-connect-010

Original test `The official connect page at /telegram/connect reports unavailable login configuration`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/telegram-oauth-connect.test.tsx#L336).

- **Given** A user opens /telegram/connect with the official bot selected, but Telegram login is not configured for the app.
- **When** The page loads.
- **Then** A Connection failed page explains that Telegram login could not be verified and advises contacting support. Back to settings links to Works, and Continue with Telegram is absent.

## telegram-oauth-connect-011

Original test `The official connect page at /settings/telegram reports unavailable login configuration`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/telegram-oauth-connect.test.tsx#L336).

- **Given** A user opens /settings/telegram with the official bot selected, but Telegram login is not configured for the app.
- **When** The page loads.
- **Then** A Connection failed page explains that Telegram login could not be verified and advises contacting support. Back to settings links to Works, and Continue with Telegram is absent.

## telegram-oauth-connect-012

Original test `Closing the OAuth tab cancels the attempt and restores Connect`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/telegram-oauth-connect.test.tsx#L371).

- **Given** A user starts Telegram authorization from Works and the authorization tab opens.
- **When** The user closes the authorization tab before completing the attempt.
- **Then** The attempt is cancelled, Connect becomes available again, no success message appears, and the user remains on Works.

## telegram-oauth-connect-013

Original test `Leaving Works cancels authorization and ignores a later tab result`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/telegram-oauth-connect.test.tsx#L391).

- **Given** A user starts Telegram authorization from Works and the authorization tab opens.
- **When** The user navigates to Agents, a result later arrives from the still-open authorization tab, and the user returns to Works.
- **Then** The late result does not connect Telegram. Works is shown again with Connect enabled.

## telegram-oauth-connect-014

Original test `Works refreshes after the Telegram subscription attaches past its first status read`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/telegram-oauth-connect.test.tsx#L421).

- **Given** A user opens Works while the Telegram realtime subscription has not yet attached, and the initial status read is unconnected.
- **When** The subscription attaches after a status update reports the account connected.
- **Then** Works refreshes to show the connected Telegram username and remains on Works.
