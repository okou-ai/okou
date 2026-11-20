# Composer task chips

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [composer-task-chips.test.tsx](composer-task-chips.test.tsx).

## composer-task-chips-001

Original test `A creation type can be removed without losing the draft`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/composer-task-chips.test.tsx#L92).

- **Given** The user has a draft and has selected Presentation as a creation type.
- **When** They remove the Presentation selection.
- **Then** Presentation is removed and the draft remains unchanged.

## composer-task-chips-002

Original test `A send carries the task and its slide count into the thread it opens`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/composer-task-chips.test.tsx#L106).

- **Given** The user selects Presentation and chooses 16–20 slides.
- **When** They send a launch-deck prompt.
- **Then** The message includes the 16–20 slide setting, and the opened thread retains Presentation and the selected slide count.

## composer-task-chips-003

Original test `Chart preferences are interactive and are sent as agent-only context`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/composer-task-chips.test.tsx#L128).

- **Given** The user selects Chart and enters a prompt.
- **When** They toggle Website output off and back on, select Bar chart and Sankey diagram, and send.
- **Then** The prompt is sent, with website and bar, sankey preferences included as additional context.

## composer-task-chips-004

Original test `Chart defaults to report when no output format is selected`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/composer-task-chips.test.tsx#L170).

- **Given** The user selects Chart without choosing an output format.
- **When** They send a chart prompt.
- **Then** The additional context specifies report as the preferred output format.

## composer-task-chips-005

Original test `Image enters and submits the create mode`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/composer-task-chips.test.tsx#L189).

- **Given** The user enters a prompt and selects Image.
- **When** They send the prompt.
- **Then** The prompt is run with additional context specifying image creation.

## composer-task-chips-006

Original test `Toggling a task off sends the ordinary draft and uploaded file`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/composer-task-chips.test.tsx#L250).

- **Given** The user has a draft and an uploaded brief.txt file, and has selected and configured Image and Presentation before turning the tasks off.
- **When** They send the draft.
- **Then** The ordinary draft and uploaded file are sent, with no additional task context.

## composer-task-chips-007

Original test `Selecting Image from the Presentation catalog updates the task and generation settings`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/composer-task-chips.test.tsx#L290).

- **Given** The user has a draft and selects Presentation as the creation type.
- **When** They choose an Image template from the catalog.
- **Then** Image becomes the selected task, the draft is preserved, the template is attached, and sending uses an illustration template with image-creation instructions and no slide-count control.

## composer-task-chips-008

Original test `Selecting Presentation from the Image catalog updates the task and generation settings`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/composer-task-chips.test.tsx#L290).

- **Given** The user has a draft and selects Image as the creation type.
- **When** They choose a Presentation template from the catalog.
- **Then** Presentation becomes the selected task, the draft is preserved, and sending uses a presentation template with presentation instructions and a slide-count control.

## composer-task-chips-009

Original test `Selecting Website from the Presentation catalog updates the task and generation settings`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/composer-task-chips.test.tsx#L290).

- **Given** The user has a draft and selects Presentation as the creation type.
- **When** They choose a Website template from the catalog.
- **Then** Website becomes the selected task, the draft is preserved, and sending uses a website template without additional task instructions or a slide-count control.

## composer-task-chips-010

Original test `A presentation suggestion inserts a canonical template and preserves the prompt`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/composer-task-chips.test.tsx#L331).

- **Given** The user has entered a prompt and selected Presentation.
- **When** They choose a suggested presentation template and set the slide count to 16–20.
- **Then** The canonical template is attached without replacing the prompt; the slide count starts at 8–12, can be changed to 16–20, and is included when sent.

## composer-task-chips-011

Original test `Browsing the catalog opens the existing library in the matching category`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/composer-task-chips.test.tsx#L376).

- **Given** The user has a draft and opens View all from the Presentation recommendations.
- **When** They inspect and close the catalog.
- **Then** The catalog opens with Presentation selected, and the draft remains unchanged.

## composer-task-chips-012

Original test `Website shows its whole catalog and attaches a template`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/composer-task-chips.test.tsx#L394).

- **Given** The user has a draft and selects Website.
- **When** They browse the Website recommendations and choose a template.
- **Then** More than five recommendations are available, View all is offered, and the selected template is attached while preserving the draft.

## composer-task-chips-013

Original test `Image shows its whole catalog and attaches a template`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/composer-task-chips.test.tsx#L394).

- **Given** The user has a draft and selects Image.
- **When** They browse the Image recommendations and choose a template.
- **Then** More than five recommendations are available, View all is offered, and the selected template is attached while preserving the draft.

## composer-task-chips-014

Original test `The Document catalog pages using its current viewport width`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/composer-task-chips.test.tsx#L414). · **intent review**

- **Given** The Document template rail is displayed in a 400-pixel viewport.
- **When** The user changes its width to 460 pixels and advances, then changes it to 300 pixels and advances again, then goes back.
- **Then** The rail scroll position is 396, then 632, then 396 pixels, respectively.

## composer-task-chips-015

Original test `Advanced workflows carries every recommendation without changing the draft`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/composer-task-chips.test.tsx#L459).

- **Given** The user opens Advanced workflows with an empty draft.
- **When** They inspect the recommendations and enter draft text.
- **Then** All nine recommendations appear in the tested order, the draft is preserved, and no message is sent.

## composer-task-chips-016

Original test `Workflow covers draw their marks without waiting for the full connector catalog`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/composer-task-chips.test.tsx#L485).

- **Given** The Advanced workflows recommendation shelf is shown while the connector catalog request remains pending.
- **When** The workflow covers are rendered.
- **Then** The first recommendation displays three image marks without waiting for the connector catalog response.

## composer-task-chips-017

Original test `View all opens the Workflow template picker and preserves the draft`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/composer-task-chips.test.tsx#L504).

- **Given** The user has entered a draft in Advanced workflows.
- **When** They open View all and close the picker.
- **Then** The Workflow category is selected, Morning brief is available, and the draft remains unchanged with no message sent.

## composer-task-chips-018

Original test `Choosing a workflow prepares an editable request until the user sends`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/composer-task-chips.test.tsx#L522).

- **Given** The user has entered a draft in Advanced workflows.
- **When** They choose “Start your day with a clear plan,” edit the prepared request, and send.
- **Then** The draft remains, the Morning brief template is attached, the editor receives focus for editing, and the sent request identifies the Morning brief workflow.

## composer-task-chips-019

Original test `Reply tracking prepares a custom workflow request without an unrelated template`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/composer-task-chips.test.tsx#L545).

- **Given** The user is viewing Advanced workflows.
- **When** They choose “Catch the reply you’re waiting for” and send the prepared request.
- **Then** A custom request to watch one Gmail conversation is prepared, no message is sent before the user sends, and the sent message has no unrelated template attached.
