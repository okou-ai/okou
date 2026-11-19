# Auth v1 oauth

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [auth-v1-oauth.test.tsx](auth-v1-oauth.test.tsx).

## auth-v1-oauth-001

Original test `app.vm7.ai preserves its own app consent return in both validation layers`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/auth-v1/__tests__/auth-v1-oauth.test.tsx#L26).

- **Given** A signed-out user opens sign-in on app.vm7.ai with a consent return to https://app.vm7.ai containing OAuth parameters, two resource values, and state.
- **When** The sign-in page validates the return destination.
- **Then** The sign-in form and Google one-tap use that consent URL as their forced return, the allowed redirect origins include app.vm7.ai, and the sign-up link retains the return URL.

## auth-v1-oauth-002

Original test `app.okou.ai preserves its own app consent return in both validation layers`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/auth-v1/__tests__/auth-v1-oauth.test.tsx#L26).

- **Given** A signed-out user opens sign-in on app.okou.ai with a consent return to that app containing OAuth parameters, two resource values, and state.
- **When** The sign-in page validates the return destination.
- **Then** The sign-in form and Google one-tap use that consent URL as their forced return, the allowed redirect origins include app.okou.ai, and the sign-up link retains the return URL.

## auth-v1-oauth-003

Original test `Sign-in preserves the consent query when Clerk moves the return into its hash`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/auth-v1/__tests__/auth-v1-oauth.test.tsx#L58).

- **Given** A signed-out user opens sign-in with a consent return URL in the page hash.
- **When** The user views the sign-in form and its sign-up navigation.
- **Then** The form uses the consent URL as its forced return, and the sign-up link preserves it in its hash.

## auth-v1-oauth-004

Original test `Hosted signup preserves the consent return and sign-in navigation from its hash`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/auth-v1/__tests__/auth-v1-oauth.test.tsx#L76).

- **Given** A signed-out user opens hosted sign-up with a consent return URL in the page hash.
- **When** The user views the sign-up form and its sign-in navigation.
- **Then** The form uses the consent URL as its forced return, and the sign-in link preserves it in its hash.

## auth-v1-oauth-005

Original test `An untrusted consent destination cannot control login: https://oauth-test.accounts.dev/oauth-consent`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/auth-v1/__tests__/auth-v1-oauth.test.tsx#L108).

- **Given** A user opens sign-in on app.vm7.ai with return URL https://oauth-test.accounts.dev/oauth-consent.
- **When** The app validates the return URL.
- **Then** The sign-in forced return is app.vm7.ai, and no authenticated redirect occurs.

## auth-v1-oauth-006

Original test `An untrusted consent destination cannot control login: https://another.accounts.dev/oauth-consent`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/auth-v1/__tests__/auth-v1-oauth.test.tsx#L108).

- **Given** A user opens sign-in on app.vm7.ai with return URL https://another.accounts.dev/oauth-consent.
- **When** The app validates the return URL.
- **Then** The sign-in forced return is app.vm7.ai, and no authenticated redirect occurs.

## auth-v1-oauth-007

Original test `An untrusted consent destination cannot control login: https://accounts.okou.ai/oauth-consent`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/auth-v1/__tests__/auth-v1-oauth.test.tsx#L108).

- **Given** A user opens sign-in on app.vm7.ai with return URL https://accounts.okou.ai/oauth-consent.
- **When** The app validates the return URL.
- **Then** The sign-in forced return is app.vm7.ai, and no authenticated redirect occurs.

## auth-v1-oauth-008

Original test `An untrusted consent destination cannot control login: https://app.okou.ai/oauth-consent`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/auth-v1/__tests__/auth-v1-oauth.test.tsx#L108).

- **Given** A user opens sign-in on app.vm7.ai with return URL https://app.okou.ai/oauth-consent.
- **When** The app validates the return URL.
- **Then** The sign-in forced return is app.vm7.ai, and no authenticated redirect occurs.

## auth-v1-oauth-009

Original test `An untrusted consent destination cannot control login: https://oauth-test.accounts.dev.evil.example/oauth-consent`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/auth-v1/__tests__/auth-v1-oauth.test.tsx#L108).

- **Given** A user opens sign-in on app.vm7.ai with return URL https://oauth-test.accounts.dev.evil.example/oauth-consent.
- **When** The app validates the return URL.
- **Then** The sign-in forced return is app.vm7.ai, and no authenticated redirect occurs.

## auth-v1-oauth-010

