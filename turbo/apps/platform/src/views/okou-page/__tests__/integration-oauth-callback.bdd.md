# Integration oauth callback

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [integration-oauth-callback.test.tsx](integration-oauth-callback.test.tsx).

## integration-oauth-callback-001

Original test `slack callback signs in before submitting provider credentials`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/integration-oauth-callback.test.tsx#L13).

- **Given** A user is signed out and opens a Slack OAuth callback URL containing state and code.
- **When** The callback page loads.
- **Then** The user is sent to sign-in with the original callback URL preserved as the redirect URL.

## integration-oauth-callback-002

Original test `teams callback signs in before submitting provider credentials`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/integration-oauth-callback.test.tsx#L13).

- **Given** A user is signed out and opens a Microsoft Teams OAuth callback URL containing state and code.
- **When** The callback page loads.
- **Then** The user is sent to sign-in with the original callback URL preserved as the redirect URL.

## integration-oauth-callback-003

Original test `github callback signs in before submitting provider credentials`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/integration-oauth-callback.test.tsx#L13).

- **Given** A user is signed out and opens a GitHub OAuth callback URL containing state and code.
- **When** The callback page loads.
- **Then** The user is sent to sign-in with the original callback URL preserved as the redirect URL.

## integration-oauth-callback-004

Original test `slack callback completes with the active session and follows the API continuation`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/integration-oauth-callback.test.tsx#L26).

- **Given** A user with an active session opens a Slack OAuth callback URL containing state and code. The callback API returns a continuation to the Slack settings page.
- **When** The callback is processed.
- **Then** The API receives the code and state in JSON mode with bearer authorization. A secure-connection progress message appears, then the browser follows the API continuation to Slack settings.

## integration-oauth-callback-005

Original test `teams callback completes with the active session and follows the API continuation`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/integration-oauth-callback.test.tsx#L26).

- **Given** A user with an active session opens a Microsoft Teams OAuth callback URL containing state and code. The callback API returns a continuation to the Teams settings page.
- **When** The callback is processed.
- **Then** The API receives the code and state in JSON mode with bearer authorization. A secure-connection progress message appears, then the browser follows the API continuation to Teams settings.

## integration-oauth-callback-006

Original test `github callback completes with the active session and follows the API continuation`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/integration-oauth-callback.test.tsx#L26).

- **Given** A user with an active session opens a GitHub OAuth callback URL containing state and code. The callback API returns a GitHub authorization URL as its continuation.
- **When** The callback is processed.
- **Then** The API receives the code and state in JSON mode with bearer authorization. A secure-connection progress message appears, then the browser follows the returned GitHub authorization URL.
