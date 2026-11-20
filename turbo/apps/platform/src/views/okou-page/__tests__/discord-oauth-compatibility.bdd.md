# Discord oauth compatibility

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [discord-oauth-compatibility.test.tsx](discord-oauth-compatibility.test.tsx).

## discord-oauth-compatibility-001

Original test `The current Works opener completes safely with a closed after approval consent tab`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/discord-oauth-compatibility.test.tsx#L46).

- **Given** A user starts Discord connection from Works and the first completion request says approval is still required.
- **When** They approve and close the consent tab.
- **Then** The Works card becomes Connected, the route stays /works, and the popup remains closed at the authorization URL without exposing the completion token.

## discord-oauth-compatibility-002

Original test `The current Works opener completes safely with a ready consent tab`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/discord-oauth-compatibility.test.tsx#L46).

- **Given** A user starts Discord connection from Works and the first completion request says approval is still required.
- **When** They approve, and the ready consent tab signals readiness after the connection completes.
- **Then** The Works card becomes Connected and the route stays /works. The tab receives one connected result for the matching state, without the completion token appearing in its URL.

## discord-oauth-compatibility-003

Original test `Approval and closure while a pending response is in flight still completes from /works`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/discord-oauth-compatibility.test.tsx#L127).

- **Given** A user starts Discord connection from /works while a completion request is awaiting its response.
- **When** They approve in the consent tab, close it, and the pending request returns approval required.
- **Then** A subsequent completion succeeds: the Discord integration shows Connected, the route remains /works, the popup is closed, no cancellation message appears, and no Sentry report is recorded.

## discord-oauth-compatibility-004

Original test `Approval and closure while a pending response is in flight still completes from /settings/discord`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/discord-oauth-compatibility.test.tsx#L127).

- **Given** A user starts Discord connection from /settings/discord while a completion request is awaiting its response.
- **When** They approve in the consent tab, close it, and the pending request returns approval required.
- **Then** A subsequent completion succeeds: the page shows Connected to Discord, the route remains /settings/discord with status=connected, the popup is closed, no cancellation message appears, and no Sentry report is recorded.

## discord-oauth-compatibility-005

Original test `A missing opener reports authorization interruption without retaining proof`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/discord-oauth-compatibility.test.tsx#L199).

- **Given** The Discord approval callback has a valid proof, but the browser has no opener.
- **When** The callback page loads.
- **Then** It reports that authorization was interrupted or refreshed, does not show an Open Discord link, makes no approval request, and removes the proof from the URL.

## discord-oauth-compatibility-006

Original test `A closed opener reports authorization interruption without retaining proof`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/discord-oauth-compatibility.test.tsx#L199).

- **Given** The Discord approval callback has a valid proof, but its opener is already closed.
- **When** The callback page loads.
- **Then** It reports that authorization was interrupted or refreshed, does not show an Open Discord link, makes no approval request, and removes the proof from the URL.

## discord-oauth-compatibility-007

Original test `A closes after approval opener reports authorization interruption without retaining proof`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/discord-oauth-compatibility.test.tsx#L199).

- **Given** The Discord approval callback has a valid proof and an open opener.
- **When** The callback page starts approval and the opener closes immediately afterward.
- **Then** It reports that authorization was interrupted or refreshed, does not show an Open Discord link, submits exactly one approval request, and removes the proof from the URL.

## discord-oauth-compatibility-008

Original test `The first completion result wins over a duplicate result`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/discord-oauth-compatibility.test.tsx#L231).

- **Given** The approval callback has an opener, and the server reports the account connected.
- **When** The opener sends a connected result followed by a duplicate error result.
- **Then** The first result wins: the page shows Connected to Discord and the URL status is connected.

## discord-oauth-compatibility-009

Original test `A connected status destination reads actual state on reload`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/discord-oauth-compatibility.test.tsx#L260).

- **Given** A user reloads /settings/discord?status=connected&workspace=Forged while the server reports a connected account.
- **When** The page loads the status destination.
- **Then** It shows Connected to Discord based on the server state and does not display the forged workspace name.

## discord-oauth-compatibility-010

Original test `A error status destination reads actual state on reload`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/discord-oauth-compatibility.test.tsx#L260).

- **Given** A user reloads /settings/discord?status=error&workspace=Forged while the server reports a connected account.
- **When** The page loads the status destination.
- **Then** It shows Connection failed based on the status destination and does not display the forged workspace name.

## discord-oauth-compatibility-011

Original test `Known callback errors at /works?discord=error retain only public server context`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/discord-oauth-compatibility.test.tsx#L282).

- **Given** A user arrives at /works?discord=error with known cancellation context and extra private proof and an untrusted return URL in the query.
- **When** The callback error route is loaded.
- **Then** The app navigates to /settings/discord and retains only status=error, discord_error=cancelled, and the guild ID. It shows the cancellation message, and telemetry contains neither the private proof nor the untrusted host.

## discord-oauth-compatibility-012

Original test `Known callback errors at /settings/discord?status=error retain only public server context`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/discord-oauth-compatibility.test.tsx#L282).

- **Given** A user arrives at /settings/discord?status=error with known cancellation context and extra private proof and an untrusted return URL in the query.
- **When** The callback error route is loaded.
- **Then** The app retains only status=error, discord_error=cancelled, and the guild ID. It shows the cancellation message, and telemetry contains neither the private proof nor the untrusted host.

## discord-oauth-compatibility-013

Original test `Login continuation keeps the callback destination and server but never the consent proof`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/discord-oauth-compatibility.test.tsx#L309).

- **Given** An unauthenticated user opens an approval callback on app.okou.ai containing a guild ID, completion token, state, and approval proof.
- **When** The app redirects the user to sign-in.
- **Then** The redirect destination preserves /settings/discord, status=pending, and the guild ID, but excludes the approval proof and completion token.

## discord-oauth-compatibility-014

Original test `A failed attempt keeps its consent popup until route abort closes it`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/discord-oauth-compatibility.test.tsx#L329).

- **Given** A user starts joining a new Discord server and the initial completion request remains pending before returning approval required.
- **When** The follow-up completion fails because an existing Discord account must be disconnected, then the user chooses Back to settings.
- **Then** The failure message appears and no Open Discord link is shown; the consent popup stays open at the authorization URL until the route abort closes it. The user returns to /works.

## discord-oauth-compatibility-015

Original test `An install route cannot consume a consent proof or claim installation from an existing account`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/discord-oauth-compatibility.test.tsx#L387).

- **Given** An existing Discord account is connected, and an install route is opened with a connected status and approval proof in its callback fragment.
- **When** The install page loads.
- **Then** It shows Add Okou to a server with Join new server enabled, does not show Open Discord, clears the fragment, and makes no approval request.
