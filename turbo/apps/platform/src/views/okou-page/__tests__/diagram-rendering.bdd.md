# Diagram rendering

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [diagram-rendering.test.tsx](diagram-rendering.test.tsx).

## diagram-rendering-001

Original test `Sequence diagrams render in chat`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/diagram-rendering.test.tsx#L46).

- **Given** A completed chat message contains a Mermaid sequence diagram with Reader and Platform participants.
- **When** The user opens the chat.
- **Then** The sequence diagram renders visibly as a diagram, and the Expand diagram action is enabled.

## diagram-rendering-002

Original test `A failed Mermaid layout leaves its source readable and other diagrams usable`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/diagram-rendering.test.tsx#L74).

- **Given** A completed chat message contains two Mermaid diagrams, and layout of the first diagram fails.
- **When** The user opens the chat and expands the surviving diagram.
- **Then** The failed diagram’s source remains readable as code, the other diagram renders, and its preview opens in a dialog.
