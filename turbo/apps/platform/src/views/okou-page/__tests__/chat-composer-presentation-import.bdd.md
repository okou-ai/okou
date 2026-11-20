# Chat composer presentation import

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [chat-composer-presentation-import.test.tsx](chat-composer-presentation-import.test.tsx).

## chat-composer-presentation-import-001

Original test `Import a presentation deck over a saved template in an existing chat`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-presentation-import.test.tsx#L66).

- **Given** An existing chat has a saved presentation template in its composer draft.
- **When** The user imports a “modern-deck.pptx” file.
- **Then** One message is sent with the uploaded filename snapshot “modern-deck.pptx,” the prompt “Analyse this file and save it as a reusable template.”, and additional information containing “okou user-template publish.” The send uses no client thread ID and contains no selected template.

## chat-composer-presentation-import-002

Original test `Import a presentation deck from a new chat`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-presentation-import.test.tsx#L115).

- **Given** The user is starting a new chat.
- **When** The user imports a “new-chat-deck.pptx” file.
- **Then** One message is sent with the uploaded filename snapshot “new-chat-deck.pptx” and the prompt “Analyse this file and save it as a reusable template.” The browser navigates to the newly created chat thread.

## chat-composer-presentation-import-003

Original test `The Presentation tile still offers exactly the decks it always has`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-presentation-import.test.tsx#L154).

- **Given** The user opens the Presentation category in the template picker.
- **When** The user checks which file types the Presentation tile accepts.
- **Then** It accepts exactly .pptx, .ppt, and .pdf files.
