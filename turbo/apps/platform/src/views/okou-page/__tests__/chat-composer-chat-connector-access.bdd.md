# Chat composer chat connector access

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [chat-composer-chat-connector-access.test.tsx](chat-composer-chat-connector-access.test.tsx).

## chat-composer-chat-connector-access-001

Original test `Directory permissions preserve connector-wide rules and disabled accounts with personal mode false`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-chat-connector-access.test.tsx#L345).

- **Given** GitHub has two accounts, both initially disabled, with connector-wide permissions available. The chat runs in multi-agent mode.
- **When** The user denies the repos|write permission in the directory and applies the change, then reopens GitHub access and its permissions.
- **Then** Both account switches remain off, the directory editor states that its rules apply across chats and accounts, and repos|write remains denied. Closing the editor restores focus to the Connectors control.
- **Upstream change** `4e5707de` (#49556) makes the single-agent (My Okou) mode permanent, so the multi-agent variant this scenario pins no longer exists; the upstream test is now `Directory permissions preserve connector-wide rules and disabled accounts` ([Registration](https://github.com/okou-ai/okou/blob/4e5707de3e/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-chat-connector-access.test.tsx#L352)), with no mode parameter. Rebuild this scenario without the multi-agent precondition; the permission, account-switch and focus expectations are unchanged.

## chat-composer-chat-connector-access-002

Original test `Directory permissions preserve connector-wide rules and disabled accounts with personal mode true`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-chat-connector-access.test.tsx#L345).

- **Given** GitHub has two accounts, both initially disabled, with connector-wide permissions available. The chat runs in single-agent mode.
- **When** The user denies the repos|write permission in the directory and applies the change, then reopens GitHub access and its permissions.
- **Then** Both account switches remain off, the directory editor states that its rules apply across chats and accounts, and repos|write remains denied. Closing the editor restores focus to the Connectors control.

## chat-composer-chat-connector-access-003

Original test `Account navigation retains computer controls, Remote access and Add connectors`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-chat-connector-access.test.tsx#L413).

- **Given** The chat has an enabled Work account, an enabled cloud browser, and an enabled SSH host named Build host.
- **When** The user opens Connectors, visits Remote access, closes it, reopens Connectors, and chooses Add connectors.
- **Then** The Connectors panel shows the Work access switch, cloud browser control, computer section, and Connect my computer control. Remote access shows the SSH Build host control; closing it restores focus to Connectors, and Add connectors opens connector discovery.

## chat-composer-chat-connector-access-004

Original test `Directory details omit unavailable permission configuration`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-chat-connector-access.test.tsx#L471).

- **Given** GitHub is connected, but its directory entry has no permission configuration available.
- **When** The user opens GitHub details in connector discovery.
- **Then** The details omit both Permissions and Configure.

## chat-composer-chat-connector-access-005

Original test `Connect an account without Agent authorization, custom=false`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-chat-connector-access.test.tsx#L487).

- **Given** A public built-in connector named Public Tools requires no credentials, and the agent's connector settings cannot be updated.
- **When** The user connects Public Tools from connector discovery and opens its access menu.
- **Then** The access submenu has a checked switch, and the connector row does not show an account count or enabled status. A public connection request is made without agent authorization.
- **Upstream change** `8622b04a` (#49545) retires agent-scoped connector settings; the test is now `Connect and enable a no-auth account in Chat, custom=%s` and no longer configures a failing agent connector update, so the Given's unavailable agent settings no longer apply.

## chat-composer-chat-connector-access-006

Original test `Connect an account without Agent authorization, custom=true`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-chat-connector-access.test.tsx#L487).

- **Given** A public custom connector named Public Custom requires no credentials, and the agent's connector settings cannot be updated.
- **When** The user selects Custom in connector discovery, starts connecting Public Custom, confirms Connect, and opens its access menu.
- **Then** The access submenu has a checked switch, and the connector row does not show an account count or enabled status. No public built-in connection request is made.
- **Upstream change** `8622b04a` (#49545) retires agent-scoped connector settings; the test is now `Connect and enable a no-auth account in Chat, custom=%s` and no longer configures a failing agent connector update, so the Given's unavailable agent settings no longer apply.

## chat-composer-chat-connector-access-007

Original test `Finish a saved Chat allowance after closing and reopening its menu`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-chat-connector-access.test.tsx#L568).

- **Given** GitHub has two accounts, and Work access is initially enabled.
- **When** The user turns Work access off, closes the menu while its save is pending, and reopens the menu before the save response arrives.
- **Then** The reopened row still shows two accounts and Work appears enabled while the save is pending. When the response arrives, Work appears disabled.

## chat-composer-chat-connector-access-008

Original test `Release a pending account save and its cached state when leaving the Chat`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-chat-connector-access.test.tsx#L600).

- **Given** GitHub has two enabled accounts in a new-chat composer, and a Work access save is pending.
- **When** The user leaves the composer for a new chat before the save responds, then allows the pending response to finish.
- **Then** Leaving the chat aborts the pending request. In the new-chat composer, both Work and Personal access are enabled.
- **Upstream change** `4e5707de` (#49556) removes the chat list header's New chat button and moves the new-chat composer from `/agents/<agentId>/chat` to `/`; the upstream test is now `Release a pending account save and its cached state when leaving the Chat` ([Registration](https://github.com/okou-ai/okou/blob/4e5707de3e/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-chat-connector-access.test.tsx#L586)). Rebuild this scenario by leaving through the New chat link at the top of the chat list and expecting the path `/` when the pending save is aborted.

## chat-composer-chat-connector-access-009

Original test `Persist explicit per-account switches across menu reopening`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-chat-connector-access.test.tsx#L633).

- **Given** GitHub has two enabled accounts, Work and Personal.
- **When** The user turns Personal access off, closes and reopens the menu, turns it back on, and closes the menu again.
- **Then** Personal remains off after reopening, then is on after being turned back on. The connector row continues to show two accounts.

## chat-composer-chat-connector-access-010

Original test `Edit GitHub permissions with all accounts off and keep account access off`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-chat-connector-access.test.tsx#L659).

- **Given** GitHub has two accounts, both disabled, and connector-wide permission editing is available.
- **When** The user denies repos|write, applies the permission change, and reopens the access and permissions panels.
- **Then** Both account switches remain off, the connector row shows two accounts, and repos|write is saved as denied.

## chat-composer-chat-connector-access-011

Original test `Manage GitHub accounts directly from Chat without losing the draft`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-chat-connector-access.test.tsx#L713).

- **Given** GitHub has a Work account, no permission configuration, and the composer contains the draft “Use my personal GitHub account.”
- **When** The user opens Manage accounts from the chat and closes the account manager.
- **Then** The account manager shows Work and Add account. The chat path and draft remain unchanged, closing the dialog returns focus to Connectors, and Work access remains enabled when the menu is reopened.

## chat-composer-chat-connector-access-012

Original test `Manage Acme accounts directly from Chat without losing the draft`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-chat-connector-access.test.tsx#L713).

- **Given** Acme has a Work account, no permission configuration, and the composer contains the draft “Use my personal GitHub account.”
- **When** The user opens Manage accounts from the chat and closes the account manager.
- **Then** The account manager shows Work and Add account. The chat path and draft remain unchanged, closing the dialog returns focus to Connectors, and Work access remains enabled when the menu is reopened.

## chat-composer-chat-connector-access-013

Original test `Transfer the GitHub account manager between Chat panes with one dialog and the correct focus return`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-chat-connector-access.test.tsx#L765).

- **Given** Two chat panes are open, and GitHub has a Work account.
- **When** The user opens GitHub's account manager from each pane in sequence, returning to the first pane between openings, and closes each dialog.
- **Then** Each opening shows exactly one Manage GitHub accounts dialog with Work listed. Closing it returns focus to that pane's Connectors control.

## chat-composer-chat-connector-access-014

Original test `Transfer the Acme account manager between Chat panes with one dialog and the correct focus return`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-chat-connector-access.test.tsx#L765).

- **Given** Two chat panes are open, and Acme has a Work account.
- **When** The user opens Acme's account manager from each pane in sequence, returning to the first pane between openings, and closes each dialog.
- **Then** Each opening shows exactly one Manage Acme accounts dialog with Work listed. Closing it returns focus to that pane's Connectors control.

## chat-composer-chat-connector-access-015

Original test `Reconnect the reviewed Chat account when its connector is outside directory discovery`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-chat-connector-access.test.tsx#L805).

- **Given** A reviewed GitHub account is outside connector-directory discovery, and its scope review reports an added read:user scope.
- **When** The user reviews the account's permissions and chooses Reconnect.
- **Then** A GitHub reconnect dialog opens with a visible Reconnect control.

## chat-composer-chat-connector-access-016

Original test `Preserve the internally resolved account when enabling several accounts before the first Run`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-chat-connector-access.test.tsx#L835).

- **Given** A new chat starts with both GitHub accounts disabled.
- **When** The user enables Personal first and Work second, then sends “Use my personal GitHub account” as the first run.
- **Then** The first run uses Personal as the resolved account, and both account switches remain enabled in the resulting chat.
- **Upstream change** `4e5707de` (#49556) moves the new-chat composer from `/agents/<agentId>/chat` to `/` (the old path now only redirects there); the upstream test is now `Preserve the internally resolved account when enabling several accounts before the first Run` ([Registration](https://github.com/okou-ai/okou/blob/4e5707de3e/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-chat-connector-access.test.tsx#L827)). Rebuild this scenario starting the new chat at `/`.

## chat-composer-chat-connector-access-017

Original test `Initialize new Chat access before first Run, including selection retry=false`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-chat-connector-access.test.tsx#L879).

- **Given** A new chat starts with Work enabled and Personal disabled; selecting the current account succeeds.
- **When** The user enables Personal, disables Work, and sends “Use my personal GitHub account” as the first run.
- **Then** The first run starts only after Personal is enabled and selected. In the resulting chat, Personal is enabled, Work is disabled, and the connector row shows two accounts.
- **Upstream change** `4e5707de` (#49556) moves the new-chat composer from `/agents/<agentId>/chat` to `/` (the old path now only redirects there); the upstream test is now `Initialize new Chat access before first Run, including selection retry=%s` ([Registration](https://github.com/okou-ai/okou/blob/4e5707de3e/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-chat-connector-access.test.tsx#L871)). Rebuild this scenario starting the new chat at `/`.

## chat-composer-chat-connector-access-018

Original test `Initialize new Chat access before first Run, including selection retry=true`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-chat-connector-access.test.tsx#L879).

- **Given** A new chat starts with Work enabled and Personal disabled; the first attempt to save the selected account is rejected.
- **When** The user enables Personal, disables Work, and sends “Use my personal GitHub account.” After the account-save error, the user sends the retained draft again.
- **Then** The first attempt shows “Account access could not be saved” and keeps the draft and new-chat path. The retry starts with Personal enabled and selected; afterward Personal remains enabled, Work remains disabled, and the connector row shows two accounts.
- **Upstream change** `4e5707de` (#49556) moves the new-chat composer from `/agents/<agentId>/chat` to `/` (the old path now only redirects there); the upstream test is now `Initialize new Chat access before first Run, including selection retry=%s` ([Registration](https://github.com/okou-ai/okou/blob/4e5707de3e/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-chat-connector-access.test.tsx#L871)). Rebuild this scenario starting the new chat at `/`; after the account-save error the retained draft stays on `/`.
