# Artifact diagram overlay

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [artifact-diagram-overlay.test.tsx](artifact-diagram-overlay.test.tsx).

## artifact-diagram-overlay-001

Original test `closing an expanded diagram preserves its document, source and reading position (fullscreen: false)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/artifact-diagram-overlay.test.tsx#L61).

- **Given** A user has a document open in windowed mode, with its source expanded and the reading viewport scrolled to 120.
- **When** They expand the diagram, enter fullscreen in the expanded view, download it, and close it with Escape.
- **Then** The document remains open in windowed mode at scroll position 120 with its source expanded, and focus returns to the diagram trigger. The expanded diagram URL is revoked but the document's inline image URL is not; reopening creates a different, unrevoked expanded URL. Closing the expanded view again leaves the document open, and Escape then closes the document.

## artifact-diagram-overlay-002

Original test `closing an expanded diagram preserves its document, source and reading position (fullscreen: true)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/artifact-diagram-overlay.test.tsx#L61).

- **Given** A user has a document open in fullscreen mode, with its source expanded and the reading viewport scrolled to 120.
- **When** They expand the diagram, enter fullscreen in the expanded view, download it, and close it with Escape.
- **Then** The document remains open in fullscreen mode at scroll position 120 with its source expanded, and focus returns to the diagram trigger. The expanded diagram URL is revoked but the document's inline image URL is not; reopening creates a different, unrevoked expanded URL. Closing the expanded view again leaves the document open, and Escape then closes the document.

## artifact-diagram-overlay-003

Original test `changing document fullscreen preserves the paragraph currently being read`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/artifact-diagram-overlay.test.tsx#L153).

- **Given** A user is reading a document in windowed mode with six paragraphs and scroll position 190.
- **When** They enter fullscreen, scroll to 295, then exit fullscreen.
- **Then** Entering fullscreen adjusts the scroll position to 110 to preserve the paragraph being read. Exiting fullscreen adjusts it to 495 to preserve the current paragraph.
