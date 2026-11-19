# Shared artifact fullscreen

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [shared-artifact-fullscreen.test.tsx](shared-artifact-fullscreen.test.tsx).

## shared-artifact-fullscreen-001

Original test `fullscreen hides the header and offers an exit when the browser API is unsupported`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/shared-artifact-page/__tests__/shared-artifact-fullscreen.test.tsx#L124).

- **Given** The browser does not support native fullscreen, and the HTML artifact viewer is open.
- **When** The user enters fullscreen and then exits it.
- **Then** The viewer hides the header and title while fullscreen, keeps the preview visible with its requested fragment, and offers an enabled exit control. Exiting restores the header and title, returns focus to Enter fullscreen, and leaves the preview URL unchanged; native browser fullscreen remains inactive.

## shared-artifact-fullscreen-002

Original test `native fullscreen keeps the exit control with the preview and restores the header after exit`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/shared-artifact-page/__tests__/shared-artifact-fullscreen.test.tsx#L159).

- **Given** The HTML artifact viewer is open and the browser supports native fullscreen.
- **When** The user enters fullscreen and then exits it.
- **Then** The preview and exit control are inside the native fullscreen element, while the header is hidden. Exiting restores the header, returns focus to Enter fullscreen, and leaves the preview URL unchanged.

## shared-artifact-fullscreen-003

Original test `closing a diagram preserves document fullscreen (native)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/shared-artifact-page/__tests__/shared-artifact-fullscreen.test.tsx#L227).

- **Given** A Markdown artifact with an expanded diagram is in native document fullscreen.
- **When** The user closes the diagram, then exits document fullscreen.
- **Then** Closing the diagram preserves document fullscreen and returns focus to Expand diagram. Exiting fullscreen restores the visible header and returns focus to Enter fullscreen.

## shared-artifact-fullscreen-004

Original test `closing a diagram preserves document fullscreen (unsupported)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/shared-artifact-page/__tests__/shared-artifact-fullscreen.test.tsx#L227).

- **Given** A Markdown artifact with an expanded diagram is in simulated fullscreen because native fullscreen is unsupported.
- **When** The user presses Escape to close the diagram, then presses Escape again to exit fullscreen.
- **Then** Closing the diagram preserves simulated fullscreen and returns focus to Expand diagram. Exiting fullscreen restores the visible header and returns focus to Enter fullscreen.

## shared-artifact-fullscreen-005

Original test `Escape leaves the inline diagram and returns to reading without scrolling`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/shared-artifact-page/__tests__/shared-artifact-fullscreen.test.tsx#L275).

- **Given** A Markdown artifact is open with its diagram source expanded and the reading area scrolled to position 120.
- **When** The user expands the diagram and presses Escape, then presses Escape again.
- **Then** The first Escape closes the diagram and returns focus to Expand diagram. The second returns focus to the document without changing the scroll position or closing the diagram source; the diagram can be reopened with Enter.

## shared-artifact-fullscreen-006

Original test `browser fullscreen exit leaves the diagram open and focused without restoring fullscreen on close`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/shared-artifact-page/__tests__/shared-artifact-fullscreen.test.tsx#L306).

- **Given** A Markdown artifact is in native document fullscreen with its diagram expanded.
- **When** The browser exits fullscreen, the user switches the diagram to Fill view, and then closes it.
- **Then** The diagram remains open and focused after browser fullscreen exit; Fill view does not re-enter native fullscreen. Closing the diagram restores the visible header and focus to Expand diagram, with native fullscreen still inactive.
