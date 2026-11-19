# Onboarding agentphone tile

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [onboarding-agentphone-tile.test.tsx](onboarding-agentphone-tile.test.tsx).

## onboarding-agentphone-tile-001

Original test `iMessage shows its QR inline without a channel click, with parallel alternatives`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-agentphone-tile.test.tsx#L87).

- **Given** The onboarding workspace has a configured, unlinked iMessage phone number and the user is on the desktop chat-app step.
- **When** The connection code is available.
- **Then** A QR code and SMS link are shown inline without opening a dialog, using the connection code. The phone number is displayed and can be copied, and Slack, Telegram, and Teams remain available. Continue is disabled.

## onboarding-agentphone-tile-002

Original test `Linking iMessage replaces the QR and enables Continue without Slack`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-agentphone-tile.test.tsx#L119).

- **Given** The user is on the desktop onboarding chat-app step with an unlinked iMessage phone.
- **When** The phone becomes linked.
- **Then** The QR code is replaced by “iMessage is connected,” Continue becomes enabled, and selecting Continue advances to the capabilities step without connecting Slack.

## onboarding-agentphone-tile-003

Original test `Mobile shows the iMessage connection inline and advances only after linking`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-agentphone-tile.test.tsx#L143).

- **Given** The onboarding workspace has a configured, unlinked iMessage phone number and the user is on the mobile chat-app step.
- **When** They wait for the connection code, then the phone becomes linked and they select Continue.
- **Then** The inline SMS link uses the connection code, and Slack, Telegram, and Teams remain available while Continue is disabled. After linking, “iMessage is connected” appears, Continue becomes enabled, and the next heading is “More ways to get your work done.”

## onboarding-agentphone-tile-004

Original test `A pending connection code does not prevent skipping the step`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-agentphone-tile.test.tsx#L182).

- **Given** The user is on the onboarding chat-app step while the iMessage connection-code request is still pending.
- **When** They select “Not now” before the code request completes.
- **Then** The next heading is “More ways to get your work done.” The pending code response does not prevent moving to the capabilities step.

## onboarding-agentphone-tile-005

Original test `An already linked phone needs no new connection code`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-agentphone-tile.test.tsx#L206).

- **Given** The onboarding workspace has an already linked, configured iMessage phone.
- **When** The user opens the onboarding chat-app step.
- **Then** “iMessage is connected” is shown, no QR code appears, and Continue is enabled. No new connection code is requested.

## onboarding-agentphone-tile-006

Original test `An unconfigured phone leaves the other channels and skip available`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-agentphone-tile.test.tsx#L222).

- **Given** The onboarding workspace has an unconfigured iMessage phone.
- **When** The user opens the onboarding chat-app step.
- **Then** The page says iMessage is not available for the workspace, shows no QR code, and leaves Slack and “Not now” available. No connection code is requested.

## onboarding-agentphone-tile-007

Original test `An expired code is not scannable and can be replaced`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-agentphone-tile.test.tsx#L240).

- **Given** The user is on the onboarding chat-app step and the generated iMessage connection code is already expired.
- **When** They request a new code and the replacement is valid.
- **Then** The expired code is reported as expired, with no QR code or SMS link. After selecting “Get a new code,” a QR code appears for the replacement.
