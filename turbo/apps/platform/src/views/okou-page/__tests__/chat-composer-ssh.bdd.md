# Chat composer ssh

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [chat-composer-ssh.test.tsx](chat-composer-ssh.test.tsx).

## chat-composer-ssh-001

Original test `Disabling an SSH host preserves the oth…`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-ssh.test.tsx#L173).

- **Given** A chat has two SSH hosts: host 1 defaults on and host 2 defaults off.
- **When** The user turns host 1 off.
- **Then** Host 1 shows Off while host 2 remains Default (Off), without creating a host 2 override. Reopening shows 0 enabled.

## chat-composer-ssh-002

Original test `Enabling an SSH host preserves the othe…`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-ssh.test.tsx#L173).

- **Given** A chat has two SSH hosts: host 1 defaults on but has an off override, and host 2 defaults off.
- **When** The user turns host 2 on.
- **Then** Host 1 remains Off and host 2 shows On, without changing host 1's off override. Reopening shows 1 enabled.

## chat-composer-ssh-003

Original test `A chat can restore multiple SSH host defaults independently`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-ssh.test.tsx#L202).

- **Given** A chat has two SSH hosts with overrides: host 1 is off and host 2 is on, despite their defaults of on and off.
- **When** The user restores host 1 to Default (On).
- **Then** Host 1 returns to its default and loses its override, while host 2 remains On with its override. Reopening shows 2 enabled.

## chat-composer-ssh-004

Original test `Remote host choices stay read-only across responsive remount and reopen until a save completes`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-ssh.test.tsx#L217).

- **Given** A chat has two SSH hosts, and saving a changed host choice is pending.
- **When** The user turns host 1 off, changes the viewport, closes and reopens Remote access, and tries to change host 2 before the save completes.
- **Then** Both choices remain read-only across remount and reopen, and host 2 cannot be changed. After the save completes, host 1 shows Off and host 2 Default (Off), both become editable, and focus remains on host 2; the user can then turn host 2 on.

## chat-composer-ssh-005

Original test `Remote access stays open while a changed chat host refreshes`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-ssh.test.tsx#L277).

- **Given** A chat has two SSH hosts, both defaulting off.
- **When** The user turns host 1 on while the host list refresh is delayed.
- **Then** Remote access remains open with both hosts visible and host 2 enabled for editing; host 1 temporarily still shows Default (Off). After refresh, host 1 shows On, the dialog stays open, and reopening shows 1 enabled.

## chat-composer-ssh-006

Original test `A chat can enable multiple VNC hosts independently`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-ssh.test.tsx#L368).

- **Given** A chat has two VNC hosts, both defaulting off.
- **When** The user turns each host on independently.
- **Then** Each host shows On without disabling the other, and reopening shows 2 enabled.

## chat-composer-ssh-007

Original test `Remote access is absent when no SSH or VNC hosts are configured`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-ssh.test.tsx#L471).

- **Given** An existing chat has no SSH or VNC hosts configured.
- **When** The user opens the Connectors menu.
- **Then** Remote access is absent.

## chat-composer-ssh-008

Original test `A new chat has no remote access menu when no hosts are configured`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-ssh.test.tsx#L497).

- **Given** A new chat has no SSH or VNC hosts configured.
- **When** The user opens the Connectors menu.
- **Then** Remote access is absent.

## chat-composer-ssh-009

Original test `A new chat leaves host defaults untouched when no choice is changed`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-ssh.test.tsx#L517).