Original test `An untrusted consent destination cannot control login: https://oauth-test.accounts.dev@evil.example/oauth-consent`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/auth-v1/__tests__/auth-v1-oauth.test.tsx#L108).

- **Given** A user opens sign-in on app.vm7.ai with return URL https://oauth-test.accounts.dev@evil.example/oauth-consent.
- **When** The app validates the return URL.
- **Then** The sign-in forced return is app.vm7.ai, and no authenticated redirect occurs.

## auth-v1-oauth-011

Original test `An untrusted consent destination cannot control login: https://user:secret@app.vm7.ai/oauth-consent`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/auth-v1/__tests__/auth-v1-oauth.test.tsx#L108).

- **Given** A user opens sign-in on app.vm7.ai with return URL https://user:secret@app.vm7.ai/oauth-consent.
- **When** The app validates the return URL.
- **Then** The sign-in forced return is app.vm7.ai, and no authenticated redirect occurs.

## auth-v1-oauth-012

Original test `An untrusted consent destination cannot control login: http://app.vm7.ai/oauth-consent`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/auth-v1/__tests__/auth-v1-oauth.test.tsx#L108).

- **Given** A user opens sign-in on app.vm7.ai with return URL http://app.vm7.ai/oauth-consent.
- **When** The app validates the return URL.
- **Then** The sign-in forced return is app.vm7.ai, and no authenticated redirect occurs.

## auth-v1-oauth-013

Original test `An untrusted consent destination cannot control login: https://app.vm7.ai:444/oauth-consent`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/auth-v1/__tests__/auth-v1-oauth.test.tsx#L108).

- **Given** A user opens sign-in on app.vm7.ai with return URL https://app.vm7.ai:444/oauth-consent.
- **When** The app validates the return URL.
- **Then** The sign-in forced return is app.vm7.ai, and no authenticated redirect occurs.

## auth-v1-oauth-014

Original test `An untrusted consent destination cannot control login: javascript:alert(1)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/auth-v1/__tests__/auth-v1-oauth.test.tsx#L108).

- **Given** A user opens sign-in on app.vm7.ai with return URL javascript:alert(1).
- **When** The app validates the return URL.
- **Then** The sign-in forced return is app.vm7.ai, and no authenticated redirect occurs.

## auth-v1-oauth-015

Original test `A non-consent app return cannot bypass login: https://app.vm7.ai/oauth-consent/other`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/auth-v1/__tests__/auth-v1-oauth.test.tsx#L129).

- **Given** A user opens sign-in on app.vm7.ai with return URL https://app.vm7.ai/oauth-consent/other.
- **When** The app validates the return URL.
- **Then** The sign-in form retains that return URL, and no authenticated redirect occurs.

## auth-v1-oauth-016

Original test `A non-consent app return cannot bypass login: https://app.vm7.ai/oauth-consent#untrusted-route`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/auth-v1/__tests__/auth-v1-oauth.test.tsx#L129).

- **Given** A user opens sign-in on app.vm7.ai with return URL https://app.vm7.ai/oauth-consent#untrusted-route.
- **When** The app validates the return URL.
- **Then** The sign-in form retains that return URL, and no authenticated redirect occurs.

## auth-v1-oauth-017

Original test `An active session on sign-in continues through Clerk's authenticated navigation`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/auth-v1/__tests__/auth-v1-oauth.test.tsx#L144).

- **Given** A user with an active session opens sign-in on app.vm7.ai with a valid consent return URL.
- **When** The app continues the authenticated navigation through Clerk.
- **Then** The browser navigates to Clerk's decorated consent URL, Clerk's authenticated redirect is called once with the original URL, and the sign-in form is absent.

## auth-v1-oauth-018

Original test `An active session on sign-up continues through Clerk's authenticated navigation`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/auth-v1/__tests__/auth-v1-oauth.test.tsx#L144).

- **Given** A user with an active session opens sign-up on app.vm7.ai with a valid consent return URL.
- **When** The app continues the authenticated navigation through Clerk.
- **Then** The browser navigates to Clerk's decorated consent URL, Clerk's authenticated redirect is called once with the original URL, and the sign-up form is absent.

## auth-v1-oauth-019

Original test `An existing session preserves explicit auth steps: /sign-in/tasks/choose-organization`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/auth-v1/__tests__/auth-v1-oauth.test.tsx#L175).

- **Given** A user with an existing session opens /sign-in/tasks/choose-organization with a valid consent return URL.
- **When** The page handles the existing session.
- **Then** The sign-in form remains visible, and no authenticated redirect occurs.

