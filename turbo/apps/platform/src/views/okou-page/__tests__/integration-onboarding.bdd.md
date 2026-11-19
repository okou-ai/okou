# Integration onboarding

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [integration-onboarding.test.tsx](integration-onboarding.test.tsx).

## integration-onboarding-001

Original test `A legacy Discord pending callback is exempt before onboarding can resolve`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/integration-onboarding.test.tsx#L30).

- **Given** Onboarding is required and incomplete, Discord is disconnected, and the user visits /works with the legacy Discord pending marker and OAuth approval details in the fragment.
- **When** The page processes the legacy callback.
- **Then** The user is redirected to /settings/discord, the fragment is cleared, and no onboarding prompt appears.

## integration-onboarding-002

Original test `A legacy Discord error callback is exempt before onboarding can resolve`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/integration-onboarding.test.tsx#L30).

- **Given** Onboarding is required and incomplete, Discord is disconnected, and the user visits /works with the legacy Discord error marker and OAuth approval details in the fragment.
- **When** The page processes the legacy callback.
- **Then** The user is redirected to /settings/discord, the fragment is cleared, and no onboarding prompt appears.

## integration-onboarding-003

Original test `A legacy Discord connected callback is exempt before onboarding can resolve`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/integration-onboarding.test.tsx#L30).

- **Given** Onboarding is required and incomplete, Discord is disconnected, and the user visits /works with the legacy Discord connected marker and OAuth approval details in the fragment.
- **When** The page processes the legacy callback.
- **Then** The user is redirected to /settings/discord, the fragment is cleared, and no onboarding prompt appears.

## integration-onboarding-004

Original test `The legacy callback bridge can finish before a pending onboarding response`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/integration-onboarding.test.tsx#L54).

- **Given** The user is on /works while the onboarding response is still pending, and Discord is disconnected.
- **When** The browser address changes to /works?discord=pending before the onboarding response resolves.
- **Then** The legacy callback bridge redirects to /settings/discord before the response resolves and remains there afterward, without showing the onboarding prompt.

## integration-onboarding-005

Original test `/works still requires onboarding`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/integration-onboarding.test.tsx#L89).

- **Given** Onboarding is required and incomplete, and the user opens /works.
- **When** The page loads with an unrelated prompt query marker.
- **Then** The onboarding prompt appears and the user is redirected to /onboarding.

## integration-onboarding-006

Original test `/works?discord=unknown still requires onboarding`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/integration-onboarding.test.tsx#L89).

- **Given** Onboarding is required and incomplete, and the user opens /works?discord=unknown.
- **When** The page loads with an unrelated prompt query marker.
- **Then** The onboarding prompt appears and the user is redirected to /onboarding.

## integration-onboarding-007

Original test `/settings/discord retains its canonical onboarding bypass without treating a marker as proof`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/integration-onboarding.test.tsx#L107).

- **Given** Onboarding is required and incomplete, Discord is disconnected, and the user opens /settings/discord with a pending status marker.
- **When** The page loads.
- **Then** The route remains /settings/discord without an onboarding prompt. A “Connection failed” heading and interrupted-or-refreshed authorization message appear, with “Back to settings” linking to /works.

## integration-onboarding-008

Original test `/settings/discord/install retains its canonical onboarding bypass without treating a marker as proof`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/integration-onboarding.test.tsx#L107).

- **Given** Onboarding is required and incomplete, Discord is disconnected, and the user opens /settings/discord/install with a pending status marker.
- **When** The page loads.
- **Then** The route remains /settings/discord/install without an onboarding prompt. A “Connection failed” heading and interrupted-or-refreshed authorization message appear, with “Back to settings” linking to /works.
