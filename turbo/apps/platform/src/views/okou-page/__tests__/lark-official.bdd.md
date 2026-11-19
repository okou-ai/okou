# Lark official

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [lark-official.test.tsx](lark-official.test.tsx).

## lark-official-001

Original test `official Lark connection > keeps the Official entry hidden until the feature is enabled`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/lark-official.test.tsx#L43).

- **Given** The custom Lark integration is available, but the Official Lark feature is disabled.
- **When** The Lark settings page loads.
- **Then** The Okou Official entry is hidden and Add bot is available.

## lark-official-002

Original test `official Lark connection > shows a disabled Connect while the new app is not configured`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/lark-official.test.tsx#L49).

- **Given** The Official Lark feature is enabled, but the Official app is not configured.
- **When** The Lark settings page loads.
- **Then** The Okou Official entry shows a disabled Connect button and no links.

## lark-official-003

Original test `official Lark connection > opens Official authorization without entering the custom setup wizard`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/lark-official.test.tsx#L60).

- **Given** The Official Lark app is configured, and the custom bot setup is available.
- **When** The user selects Connect for Okou Official.
- **Then** The browser opens the authorization URL in a new tab. The Add bot link remains available, and the custom App secret field is not shown.

## lark-official-004

Original test `official Lark connection > disconnects the current Official account through its options menu`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/lark-official.test.tsx#L90).

- **Given** Okou Official is connected as Official User.
- **When** The user opens its options, dismisses the menu with Escape, then reopens it with Enter and selects Disconnect.
- **Then** The menu closes and focus returns to the options control after Escape. After disconnection, Connect is enabled and Add bot remains available.

## lark-official-005

Original test `official Lark connection > offers Official Connect independently of custom bot setup`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/lark-official.test.tsx#L126).

- **Given** The Official Lark feature is enabled while the custom Lark integration is disabled, and the Official app is configured.
- **When** The Lark settings page loads.
- **Then** Okou Official has an enabled Connect button, and Add bot is absent.

## lark-official-006

Original test `official Lark connection > explains how to continue when the browser blocks the authorization tab`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/lark-official.test.tsx#L142).

- **Given** The Official Lark app is configured, but the browser blocks opening an authorization tab.
- **When** The user selects Connect for Okou Official.
- **Then** The page explains, “Allow pop-ups to connect your Lark account.” Connect remains enabled.
