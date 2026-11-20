# Onboarding chat channels

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [onboarding-chat-channels.test.tsx](onboarding-chat-channels.test.tsx).

## onboarding-chat-channels-001

Original test `The step sends an admin to Slack's own install and turns connected once the install lands`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-chat-channels.test.tsx#L125).

- **Given** An administrator needs onboarding, has a connected source, and Slack and Teams are not installed or connected.
- **When** The user opens the chat-channel step, chooses Add to Slack, and chooses Teams; Slack then reports that installation completed and a Slack change is announced.
- **Then** Add to Slack opens Slack's install URL in a new tab with the current timestamp. Teams opens its connect URL in a new tab with the timestamp. After the Slack change, the heading says “Your chat is connected” and Slack's “Added to your workspace” control is disabled.

## onboarding-chat-channels-002

Original test `A protected worker preview keeps access on its matching OAuth start URL`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-chat-channels.test.tsx#L183).

- **Given** An administrator opens the chat-channel step on a protected preview host; Slack is not installed and its install URL includes OAuth state, while Teams is already connected.
- **When** The user chooses Add to Slack.
- **Then** The new tab opens Slack's matching OAuth start URL with its existing state, the current timestamp, and the preview-protection bypass parameter.

## onboarding-chat-channels-003

Original test `An installed workspace offers the account connect rather than the install`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-chat-channels.test.tsx#L225).

- **Given** An administrator needs onboarding and has a connected source; Slack is installed but this user is not connected, and Teams is already connected.
- **When** The user opens the chat-channel step and chooses Connect Slack.
- **Then** Slack offers the account-connect action rather than the install action and opens its connect URL in a new tab with the current timestamp. Teams is marked Added and disabled.

## onboarding-chat-channels-004

Original test `A workspace this user cannot add to names who can, instead of a dead button`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-chat-channels.test.tsx#L265).

- **Given** A non-administrator needs onboarding and has a connected source; neither Slack nor Teams is installed, and neither offers an install or connect URL.
- **When** The user opens the chat-channel step.
- **Then** The page tells the user to ask a workspace admin to add Okou to Slack and Teams. The Slack and Teams actions are disabled.

## onboarding-chat-channels-005

Original test `Onboarding explains Telegram bot_not_configured and leaves retry available`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-chat-channels.test.tsx#L318).

- **Given** Telegram reports readiness error bot_not_configured for its official bot during onboarding.
- **When** The user tries to connect Telegram.
- **Then** The page explains, “Telegram connection is not configured yet. Please contact support.” Telegram remains available to retry, is not marked Added, onboarding stays open, and no Sentry report is recorded.

## onboarding-chat-channels-006

Original test `Onboarding explains Telegram domain_not_verified and leaves retry available`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-chat-channels.test.tsx#L318).

- **Given** Telegram reports readiness error domain_not_verified for its official bot during onboarding.
- **When** The user tries to connect Telegram.
- **Then** The page explains, “We couldn't verify Telegram login for this app. Contact support if the problem continues.” Telegram remains available to retry, is not marked Added, onboarding stays open, and no Sentry report is recorded.

## onboarding-chat-channels-007

Original test `Onboarding explains Telegram domain_check_failed and leaves retry available`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-chat-channels.test.tsx#L318).

- **Given** Telegram reports readiness error domain_check_failed for its official bot during onboarding.
- **When** The user tries to connect Telegram.
- **Then** The page explains, “We couldn't reach Telegram to check the connection.” Telegram remains available to retry, is not marked Added, onboarding stays open, and no Sentry report is recorded.

## onboarding-chat-channels-008

Original test `Telegram authorizes the official bot in a new tab and keeps onboarding open`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-chat-channels.test.tsx#L360).

- **Given** An administrator needs onboarding, has a connected source, and Telegram's official bot is ready but not connected.
- **When** The user selects Telegram, completes the official bot authorization, and waits for the account binding to finish.
- **Then** Authorization opens in a new tab for the official bot. While binding is pending, Telegram is not marked Added, Continue is disabled, and onboarding stays open. Once binding succeeds, the page confirms “Connected to Telegram!”, marks Telegram Added, enables Continue, and remains on the chat-channel step; the authorization tab stays open.

## onboarding-chat-channels-009

Original test `A pending Teams installation keeps onboarding in place until real status is connected`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-chat-channels.test.tsx#L520).

- **Given** A user has a pending Teams installation, no connected chat channel, and a saved first-task draft reading “Keep my launch plan.”
- **When** The user selects Teams, then Teams reports installed and connected after the page becomes hidden and visible; the user continues through capabilities to the first-task step.
- **Then** The Teams action opens the Teams settings path, and Continue stays disabled until the updated status reports connected. Teams then shows Added, Continue is enabled, and the user can proceed without leaving onboarding; the first-task draft is restored as “Keep my launch plan.”
