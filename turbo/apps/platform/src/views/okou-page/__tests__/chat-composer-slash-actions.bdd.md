# Chat composer slash actions

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [chat-composer-slash-actions.test.tsx](chat-composer-slash-actions.test.tsx).

## chat-composer-slash-actions-001

Original test `The bare slash leads with capabilities and chat actions, then Workflows and Templates with their counts`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-slash-actions.test.tsx#L133).

- **Given** The user is composing a new chat with slash actions enabled and three workflows available.
- **When** They type a bare slash.
- **Then** The first level shows Find people, Research, Create, Workflow, Model, Effort, Connect, Schedule, Workflows 3, and Templates with a count.

## chat-composer-slash-actions-002

Original test `A chat adds the actions on the chat itself`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-slash-actions.test.tsx#L154).

- **Given** The user is composing in an existing chat with slash actions enabled.
- **When** They type a bare slash.
- **Then** The menu includes Rename chat, New chat, Pin chat, and Share chat.

## chat-composer-slash-actions-003

Original test `Pointing at Workflows opens its list beside the first level`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-slash-actions.test.tsx#L164).

- **Given** The user has opened the slash menu on a desktop-sized screen.
- **When** They point at Workflows and select /axiom-status.
- **Then** A Workflows list beside the first level offers New workflow and Manage workflows. The composer contains “Draft /axiom-status,” and the menu closes.

## chat-composer-slash-actions-004

Original test `The keyboard enters the Workflows list and leaves it again`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-slash-actions.test.tsx#L189).

- **Given** The user has opened the slash menu with the keyboard on a desktop-sized screen.
- **When** They navigate to Workflows, enter its list, leave it, then activate the list and select /axiom-status.
- **Then** The active choice moves from Workflows to /axiom-red and back, and the composer remains “Draft /” until selection. It then contains “Draft /axiom-status.”

## chat-composer-slash-actions-005

Original test `Templates opens its types with their counts, and Browse all opens the picker`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-slash-actions.test.tsx#L212).

- **Given** The user has opened the slash menu on a desktop-sized screen.
- **When** They point at Templates and choose Browse all templates.
- **Then** The Templates list includes Presentation, and the template picker opens with a Presentation tab.

## chat-composer-slash-actions-006

Original test `Pointing at Model lists the models beside the first level, and one switches the chat`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-slash-actions.test.tsx#L253).

- **Given** The user has opened the slash menu on a desktop-sized screen, with Claude Fable 5.1 selected.
- **When** They point at Model and choose Claude Sonnet 5.
- **Then** The Model list marks Claude Fable 5.1 as current. The composer model changes to Claude Sonnet 5, the draft remains “Draft,” and the menu closes.

## chat-composer-slash-actions-007

Original test `Pointing at Effort lists its levels, and one sets the chat's effort`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-slash-actions.test.tsx#L282).

- **Given** The user has opened the slash menu on a desktop-sized screen with a model that offers effort levels.
- **When** They point at Effort and choose Low.
- **Then** The composer model shows Claude Fable 5.1, Low.

## chat-composer-slash-actions-008

Original test `Schedule lists how often to run, and a choice writes the request with it`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-slash-actions.test.tsx#L301).

- **Given** The user has opened the slash menu on a desktop-sized screen.
- **When** They open Schedule and choose Every weekday.
- **Then** The composer contains the scheduled automation request with the cadence “every weekday at 9:00,” and the menu closes.

## chat-composer-slash-actions-009

Original test `Custom schedule writes the request without a cadence`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-slash-actions.test.tsx#L324).

- **Given** The user has opened the slash menu on a desktop-sized screen.
- **When** They point at Schedule and choose Custom schedule.
- **Then** The composer contains the automation request without a cadence.

## chat-composer-slash-actions-010

Original test `The keyboard enters an action's choices and leaves them again`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-slash-actions.test.tsx#L344).

- **Given** The user has opened the slash menu and is navigating with the keyboard.
- **When** They enter Schedule’s choices, leave them, then activate the choices and select Every weekday.
- **Then** The active choice moves from Schedule to Every morning and back. The composer then contains the scheduled automation request with the cadence “every weekday at 9:00.”

## chat-composer-slash-actions-011

Original test `On a narrow screen an action's choices replace the first level`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-slash-actions.test.tsx#L368).

- **Given** The user has opened the slash menu on a narrow screen.
- **When** They open Effort and then close it.
- **Then** The effort choices replace the first-level menu, including Low; Model is absent while the choices are open and returns when the user closes them.

## chat-composer-slash-actions-012

Original test `Typing after the slash searches workflows in one list`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-slash-actions.test.tsx#L390).

- **Given** The user has opened the slash menu with workflows available.
- **When** They type “axi” after the slash.
- **Then** The menu becomes a single list containing /axiom-red, with Model absent from the first level.

## chat-composer-slash-actions-013

Original test `With the switch off the overview keeps its workflow rows`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-slash-actions.test.tsx#L403).

- **Given** The slash-actions feature switch is off, and workflows are available.
- **When** The user types a bare slash.
- **Then** The overview retains the workflow row /axiom-red, while Model is absent from the first level.

## chat-composer-slash-actions-014

Original test `Model and Effort stay out when the composer offers no model choice`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-slash-actions.test.tsx#L415).

- **Given** The composer has no model choice available.
- **When** The user types a bare slash.
- **Then** Schedule is present, while Model and Effort are absent.

## chat-composer-slash-actions-015

Original test `Typing after the slash finds a chat action, and Enter runs it`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-slash-actions.test.tsx#L428).

- **Given** The user has opened the slash menu in a new chat.
- **When** They type “sch” after the slash and press Enter.
- **Then** Schedule is the active match under Actions, Model is absent from the first level, and the composer receives the automation request without a cadence. The menu closes.

## chat-composer-slash-actions-016

Original test `A typed command keyword finds the chat's own actions`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-slash-actions.test.tsx#L453).

- **Given** The user has opened the slash menu in an existing chat.
- **When** They type “title” after the slash.
- **Then** Rename chat appears, while actions beginning with Share do not appear in the first level.

## chat-composer-slash-actions-017

Original test `Template counts include the custom templates listed beside the built-in ones`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-slash-actions.test.tsx#L489).

- **Given** The template catalog includes two custom presentation templates and one custom document template, in addition to built-in templates.
- **When** The user opens the Templates list.
- **Then** Presentation and Document counts include those custom templates; Illustration and Website counts reflect their built-in templates only, and the overall count is their sum.

## chat-composer-slash-actions-018

Original test `Effort stays out when the chat model has no effort levels`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-slash-actions.test.tsx#L529).

- **Given** The selected chat model has no effort levels.
- **When** The user types a bare slash.
- **Then** Model is present, but Effort is absent.

## chat-composer-slash-actions-019

Original test `A slash typed in the composer's right half puts the menu at the right edge`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-slash-actions.test.tsx#L541).

- **Given** The composer is 900 pixels wide, and the slash is typed at a position in its right half.
- **When** The user opens the slash menu and navigates to Workflows using the keyboard.
- **Then** The menu opens at the right edge; the workflow list opens to its left, and Left enters it while Right returns to Workflows.

## chat-composer-slash-actions-020

Original test `A slash typed in the composer's left half keeps the menu at the left edge`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-slash-actions.test.tsx#L596).

- **Given** The user types a slash at the composer's left side.
- **When** They open the slash menu.
- **Then** The menu opens at the left edge.
