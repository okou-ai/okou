# Integrations lark

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [integrations-lark.test.tsx](integrations-lark.test.tsx).

## integrations-lark-001

Original test `Lark has an independent integration card and guided setup`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/integrations-lark.test.tsx#L30).

- **Given** Lark is enabled and Feishu is disabled.
- **When** The user opens Lark settings, starts adding a bot, and proceeds through the setup steps with App ID cli_lark and an app secret.
- **Then** The integrations page links to Lark settings, where Lark bots and the guided setup appear. The setup links to the Lark developer console and offers the optional Okou icon for download. After the user enters the App ID and secret, the next step asks for an Encrypt Key, and the App ID availability check uses cli_lark.

## integrations-lark-002

Original test `enabling Feishu does not expose Lark`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/integrations-lark.test.tsx#L72).

- **Given** Feishu is enabled and Lark is disabled.
- **When** The user views the integrations page.
- **Then** Feishu is shown, and there is no link to Lark settings.

## integrations-lark-003

Original test `the Lark settings page reads only Lark installations`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/integrations-lark.test.tsx#L90).

- **Given** The user opens Lark settings with Lark enabled and Feishu disabled; the Lark installation response contains no installations.
- **When** The settings page loads its bot information.
- **Then** The page shows Lark bots and requests Lark installation status.
