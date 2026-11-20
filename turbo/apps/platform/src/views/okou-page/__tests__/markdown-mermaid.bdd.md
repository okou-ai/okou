# Markdown mermaid

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [markdown-mermaid.test.tsx](markdown-mermaid.test.tsx).

## markdown-mermaid-001

Original test `Closing a Mermaid artifact split view releases its blob and preserves the inline diagrams`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/markdown-mermaid.test.tsx#L130).

- **Given** A completed chat contains two inline Mermaid diagrams, and the first diagram is open in the artifact sidebar.
- **When** The user closes the artifact sidebar.
- **Then** The sidebar closes and its diagram blob URL is released. Both inline diagrams and both diagram-source labels remain visible.

## markdown-mermaid-002

Original test `Completed Mermaid diagrams remain accessible and inspectable`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/markdown-mermaid.test.tsx#L145).

- **Given** A chat first displays “Preparing diagrams.” and then receives a completed message containing two identical Mermaid diagrams while diagram rendering is still pending.
- **When** The diagrams finish rendering.
- **Then** While rendering is pending, both diagram sources remain visible and their expand controls are disabled. After rendering, both diagrams have visible images with distinct, unrevoked SVG blob URLs, and both expand controls are enabled.

## markdown-mermaid-003

Original test `A streaming Mermaid diagram stays readable until complete`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/markdown-mermaid.test.tsx#L229).

- **Given** A streaming chat message contains one complete Mermaid diagram followed by an incomplete Mermaid diagram.
- **When** The message completes the second diagram’s Mermaid fence.
- **Then** Before completion, the first diagram is visible and the second diagram’s partial source remains visible as readable code, with only one diagram expand control. After completion, both diagrams are visible, the partial code is gone, and two expand controls are available.
