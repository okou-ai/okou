# Chat composer add menu

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [chat-composer-add-menu.test.tsx](chat-composer-add-menu.test.tsx).

## chat-composer-add-menu-001

Original test `groups attachment, template, capability and import skills actions in the add menu`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-add-menu.test.tsx#L73).

- **Given** The user is viewing the chat composer.
- **When** The user opens the Add menu.
- **Then** The menu groups the actions in this order: Attach, Template, Find people, Research, Create, Workflow, and Import skills.

## chat-composer-add-menu-002

Original test `opens the import skills dialog from the add menu`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-add-menu.test.tsx#L87).

- **Given** The user is viewing the chat composer with the Add menu open.
- **When** The user chooses Import skills and then follows the View workflows link.
- **Then** The Import your skills dialog appears with a Copy prompt button. Following View workflows navigates to /workflows and closes the dialog.

## chat-composer-add-menu-003

Original test `opens the template picker from the add menu`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-add-menu.test.tsx#L120).

- **Given** The user is viewing the chat composer with a presentation template available.
- **When** The user chooses Template from the Add menu.
- **Then** The template picker opens and the first presentation template can be found by its selection label.

## chat-composer-add-menu-004

Original test `attaches the chosen file from the attach row`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-add-menu.test.tsx#L141). · **intent review**

- **Given** The user is viewing the chat composer with the Add menu open.
- **When** The user chooses Attach and selects a text file named brief.txt after the menu closes.
- **Then** The composer displays brief.txt and provides a Remove brief.txt control.
