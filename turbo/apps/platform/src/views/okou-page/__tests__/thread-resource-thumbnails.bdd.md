# Thread resource thumbnails

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [thread-resource-thumbnails.test.tsx](thread-resource-thumbnails.test.tsx).

## thread-resource-thumbnails-001

Original test `Thread artifacts use authorized thumbnails and open the original image`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/thread-resource-thumbnails.test.tsx#L68).

- **Given** A private image artifact is in the thread, and its authorized thumbnail URL has not yet been resolved.
- **When** The user opens the artifact sidebar, returns to the artifact list, and authorization completes; then they preview the image.
- **Then** The catalog shows no thumbnail before authorization, then displays the authorized image through the 640-pixel thumbnail transformation. Previewing the artifact displays the original image URL.

## thread-resource-thumbnails-002

Original test `Workspace search uses a small authorized thumbnail for a private image`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/thread-resource-thumbnails.test.tsx#L99).

- **Given** A private image artifact is available in the thread, and its authorized thumbnail URL has not yet been resolved.
- **When** The user opens workspace search, searches for “Private,” and authorization completes.
- **Then** The search result initially has no thumbnail; afterward it displays the authorized image through the 64-pixel thumbnail transformation.

## thread-resource-thumbnails-003

Original test `Thread video cards wait for their authorized poster`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/thread-resource-thumbnails.test.tsx#L130).

- **Given** A private video artifact has a poster that is awaiting authorization.
- **When** The user opens the artifact, returns to the thread artifact list, and authorization completes.
- **Then** The catalog initially has no video source and later shows the authorized poster through the 640-pixel thumbnail transformation. The video source remains absent after authorization.
