# Composer capability menus

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [composer-capability-menus.test.tsx](composer-capability-menus.test.tsx).

## composer-capability-menus-001

Original test `The add menu opens each home capability and restores its own trigger only on dismissal`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/composer-capability-menus.test.tsx#L148).

- **Given** A user has a draft in the home composer.
- **When** They open Add and select each capability, then dismiss the menu with Escape.
- **Then** The menu lists Attach, Template, Find people, Research, Create, Workflow, and Import skills. Each capability opens while preserving the draft and returning focus to the composer; the URL stays on the home chat, and Escape restores focus to the Add button.

## composer-capability-menus-002

Original test `Slash capabilities preserve the draft with SlashActions=false and desktop=true`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/composer-capability-menus.test.tsx#L195).

- **Given** A user is on an existing chat with SlashActions disabled and desktop mode enabled, with a draft followed by “/”.
- **When** They select Find people, Research, Create, and Workflow from the slash menu.
- **Then** The capabilities appear in reverse order, alongside “/daily-recap” and “Browse all templates.” Each selection opens its capability, preserves the draft text with the trailing slash removed, and leaves the chat URL unchanged.

## composer-capability-menus-003

Original test `Slash capabilities preserve the draft with SlashActions=true and desktop=false`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/composer-capability-menus.test.tsx#L195).

- **Given** A user is on the home composer with SlashActions enabled and desktop mode disabled, with a draft followed by “/”.
- **When** They select Find people, Research, Create, and Workflow from the slash menu.
- **Then** The capabilities appear in their normal order, alongside Connect, Workflows 1, and Templates. Each selection opens its capability, preserves the draft text with the trailing slash removed, and leaves the home URL unchanged.

## composer-capability-menus-004

Original test `The Templates browser preserves the draft when opening its picker`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/composer-capability-menus.test.tsx#L236).

- **Given** A user has a draft followed by “/” in the home composer with SlashActions enabled and desktop mode enabled.
- **When** They open the Templates slash-menu entry, select Website, and open Browse all templates.
- **Then** Website is selected, the template picker opens with Presentation selected, and the draft remains with its trailing slash removed.

## composer-capability-menus-005

Original test `Both menus reopen the remembered creation type and workflow kind without toggling them off`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/composer-capability-menus.test.tsx#L263).

- **Given** A user has a draft and has selected Image creation and the Triggers workflow kind, then explored other capabilities.
- **When** They reopen Create and Workflow from both the Add menu and their slash entries.
- **Then** The remembered Image creation and Triggers choices remain selected without toggling off, and the draft remains intact with the slash suffix removed.

## composer-capability-menus-006

Original test `Task handoff stays compact until a menu opens a tray without replacing the conversation`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/composer-capability-menus.test.tsx#L330).

- **Given** A user opens Create on the home composer, sends a prompt, and receives a reply in the resulting conversation.
- **When** They open Find people and then Research while composing a follow-up.
- **Then** The task remains selected, but capability discovery is initially closed. Each newly opened capability appears above the composer without replacing the conversation; the original prompt and reply remain visible, and the conversation URL stays unchanged.

## composer-capability-menus-007

Original test `An earlier send cannot dismiss a capability opened for the next draft`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/composer-capability-menus.test.tsx#L389).

- **Given** A user starts sending a prompt in an existing conversation while Find people is open, then enters a new draft and opens Research before the earlier send finishes.
- **When** The earlier send completes.
- **Then** Research remains open, the new draft remains in the composer, and the existing conversation URL is unchanged.

## composer-capability-menus-008

Original test `A successful send dismisses menu discovery in an existing conversation`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/composer-capability-menus.test.tsx#L417).

- **Given** A user has a draft in an existing conversation and opens Research.
- **When** They successfully send the draft.
- **Then** The prompt appears as a user message, Research closes, and the conversation URL remains unchanged.
