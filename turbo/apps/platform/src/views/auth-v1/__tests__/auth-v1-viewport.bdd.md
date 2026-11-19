# Auth v1 viewport

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [auth-v1-viewport.test.tsx](auth-v1-viewport.test.tsx).

## auth-v1-viewport-001

Original test `Leaving hosted auth restores the existing app zoom policy`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/auth-v1/__tests__/auth-v1-viewport.test.tsx#L44).

- **Given** A user starts on the app with its default restrictive zoom policy and opens hosted sign-in.
- **When** The user moves from sign-in to sign-up, then leaves hosted auth for /_/error.
- **Then** Sign-in and sign-up do not prevent pinch or control-wheel zoom. On sign-up the viewport allows accessible zoom. On /_/error the default app viewport policy is restored and pinch and control-wheel zoom are prevented.
