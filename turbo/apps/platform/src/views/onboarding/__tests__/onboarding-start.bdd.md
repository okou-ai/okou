# Onboarding start

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [onboarding-start.test.tsx](onboarding-start.test.tsx).

## onboarding-start-001

Original test `Onboarding sends an authenticated event without waiting, with one attempt record before the POST`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding/__tests__/onboarding-start.test.tsx#L66).

- **Given** A signed-in user needs onboarding.
- **When** The user opens the onboarding page while Marketing records the event request but delays its response.
- **Then** The industry question appears without waiting for the response. One authenticated POST is sent to https://www.okou.ai/api/events with the onboarding-start tag and a UUID event ID; one started telemetry record for the user and organization exists before the POST, with no status code, and the request remains un-aborted.

## onboarding-start-002

Original test `A Marketing 401 response does not produce another telemetry record or block onboarding`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding/__tests__/onboarding-start.test.tsx#L106).

- **Given** A signed-in user needs onboarding and the Marketing endpoint responds with HTTP 401.
- **When** The user opens onboarding, then the window receives focus and online events.
- **Then** The industry question remains visible. The request uses the authenticated endpoint, and exactly one started telemetry record exists; no retry record is produced.

## onboarding-start-003

Original test `A Marketing 503 response does not produce another telemetry record or block onboarding`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding/__tests__/onboarding-start.test.tsx#L106).

- **Given** A signed-in user needs onboarding and the Marketing endpoint responds with HTTP 503.
- **When** The user opens onboarding, then the window receives focus and online events.
- **Then** The industry question remains visible. The request uses the authenticated endpoint, and exactly one started telemetry record exists; no retry record is produced.

## onboarding-start-004

Original test `An already onboarded user continues into the app`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding/__tests__/onboarding-start.test.tsx#L137).

- **Given** The user is already onboarded.
- **When** The user opens the onboarding page.
- **Then** The app's Message textbox appears, and no Marketing telemetry record is sent.

## onboarding-start-005

Original test `Preview onboarding sends to its matching Marketing environment`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding/__tests__/onboarding-start.test.tsx#L150).

- **Given** A user on the staging preview needs onboarding.
- **When** The user opens onboarding on staging-app.omby.ai.
- **Then** The industry question appears, and the Marketing request is sent to https://staging-www.omby.ai/api/events.
