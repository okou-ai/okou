# Shared thread presentation

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [shared-thread-presentation.test.tsx](shared-thread-presentation.test.tsx).

## shared-thread-presentation-001

Original test `A missing public conversation uses the Okou presentation`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/shared-thread-page/__tests__/shared-thread-presentation.test.tsx#L23).

- **Given** A visitor opens a public conversation that returns not found on app.okou.ai.
- **When** The shared conversation page loads.
- **Then** The page shows “You can’t view this chat.” Sign-in links redirect back to the current URL, and Okou and Sign up links point to the app.okou.ai destinations.

## shared-thread-presentation-002

Original test `A public conversation renders shared messages with Okou branding`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/shared-thread-page/__tests__/shared-thread-presentation.test.tsx#L49).

- **Given** A public conversation titled “Public launch plan” contains user and assistant messages, Markdown headings, and bold text, with dark color scheme preferred.
- **When** A signed-out visitor opens it on app.okou.ai.
- **Then** The title and messages render; “Primary” is an H1, “Secondary” is an H2, and “public preview” is bold. No rich-content loading indicator remains, and the Okou brand link shows the light wordmark and links to https://app.okou.ai.

## shared-thread-presentation-003

Original test `A shared conversation draws Okou with the animated avatar once it is on`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/shared-thread-page/__tests__/shared-thread-presentation.test.tsx#L113).

- **Given** A signed-in visitor opens a shared conversation while the animated-avatar feature is enabled.
- **When** The assistant message appears.
- **Then** The assistant avatar is animated and has the accessible name “Okou.”

## shared-thread-presentation-004

Original test `A shared conversation renders CJK emphasis`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/shared-thread-page/__tests__/shared-thread-presentation.test.tsx#L150).

- **Given** A signed-in visitor opens a shared conversation with the assistant text “**机构与身份：**个人站 Artibiotics”.
- **When** The message renders.
- **Then** “机构与身份：” is bold and the paragraph text is “机构与身份：个人站 Artibiotics”.

## shared-thread-presentation-005

Original test `A link inside a public prompt is clickable for a signed-out visitor`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/shared-thread-page/__tests__/shared-thread-presentation.test.tsx#L173).

- **Given** A signed-out visitor opens a public conversation whose user prompt contains https://example.com/report and literal **bold** text.
- **When** The prompt renders.
- **Then** The URL is a link opening in a new tab with noopener noreferrer. The surrounding text remains visible, and **bold** is preserved literally rather than interpreted as Markdown.

## shared-thread-presentation-006

Original test `A public conversation renders embedded media and diagrams`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/shared-thread-page/__tests__/shared-thread-presentation.test.tsx#L206).

- **Given** A public conversation contains a Markdown image for “Launch map” and a Mermaid flowchart.
- **When** The conversation renders and the image loads.
- **Then** The image is visible with its original URL, the diagram is visible as an image named “Diagram,” and its expand button is enabled.
