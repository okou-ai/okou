# Chat composer slash custom templates

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [chat-composer-slash-custom-templates.test.tsx](chat-composer-slash-custom-templates.test.tsx).

## chat-composer-slash-custom-templates-001

Original test `The Templates overview's Presentation type offers accessible custom templates and sends their references`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-slash-custom-templates.test.tsx#L137).

- **Given** The user is in a chat thread with existing text, and Presentation custom and built-in templates are available.
- **When** They open the Templates slash overview, choose Presentation, select their custom template, and send the message.
- **Then** The overview shows accessible own and shared custom templates and the built-in Presentation template, but not a template of another kind. The selected template is inserted while preserving the existing brief, the slash menu closes, and the editor keeps focus. The sent message references the selected custom template by its ID.

## chat-composer-slash-custom-templates-002

Original test `The Templates overview's Illustration type offers accessible custom templates and sends their references`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-slash-custom-templates.test.tsx#L137).

- **Given** The user is in an agent chat with existing text, and Illustration custom and built-in templates are available.
- **When** They open the Templates slash overview, choose Illustration, select their custom template, and send the message.
- **Then** The overview shows accessible own and shared custom templates and the built-in Illustration template, but not a template of another kind. The selected template uses its preview image, is inserted while preserving the existing brief, and the slash menu closes with editor focus retained. The sent message references the selected custom template by its ID.

## chat-composer-slash-custom-templates-003

Original test `The Templates overview's Document type offers accessible custom templates and sends their references`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-slash-custom-templates.test.tsx#L137).

- **Given** The user is in an agent chat with existing text, and Document custom and built-in templates are available.
- **When** They open the Templates slash overview, choose Document, select their custom template, and send the message.
- **Then** The overview shows accessible own and shared custom templates and the built-in Document template, but not a template of another kind. The selected template is inserted while preserving the existing brief, the slash menu closes, and the editor keeps focus. The sent message references the selected custom template by its ID.

## chat-composer-slash-custom-templates-004

Original test `The open Templates overview refreshes published and removed custom templates`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-slash-custom-templates.test.tsx#L187).

- **Given** The user has the Templates slash overview open with a published Presentation custom template visible.
- **When** The catalog changes to a newly published template with the old one removed, and a templates-changed event arrives.
- **Then** The open overview updates to show the newly published template and no longer shows the removed template.

## chat-composer-slash-custom-templates-005

Original test `A failed custom catalog keeps built-in templates available in the overview`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-slash-custom-templates.test.tsx#L205).

- **Given** The user opens the Templates slash overview while the custom template catalog is unavailable.
- **When** The catalog request fails.
- **Then** The overview shows that templates could not be loaded, while built-in Presentation templates remain available.