- **Given** A new chat has one SSH host that defaults on, and the user has not changed its choice.
- **When** The user sends the first message.
- **Then** The thread is created with no initial remote access overrides; the host default remains untouched.
- **Upstream change** `4e5707de` (#49556) moves the new-chat composer from `/agents/<agentId>/chat` to `/` (the old path now only redirects there); the upstream test is now `A new chat leaves host defaults untouched when no choice is changed` ([Registration](https://github.com/okou-ai/okou/blob/4e5707de3e/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-ssh.test.tsx#L517)). Rebuild this scenario starting the new chat at `/`.

## chat-composer-ssh-010

Original test `Remote access remains visible when host discovery fails`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-ssh.test.tsx#L551).

- **Given** A new chat cannot load host discovery because the service returns an error.
- **When** The user opens Remote access.
- **Then** The menu remains visible with “Couldn't load remote access.” and an alert; the private service error is not displayed.

## chat-composer-ssh-011

Original test `Remote access displays a failed chat permission read`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-ssh.test.tsx#L572).

- **Given** An existing chat has an SSH host, but reading its chat-specific remote access permissions fails.
- **When** The user opens Remote access.
- **Then** The menu displays “Couldn't load remote access.” and an alert; the private service error is not displayed.

## chat-composer-ssh-012

Original test `Pending SSH choices survive reopen from a desktop viewport`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-ssh.test.tsx#L654).

- **Given** A new chat has two SSH hosts, defaulting on and off respectively, and the viewport is desktop-sized.
- **When** The user changes host 1 to Off, closes and reopens Remote access, then restores host 1 to Default (On).
- **Then** The pending choice survives closing and reopening, and restoring the default is reflected. The dialog states choices apply when the first message is sent.

## chat-composer-ssh-013

Original test `Pending SSH choices survive reopen from a narrow viewport`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-ssh.test.tsx#L654).

- **Given** A new chat has two SSH hosts, defaulting on and off respectively, and the viewport is narrow.
- **When** The user changes host 1 to Off, closes and reopens Remote access, then restores host 1 to Default (On).
- **Then** The pending choice survives closing and reopening, and restoring the default is reflected. The dialog states choices apply when the first message is sent.

## chat-composer-ssh-014

Original test `Apply SSH host choices during thread creation`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-ssh.test.tsx#L691).

- **Given** A new chat has two SSH hosts, defaulting on and off respectively.
- **When** The user sets host 1 to Off and host 2 to On, then sends the first message.
- **Then** The created thread receives initial overrides in host order: host 1 disabled, then host 2 enabled.

## chat-composer-ssh-015

Original test `Remote access in two chat panes reads and updates each pane's thread`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-ssh.test.tsx#L723).

- **Given** Two chat panes are open. A shared SSH host is overridden on in the Scout chat and defaults off in the other chat.
- **When** The user opens Remote access in each pane and turns the host on in the other chat.
- **Then** The Scout pane shows On; the other pane initially shows Default (Off), then On. Only the other chat receives an enabled update, and the Scout override remains on.

## chat-composer-ssh-016

Original test `Chat SSH setup respects hosts=0`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-ssh.test.tsx#L836).

- **Given** No SSH connections are configured for a new chat.
- **When** The user opens Add connectors.
- **Then** Manage SSH hosts is available. Following it and choosing Add connection opens the remote connection form at /connectors with the SSH setup query parameters.

## chat-composer-ssh-017

Original test `Chat SSH setup respects hosts=1`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-ssh.test.tsx#L836).

- **Given** One SSH connection is configured for a new chat.
- **When** The user opens Add connectors.
- **Then** Manage SSH hosts is not offered; the user remains on the chat page with no setup query parameters.

## chat-composer-ssh-018

Original test `Directory SSH setup follows shelves and categories`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-ssh.test.tsx#L877).

- **Given** A new chat has an empty SSH setup and a connector directory with five productivity connectors.
- **When** The user browses Remote access, switches to Custom and then Discover, selects All, and chooses Manage SSH hosts.
- **Then** The Custom view reports no custom connectors and has no Manage SSH hosts link; Discover and All show the link. Choosing it opens the remote connection form at /connectors with the SSH setup query parameters.
- **Upstream change** `4e5707de` (#49556) moves the new-chat composer from `/agents/<agentId>/chat` to `/` (the old path now only redirects there); the upstream test is now `Directory SSH setup follows shelves and categories` ([Registration](https://github.com/okou-ai/okou/blob/4e5707de3e/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-ssh.test.tsx#L880)). Rebuild this scenario starting the new chat at `/`; Manage SSH hosts still opens `/connectors` with the SSH setup query.
