# Shared thread diagrams

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [shared-thread-diagrams.test.tsx](shared-thread-diagrams.test.tsx).

## shared-thread-diagrams-001

Original test `a diagram in a shared conversation expands in the conversation`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/shared-thread-page/__tests__/shared-thread-diagrams.test.tsx#L58).

- **Given** A visitor views a shared conversation containing a Mermaid diagram.
- **When** They expand the diagram and download it.
- **Then** The diagram opens in the conversation as an SVG. Its viewer offers close, download, and fill-view actions, but no share, copy-link, or split-view actions; zoom controls are enabled. Download saves the rendered SVG as diagram.svg without fetching it.
