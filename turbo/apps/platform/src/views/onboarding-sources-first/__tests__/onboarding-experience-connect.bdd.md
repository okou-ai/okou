# Onboarding experience connect

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [onboarding-experience-connect.test.tsx](onboarding-experience-connect.test.tsx).

## onboarding-experience-connect-001

Original test `The guided start comes before subscription plans`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-experience-connect.test.tsx#L148).

- **Given** A user with a connected work source reaches the guided-start step.
- **When** The available starting choices are displayed.
- **Then** “Start with Okou” appears before Codex, which appears before Claude Code.

## onboarding-experience-connect-002

Original test `The step reports connected once the account lists the subscription`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-experience-connect.test.tsx#L159).

- **Given** A user reaches the guided-start step with no listed personal model providers.
- **When** The user selects Codex, starts the device connection, and the account list then includes the subscription.
- **Then** The connection step reports Connected and its button is disabled.

## onboarding-experience-connect-003

Original test `A failed connection does not prevent continuing onboarding`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-experience-connect.test.tsx#L183).

- **Given** A user reaches the guided-start step with no listed personal model providers, and Codex device authentication is unavailable.
- **When** The user selects Codex, attempts to connect, closes the error dialog, and continues onboarding.
- **Then** The connection failure does not block continuing; the skills step appears at its onboarding route.

## onboarding-experience-connect-004

Original test `Starting with Okou skips the optional skills step`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-experience-connect.test.tsx#L222).

- **Given** A user starts onboarding from the beginning and reaches the guided-start step, with no plan selected and the organization's Slack not installed.
- **When** The user selects “Start with Okou” and continues.
- **Then** No Codex connection option is shown, and onboarding proceeds directly to the Slack step at its onboarding route, skipping the optional skills step.
