# Chat composer template media

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [chat-composer-template-media.test.tsx](chat-composer-template-media.test.tsx).

## chat-composer-template-media-001

Original test `Preview a website template and return to its picker`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-template-media.test.tsx#L40).

- **Given** A saved website template is present in the chat composer.
- **When** The user opens its preview, then closes the preview dialog.
- **Then** The preview displays the template's preview URL. While open, it is nested within the picker; after closing, the picker is visible again and the template preview control remains available.

## chat-composer-template-media-002

Original test `Select and send a website template`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-template-media.test.tsx#L102).

- **Given** The website template picker is open and a website template is available.
- **When** The user selects the template, enters “Build this launch site,” and sends the message.
- **Then** The composer shows the selected template, and the sent message includes that website template's ID.
