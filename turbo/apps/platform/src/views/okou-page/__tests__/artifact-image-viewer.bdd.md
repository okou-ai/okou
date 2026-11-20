# Artifact image viewer

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [artifact-image-viewer.test.tsx](artifact-image-viewer.test.tsx).

Batch 25 accepted 001 as the alternate for artifact-sharing-002. Selected IDs 002 and 003 remain pending.

## artifact-image-viewer-001

Original test `The image viewer waits for the preview image to decode`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/artifact-image-viewer.test.tsx#L239).

- **Given** The image viewer has opened an image whose decoding is delayed.
- **When** The image dimensions become available before decoding finishes, then decoding completes.
- **Then** The image remains hidden and a loading status remains visible until decoding completes; afterward the image is visible, the loading status is gone, no previous-image button is present, and the next-image button is enabled.

## artifact-image-viewer-002

Original test `The image viewer resolves and decodes the next image during keyboard navigation`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/artifact-image-viewer.test.tsx#L257).

- **Given** The viewer is showing the first of two images, and the next image’s URL resolution and decoding are delayed.
- **When** The user presses Arrow Right, then the next URL resolves and its image finishes decoding.
- **Then** The first image is removed, the viewer shows a loading status and the second image’s preview name, and focus remains in the viewer. The second image stays hidden until decoding completes, after which it becomes visible and the loading status disappears.

## artifact-image-viewer-003

Original test `Image gestures use the approved continuous zoom in the lightbox`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/artifact-image-viewer.test.tsx#L299).

- **Given** An image is open in the lightbox at 100% zoom.
- **When** The user uses zoom buttons and wheel gestures with Ctrl or Meta, including one 20-pixel total movement as 20 one-pixel events, and tests zero movement and gestures without a modifier.
- **Then** Zoom buttons change 100% to 112% and back. A one-pixel gesture changes zoom to 101%, and 20 one-pixel gestures reach 120%; equivalent 20-pixel movement reaches the same 120%. A 16-pixel movement or one line-mode unit reaches 115%. Zero movement and unmodified wheel movement do not zoom; Meta-modified movement does. Zoom is bounded at 10% and at the upper limit, disables the corresponding zoom button at each bound, and reset returns to 100%.

## artifact-image-viewer-004

Original test `Image gestures use the approved continuous zoom in the sidebar`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/artifact-image-viewer.test.tsx#L299).

- **Given** An image is open in the sidebar preview.
- **When** The user uses zoom buttons and wheel gestures with Ctrl or Meta, including one 20-pixel total movement as 20 one-pixel events, and tests zero movement and gestures without a modifier.
- **Then** Zoom buttons change 100% to 112% and back. A one-pixel gesture changes zoom to 101%, and 20 one-pixel gestures reach 120%; equivalent 20-pixel movement reaches the same 120%. A 16-pixel movement or one line-mode unit reaches 115%. Zero movement and unmodified wheel movement do not zoom; Meta-modified movement does. Zoom is bounded at 10% and at the upper limit, disables the corresponding zoom button at each bound, and reset returns to 100%.

## artifact-image-viewer-005

Original test `Image gestures use the approved continuous zoom in the fullscreen`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/artifact-image-viewer.test.tsx#L299).

- **Given** An image is open in fullscreen mode within the sidebar preview.
- **When** The user uses zoom buttons and wheel gestures with Ctrl or Meta, including one 20-pixel total movement as 20 one-pixel events, and tests zero movement and gestures without a modifier.
- **Then** Zoom buttons change 100% to 112% and back. A one-pixel gesture changes zoom to 101%, and 20 one-pixel gestures reach 120%; equivalent 20-pixel movement reaches the same 120%. A 16-pixel movement or one line-mode unit reaches 115%. Zero movement and unmodified wheel movement do not zoom; Meta-modified movement does. Zoom is bounded at 10% and at the upper limit, disables the corresponding zoom button at each bound, and reset returns to 100%.
