# Integrations feishu

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [integrations-feishu.test.tsx](integrations-feishu.test.tsx).

## integrations-feishu-001

Original test `feishu integration UI > An organization admin can start guided Feishu bot setup`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/integrations-feishu.test.tsx#L86).

- **Given** An organization admin is viewing integrations with Feishu enabled.
- **When** They open Feishu settings and choose Add bot.
- **Then** The guided setup shows Agent app creation instructions, an optional downloadable Okou icon, and a Next step for entering App ID and App Secret. No Verification Token field is shown yet.

## integrations-feishu-002

Original test `feishu integration UI > Feishu credentials validate before advancing with Enter`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/integrations-feishu.test.tsx#L134).

- **Given** A user has opened Feishu bot setup and entered an available App ID and a nonblank App Secret.
- **When** They advance from the credentials step by pressing Enter.
- **Then** The credentials are checked and the fields and Back action are disabled while checking. After the check completes, the Verification Token step appears with Verify and continue disabled. Going back preserves both credentials, returns to the guide, and Cancel returns to the Feishu bots heading.

## integrations-feishu-003

Original test `feishu integration UI > Feishu credentials validate before advancing with click`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/integrations-feishu.test.tsx#L134).

- **Given** A user has opened Feishu bot setup and entered an available App ID and a nonblank App Secret.
- **When** They advance from the credentials step by clicking Next.
- **Then** The credentials are checked and the fields and Back action are disabled while checking. After the check completes, the Verification Token step appears with Verify and continue disabled. Going back preserves both credentials, returns to the guide, and Cancel returns to the Feishu bots heading.

## integrations-feishu-004

Original test `feishu integration UI > Guided Feishu setup connects the admin through OAuth`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/integrations-feishu.test.tsx#L194).

- **Given** An admin is creating a new Feishu bot with valid credentials and verification details.
- **When** They complete the guided setup, wait for callback verification, and choose Done after reaching app publication.
- **Then** The setup submits the entered credentials and marks the installation complete. While completion is pending, Back and Done are disabled; afterward, success is shown and the browser opens the OAuth connection URL with callbackTarget=app.

## integrations-feishu-005

Original test `feishu integration UI > Feishu appears when enabled and shows a connected bot`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/integrations-feishu.test.tsx#L303).

