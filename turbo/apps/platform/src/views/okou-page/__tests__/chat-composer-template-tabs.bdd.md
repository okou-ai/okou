# Chat composer template tabs

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [chat-composer-template-tabs.test.tsx](chat-composer-template-tabs.test.tsx).

## chat-composer-template-tabs-001

Original test `Built-in templates stay usable while custom templates load after switching categories`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-template-tabs.test.tsx#L26).

- **Given** The website template picker is open and the custom-template catalog request has not completed.
- **When** The user switches to Presentation and selects a built-in presentation template.
- **Then** Built-in website and presentation templates remain enabled while custom templates are loading, and the selected presentation template appears in the composer.

## chat-composer-template-tabs-002

Original test `Category arrows select the matching panel and keep focus on the selected tab`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-template-tabs.test.tsx#L108).

- **Given** The template picker is open on the Presentation category.
- **When** The user presses ArrowDown, then ArrowUp in the category list.
- **Then** The Document panel is selected after ArrowDown and the Presentation panel after ArrowUp; focus remains on the selected category tab, with only its matching panel active.

## chat-composer-template-tabs-003

Original test `Mobile category selection selects the matching panel`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-template-tabs.test.tsx#L133).

- **Given** The template picker is open on a mobile device with Presentation selected.
- **When** The user chooses Workflow from the category control.
- **Then** The Workflow panel is selected and the category control displays Workflow.

## chat-composer-template-tabs-004

Original test `Reopening the template picker focuses its current category control`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-template-tabs.test.tsx#L149).

- **Given** The template picker is open on Presentation.
- **When** The user closes it with Escape and opens it again.
- **Then** The reopened picker focuses its current Presentation category control.
