# Onboarding team redirect

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [onboarding-team-redirect.test.tsx](onboarding-team-redirect.test.tsx).

## onboarding-team-redirect-001

Original test `The retired invite URL continues to experience for isAdmin=true`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-team-redirect.test.tsx#L10).

- **Given** An administrator who needs onboarding opens the retired invite URL with redeemCode=LAUNCH50.
- **When** The URL loads.
- **Then** The user is taken to the experience question, and the redeem code remains in the URL.

## onboarding-team-redirect-002

Original test `The retired invite URL continues to experience for isAdmin=false`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-team-redirect.test.tsx#L10).

- **Given** A non-administrator who needs onboarding opens the retired invite URL with redeemCode=LAUNCH50.
- **When** The URL loads.
- **Then** The user is taken to the experience question, and the redeem code remains in the URL.
