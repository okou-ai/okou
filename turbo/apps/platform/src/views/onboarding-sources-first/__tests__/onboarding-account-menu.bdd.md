# Onboarding account menu

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [onboarding-account-menu.test.tsx](onboarding-account-menu.test.tsx).

## onboarding-account-menu-001

Original test `Open Model settings from ChatGPT usage in the onboarding account menu using pointer`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-account-menu.test.tsx#L22).

- **Given** An onboarding user has connected ChatGPT and Claude accounts and is viewing the onboarding account menu.
- **When** They activate the ChatGPT usage information with a pointer.
- **Then** Model settings opens to “Use more models,” and the settings URL parameter is `model`. Focus remains within the settings dialog.

## onboarding-account-menu-002

Original test `Open Model settings from Claude usage in the onboarding account menu using Enter`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-account-menu.test.tsx#L22).

- **Given** An onboarding user has connected ChatGPT and Claude accounts and is viewing the onboarding account menu.
- **When** They navigate to Claude usage with the keyboard and activate it with Enter.
- **Then** Model settings opens to “Use more models,” and the settings URL parameter is `model`. Focus remains within the settings dialog.

## onboarding-account-menu-003

Original test `Open Model settings from ChatGPT usage in the onboarding account menu using Space`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-account-menu.test.tsx#L22).

- **Given** An onboarding user has connected ChatGPT and Claude accounts and is viewing the onboarding account menu.
- **When** They navigate to ChatGPT usage with the keyboard and activate it with Space.
- **Then** Model settings opens to “Use more models,” and the settings URL parameter is `model`. Focus remains within the settings dialog.
