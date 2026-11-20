# Teams connect page

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [teams-connect-page.test.tsx](teams-connect-page.test.tsx).

## teams-connect-page-001

Original test `Every bare entry reads actual status`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/teams-connect-page.test.tsx#L62).

- **Given** A user opens the Teams settings return route with a bare status marker, and the actual status says a linked Teams account is connected.
- **When** The page reads the actual status.
- **Then** It shows the connected state and opens Teams only through the “Open Teams” link; the supplied marker does not launch a window or override displayed account details.

## teams-connect-page-002

Original test `Every connected entry reads actual status`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/teams-connect-page.test.tsx#L62).

- **Given** A user opens the Teams settings return route with a connected status marker, and the actual status says a linked Teams account is connected.
- **When** The page reads the actual status.
- **Then** It shows the connected state and opens Teams only through the “Open Teams” link; the supplied marker does not launch a window or override displayed account details.

## teams-connect-page-003

Original test `Every error entry reads actual status`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/teams-connect-page.test.tsx#L62).

- **Given** A user opens the Teams settings return route with an error status marker and error text, while actual status says a linked Teams account is connected.
- **When** The page reads the actual status.
- **Then** It shows the connected state, displays the supplied error text once, ignores forged team and bot names, and does not launch a window automatically; “Open Teams” targets Microsoft Teams.

## teams-connect-page-004

Original test `A forged success marker cannot connect an account or launch Teams`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/teams-connect-page.test.tsx#L96).

- **Given** A user opens the Teams settings return route with a forged connected marker, but actual status says no account is connected.
- **When** The page loads the actual status.
- **Then** It shows the connect state and an enabled authorization action; it does not launch a Teams window.

## teams-connect-page-005

Original test `A connected boolean cannot certify another Teams user`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/teams-connect-page.test.tsx#L126).

- **Given** The requested Teams account context names a different Teams user from the linked account, while status claims connected.
- **When** The user opens the connection page.
- **Then** The page remains in the connect state and reports that the account context does not match.

## teams-connect-page-006

Original test `A connected boolean cannot certify contradictory AAD pair`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/teams-connect-page.test.tsx#L126).

- **Given** The requested Teams account context has a different AAD object ID from the linked account, while status claims connected.
- **When** The user opens the connection page.
- **Then** The page remains in the connect state and reports that the account context does not match.

## teams-connect-page-007

Original test `A connected boolean cannot certify another tenant`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/teams-connect-page.test.tsx#L126).

- **Given** The requested Teams account context names a different tenant from the linked account, while status claims connected.
- **When** The user opens the connection page.
- **Then** The page remains in the connect state and reports that the account context does not match.

## teams-connect-page-008

Original test `Bare setup opts in without treating a blocked window as connection or cancellation`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/teams-connect-page.test.tsx#L140).

- **Given** A user opens Teams setup with a prompt parameter, while actual status says installation has not started.
- **When** They choose to authorize Microsoft Teams, but the browser window is blocked.
- **Then** The opened URL retains the prompt value “Keep my draft”; the page remains in the connect state with authorization enabled and does not treat the blocked window as connection or cancellation.

## teams-connect-page-009

Original test `Prepared installation stays pending and reconciles on visibility return`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/teams-connect-page.test.tsx#L157).

- **Given** A Teams installation is pending for a linked account, and setup provides an installation link.
- **When** The user leaves the page hidden, the account becomes connected, and the page becomes visible again.
- **Then** The page initially shows installation pending without opening a window automatically, then reconciles to the connected state and returns to the settings route.

## teams-connect-page-010

Original test `Subscription catch-up sees installation completed before attachment`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/teams-connect-page.test.tsx#L199).

- **Given** A Teams installation completes after the initial status snapshot but before the page attaches to change notifications.
- **When** The page finishes loading and catches up with current status.
- **Then** It shows the connected state and provides an “Open Teams” link that opens in a new tab.

## teams-connect-page-011

Original test `Reinstall remains explicit and returns to Teams`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/teams-connect-page.test.tsx#L213).

- **Given** A connected Teams account has a permission mismatch and a reinstall link; the return URL also contains Teams context and an untrusted service URL.
- **When** The user views the connected page.
- **Then** Reinstall remains an explicit link to the supplied Microsoft Teams installation URL, and “Open Teams” points to the Microsoft Teams homepage.

## teams-connect-page-012

Original test `Route departure cancels a pending read and keeps the next page`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/teams-connect-page.test.tsx#L244).

- **Given** A user is on Teams settings while a refreshed status read is pending.
- **When** They return to settings before the read completes, then the delayed read reports connected status.
- **Then** The next page remains the settings page at /works and does not show the stale connected Teams screen.

## teams-connect-page-013

Original test `Login and organization choice retain all Teams context: false`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/teams-connect-page.test.tsx#L275).

- **Given** A logged-out user opens the Teams settings route with Teams identity, conversation, activity, channel, thread, service URL, and error context.
- **When** The user is redirected to sign-in.
- **Then** The forced return URL preserves all supplied Teams context and returns to the Teams settings route.

## teams-connect-page-014

Original test `Login and organization choice retain all Teams context: true`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/teams-connect-page.test.tsx#L275).

- **Given** An authenticated user without an active organization opens the Teams settings route with Teams identity, conversation, activity, channel, thread, service URL, and error context.
- **When** The user is redirected to choose an organization.
- **Then** The forced return URL preserves all supplied Teams context and returns to the Teams settings route.

## teams-connect-page-015

Original test `A late status read cannot publish the previous actor's connection`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/teams-connect-page.test.tsx#L318).

- **Given** A Teams status read for the previous actor is pending when the signed-in owner changes.
- **When** The old read returns a connected result after the owner changes.
- **Then** The new owner's page stays in the connect state, reports an account-context mismatch, and does not show the previous actor's connected state.

## teams-connect-page-016

Original test `Conflicting repeated identity parameters display an invalid account context`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/teams-connect-page.test.tsx#L367).

- **Given** The Teams return URL contains conflicting repeated Teams user identity parameters.
- **When** The user opens the page.
- **Then** The page reports an incomplete Teams account context.

## teams-connect-page-017

Original test `An OAuth identity connects independently of the receiving bot's organization`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/teams-connect-page.test.tsx#L378).

- **Given** A linked OAuth Teams identity is connected, but the receiving bot is not installed and has no team, and the request names a different organization.
- **When** The user opens the Teams settings route.
- **Then** The page shows the connected state and confirms that the Teams account is connected, independently of the receiving bot's organization.
