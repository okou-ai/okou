# Onboarding discord

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [onboarding-discord.test.tsx](onboarding-discord.test.tsx).

## onboarding-discord-001

Original test `Discord verifies before allowing onboarding to continue (mobile=false)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-discord.test.tsx#L86).

- **Given** An administrator needs onboarding and has a connected source; Discord is available but disconnected, and the test runs on desktop.
- **When** The user starts Discord authorization and waits for completion before continuing through capabilities.
- **Then** Continue is disabled while Discord is disconnected and while authorization completion is pending. The authorization opens in a new tab, Discord is disabled during completion, and onboarding remains on the chat step. On success Discord is marked Added and disabled, Continue is enabled, and the user can reach the first-task step.

## onboarding-discord-002

Original test `Discord verifies before allowing onboarding to continue (mobile=true)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-discord.test.tsx#L86).

- **Given** An administrator needs onboarding and has a connected source; Discord is available but disconnected, and the test runs on mobile.
- **When** The user starts Discord authorization and waits for completion before continuing through capabilities.
- **Then** Continue is disabled while Discord is disconnected and while authorization completion is pending. The authorization opens in a new tab, Discord is disabled during completion, and onboarding remains on the chat step. On success Discord is marked Added and disabled, Continue is enabled, and the user can reach the first-task step.

## onboarding-discord-003

Original test `An existing Discord connection follows live connection changes during onboarding`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-discord.test.tsx#L154).

- **Given** An administrator needs onboarding and has a connected source; Discord is already connected.
- **When** The connection changes to disconnected while the user is on the chat-channel step.
- **Then** Discord initially shows Added and Continue is enabled. After the change, the heading returns to “Keep Okou a message away,” Discord is enabled, and Continue is disabled.

## onboarding-discord-004

Original test `An unavailable Discord integration explains why it cannot connect`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-discord.test.tsx#L183).

- **Given** An administrator needs onboarding and has a connected source, but Discord is unavailable and its context mode is unavailable.
- **When** The user opens the chat-channel step.
- **Then** The page explains, “Discord is not configured for this organization yet.” The Discord action and Continue are disabled.