## auth-v1-oauth-020

Original test `An existing session preserves explicit auth steps: /sign-in/factor-two`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/auth-v1/__tests__/auth-v1-oauth.test.tsx#L175).

- **Given** A user with an existing session opens /sign-in/factor-two with a valid consent return URL.
- **When** The page handles the existing session.
- **Then** The sign-in form remains visible, and no authenticated redirect occurs.

## auth-v1-oauth-021

Original test `An existing session preserves explicit auth steps: /sign-in #/choose`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/auth-v1/__tests__/auth-v1-oauth.test.tsx#L175).

- **Given** A user with an existing session opens /sign-in with a valid consent return URL and the hash #/choose.
- **When** The page handles the existing session.
- **Then** The sign-in form remains visible, and no authenticated redirect occurs.

## auth-v1-oauth-022

Original test `An existing session preserves explicit auth steps: /sign-in &__clerk_ticket=invitation`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/auth-v1/__tests__/auth-v1-oauth.test.tsx#L175).

- **Given** A user with an existing session opens /sign-in with a valid consent return URL and an invitation ticket parameter.
- **When** The page handles the existing session.
- **Then** The sign-in form remains visible, and no authenticated redirect occurs.

## auth-v1-oauth-023

Original test `An existing session preserves explicit auth steps: /sign-in &prompt=login`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/auth-v1/__tests__/auth-v1-oauth.test.tsx#L175).

- **Given** A user with an existing session opens /sign-in with a valid consent return URL and prompt=login.
- **When** The page handles the existing session.
- **Then** The sign-in form remains visible, and no authenticated redirect occurs.

## auth-v1-oauth-024

Original test `An existing session preserves explicit auth steps: /sign-in #/?prompt=select_account`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/auth-v1/__tests__/auth-v1-oauth.test.tsx#L175).

- **Given** A user with an existing session opens /sign-in with a valid consent return URL and the hash #/?prompt=select_account.
- **When** The page handles the existing session.
- **Then** The sign-in form remains visible, and no authenticated redirect occurs.

## auth-v1-oauth-025

Original test `A consent request requiring user interaction stays on the form: prompt=login`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/auth-v1/__tests__/auth-v1-oauth.test.tsx#L195).

- **Given** A signed-out user opens sign-in with a consent request containing prompt=login.
- **When** The page evaluates whether it can continue to OAuth consent.
- **Then** The sign-in form remains visible, and no authenticated redirect occurs.

## auth-v1-oauth-026

Original test `A consent request requiring user interaction stays on the form: prompt=select_account`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/auth-v1/__tests__/auth-v1-oauth.test.tsx#L195).

- **Given** A signed-out user opens sign-in with a consent request containing prompt=select_account.
- **When** The page evaluates whether it can continue to OAuth consent.
- **Then** The sign-in form remains visible, and no authenticated redirect occurs.

## auth-v1-oauth-027

Original test `A consent request requiring user interaction stays on the form: max_age=0`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/auth-v1/__tests__/auth-v1-oauth.test.tsx#L195).

- **Given** A signed-out user opens sign-in with a consent request containing max_age=0.
- **When** The page evaluates whether it can continue to OAuth consent.
- **Then** The sign-in form remains visible, and no authenticated redirect occurs.

## auth-v1-oauth-028

Original test `A consent request requiring user interaction stays on the form: login_hint=other@example.com`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/auth-v1/__tests__/auth-v1-oauth.test.tsx#L195).

- **Given** A signed-out user opens sign-in with a consent request containing login_hint=other@example.com.
- **When** The page evaluates whether it can continue to OAuth consent.
- **Then** The sign-in form remains visible, and no authenticated redirect occurs.

## auth-v1-oauth-029

Original test `An incomplete Clerk session finishes its task before OAuth consent`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/auth-v1/__tests__/auth-v1-oauth.test.tsx#L209).

- **Given** A user with a pending Clerk session task to choose an organization opens sign-in with a valid consent return URL.
- **When** The page handles the incomplete session.
- **Then** The sign-in form remains visible, and no authenticated redirect to OAuth consent occurs.

## auth-v1-oauth-030

Original test `A failed OAuth continuation offers visible recovery`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/auth-v1/__tests__/auth-v1-oauth.test.tsx#L234).

- **Given** A signed-out user opens sign-in with a valid consent return URL, but Clerk's OAuth continuation fails.
- **When** The app attempts the continuation.
- **Then** A visible alert says “Oops! Something went sideways,” and Clerk's continuation was called once.