- **Given** Feishu is enabled and a connected Feishu bot has a name, avatar, and connected user.
- **When** The user opens Feishu settings from integrations and views bot options.
- **Then** Feishu is listed with message-routing information, and settings show the bot avatar and connected user. Add bot and Manage are absent, while Uninstall is available.
- **Batch 75 main synchronization** [Member-flow change #49854](https://github.com/okou-ai/okou/pull/49854). The Feishu card still opens the connected bot, account and uninstall options. The routing description was removed from Works. The original routing-information clause failed in the post-sync suite.

## integrations-feishu-006

Original test `feishu integration UI > Feishu keeps a pending uninstall open and allows retry after failure`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/integrations-feishu.test.tsx#L354).

- **Given** A Feishu bot is installed, and its first uninstall attempt will fail.
- **When** The user confirms uninstall, tries Escape while the request is pending, then retries after the failure.
- **Then** The pending dialog stays open and its Cancel and uninstall actions are disabled. After failure, an error is shown and uninstall is enabled again; the retry succeeds, closes the dialog, and enables Add bot.

## integrations-feishu-007

Original test `feishu integration UI > Reviewing a Feishu bot guide never connects`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/integrations-feishu.test.tsx#L407).

- **Given** An admin has an installed, completed Feishu bot that is not connected.
- **When** They open its Review guide, advance through the guide, and choose Done.
- **Then** The guide shows the configured credentials as disabled and presents the setup steps through app publication. It returns to Feishu settings without opening a browser or connecting the account.

## integrations-feishu-008

Original test `feishu integration UI > A connected Feishu user can disconnect only their own account`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/integrations-feishu.test.tsx#L500).

- **Given** A connected non-admin user views options for their Feishu bot.
- **When** They open the bot's options.
- **Then** Disconnect is available, while Review guide, Manage, and Uninstall are absent.

## integrations-feishu-009

Original test `feishu integration UI > Direct Feishu settings require Feishu to be enabled`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/integrations-feishu.test.tsx#L544).

- **Given** Feishu is disabled and a user navigates directly to Feishu settings.
- **When** The settings page loads.
- **Then** The user is redirected to the home agent chat, and the Feishu bots heading is absent.
- **Upstream change** `4e5707de` (#49556) makes Home (`/`) the chat page itself instead of redirecting to the default agent's `/agents/:agentId/chat`; the upstream test is now `Direct ${provider.name} settings require ${provider.name} to be enabled` ([Registration](https://github.com/okou-ai/okou/blob/4e5707de3e/turbo/apps/platform/src/views/okou-page/__tests__/integrations-feishu.test.tsx#L543)), which expects the redirect to end at `/`. Rebuild this scenario expecting the user to land on Home (`/`) with the Feishu bots heading absent.

## integrations-feishu-010

Original test `feishu integration UI > A member cannot manage an incomplete Feishu bot`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/integrations-feishu.test.tsx#L557).

- **Given** A non-admin member has an installed Feishu bot whose setup is incomplete.
- **When** They open Feishu settings.
- **Then** The bot is marked Setup incomplete. Add bot, Connect, and the bot's options are unavailable.

## integrations-feishu-011

Original test `feishu integration UI > Feishu setup advances when callback verification arrives`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/integrations-feishu.test.tsx#L598).

- **Given** An admin is managing an incomplete Feishu setup whose OAuth redirect URL and callback URL have not yet arrived.
- **When** The callback verification updates arrive during setup.
- **Then** The redirect and callback URLs populate as read-only values and can be copied. The setup waits for callback verification; once verified, it reports Feishu connected successfully, enables Next, and permits advancing to app publication.

## integrations-feishu-012

Original test `feishu integration UI > A workspace member can connect to a completed Feishu bot`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/integrations-feishu.test.tsx#L702).

- **Given** A workspace member views an installed, completed Feishu bot that is not connected.
- **When** They choose Connect.
- **Then** The browser opens the bot's connection URL with callbackTarget=app in a new tab, and the bot's options are unavailable.

## integrations-feishu-013

Original test `feishu integration UI > A Feishu App ID already registered in Okou cannot be reused`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/integrations-feishu.test.tsx#L757).

- **Given** An admin starts adding a Feishu bot and enters an App ID already registered in Okou with a valid secret.
- **When** They submit the credentials, then replace the App ID with an available one and submit again.
- **Then** The registered ID produces an already-registered error and does not advance to Verification Token. The available ID advances to Verification Token.

## integrations-feishu-014

Original test `lark integration UI > An organization admin can start guided Lark bot setup`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/integrations-feishu.test.tsx#L86).

- **Given** An organization admin is viewing integrations with Lark enabled.
- **When** They open Lark settings and choose Add bot.
- **Then** The guided setup shows Agent app creation instructions, an optional downloadable Okou icon, and a Next step for entering App ID and App Secret. No Verification Token field is shown yet.

## integrations-feishu-015

Original test `lark integration UI > Lark credentials validate before advancing with Enter`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/integrations-feishu.test.tsx#L134).

- **Given** A user has opened Lark bot setup and entered an available App ID and a nonblank App Secret.
- **When** They advance from the credentials step by pressing Enter.
- **Then** The credentials are checked and the fields and Back action are disabled while checking. After the check completes, the Verification Token step appears with Verify and continue disabled. Going back preserves both credentials, returns to the guide, and Cancel returns to the Lark bots heading.

## integrations-feishu-016

Original test `lark integration UI > Lark credentials validate before advancing with click`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/integrations-feishu.test.tsx#L134).

- **Given** A user has opened Lark bot setup and entered an available App ID and a nonblank App Secret.
- **When** They advance from the credentials step by clicking Next.
- **Then** The credentials are checked and the fields and Back action are disabled while checking. After the check completes, the Verification Token step appears with Verify and continue disabled. Going back preserves both credentials, returns to the guide, and Cancel returns to the Lark bots heading.

## integrations-feishu-017

Original test `lark integration UI > Guided Lark setup connects the admin through OAuth`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/integrations-feishu.test.tsx#L194).

- **Given** An admin is creating a new Lark bot with valid credentials and verification details.
- **When** They complete the guided setup, wait for callback verification, and choose Done after reaching app publication.
- **Then** The setup submits the entered credentials and marks the installation complete. While completion is pending, Back and Done are disabled; afterward, success is shown and the browser opens the OAuth connection URL with callbackTarget=app.

## integrations-feishu-018

Original test `lark integration UI > Lark appears when enabled and shows a connected bot`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/integrations-feishu.test.tsx#L303).

- **Given** Lark is enabled and a connected Lark bot has a name, avatar, and connected user.
- **When** The user opens Lark settings from integrations and views bot options.
- **Then** Lark is listed with message-routing information, and settings show the bot avatar and connected user. Add bot and Manage are absent, while Uninstall is available.
- **Batch 75 main synchronization** [Member-flow change #49854](https://github.com/okou-ai/okou/pull/49854). The Lark card still opens the connected bot, account and uninstall options. The routing description was removed from Works. The original routing-information clause failed in the post-sync suite.

## integrations-feishu-019

Original test `lark integration UI > Lark keeps a pending uninstall open and allows retry after failure`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/integrations-feishu.test.tsx#L354).

- **Given** A Lark bot is installed, and its first uninstall attempt will fail.
- **When** The user confirms uninstall, tries Escape while the request is pending, then retries after the failure.
- **Then** The pending dialog stays open and its Cancel and uninstall actions are disabled. After failure, an error is shown and uninstall is enabled again; the retry succeeds, closes the dialog, and enables Add bot.

## integrations-feishu-020

Original test `lark integration UI > Reviewing a Lark bot guide never connects`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/integrations-feishu.test.tsx#L407).

- **Given** An admin has an installed, completed Lark bot that is not connected.
- **When** They open its Review guide, advance through the guide, and choose Done.
- **Then** The guide shows the configured credentials as disabled and presents the setup steps through app publication. It returns to Lark settings without opening a browser or connecting the account.

## integrations-feishu-021

Original test `lark integration UI > A connected Lark user can disconnect only their own account`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/integrations-feishu.test.tsx#L500).

- **Given** A connected non-admin user views options for their Lark bot.
- **When** They open the bot's options.
- **Then** Disconnect is available, while Review guide, Manage, and Uninstall are absent.

## integrations-feishu-022

Original test `lark integration UI > Direct Lark settings require Lark to be enabled`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/integrations-feishu.test.tsx#L544).

- **Given** Lark is disabled and a user navigates directly to Lark settings.
- **When** The settings page loads.
- **Then** The user is redirected to the home agent chat, and the Lark bots heading is absent.

## integrations-feishu-023

Original test `lark integration UI > A member cannot manage an incomplete Lark bot`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/integrations-feishu.test.tsx#L557).

- **Given** A non-admin member has an installed Lark bot whose setup is incomplete.
- **When** They open Lark settings.
- **Then** The bot is marked Setup incomplete. Add bot, Connect, and the bot's options are unavailable.

## integrations-feishu-024

Original test `lark integration UI > Lark setup advances when callback verification arrives`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/integrations-feishu.test.tsx#L598).

- **Given** An admin is managing an incomplete Lark setup whose OAuth redirect URL and callback URL have not yet arrived.
- **When** The callback verification updates arrive during setup.
- **Then** The redirect and callback URLs populate as read-only values and can be copied. The setup waits for callback verification; once verified, it reports Lark connected successfully, enables Next, and permits advancing to app publication.

## integrations-feishu-025

Original test `lark integration UI > A workspace member can connect to a completed Lark bot`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/integrations-feishu.test.tsx#L702).

- **Given** A workspace member views an installed, completed Lark bot that is not connected.
- **When** They choose Connect.
- **Then** The browser opens the bot's connection URL with callbackTarget=app in a new tab, and the bot's options are unavailable.

## integrations-feishu-026

Original test `lark integration UI > A Lark App ID already registered in Okou cannot be reused`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/integrations-feishu.test.tsx#L757).

- **Given** An admin starts adding a Lark bot and enters an App ID already registered in Okou with a valid secret.
- **When** They submit the credentials, then replace the App ID with an available one and submit again.
- **Then** The registered ID produces an already-registered error and does not advance to Verification Token. The available ID advances to Verification Token.
