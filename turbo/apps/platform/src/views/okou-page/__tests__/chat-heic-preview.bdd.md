# Chat heic preview

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [chat-heic-preview.test.tsx](chat-heic-preview.test.tsx).

## chat-heic-preview-001

Original test `an iPhone photo opens at full resolution and downloads its original (image/heic, sidebar first=false)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-heic-preview.test.tsx#L29).

- **Given** A chat contains an iPhone photo named photo.HEIC with content type image/heic and an opaque stored name, alongside a JPEG. The artifact sidebar preview is disabled initially.
- **When** The user opens the HEIC preview, navigates to the JPEG and back, switches to split view, then downloads the artifact.
- **Then** The HEIC displays through its full-resolution converted image URL in the lightbox and sidebar, while navigation shows the JPEG and returns to the HEIC. The download uses the original signed attachment URL with an attachment disposition and retains the filename photo.HEIC.

## chat-heic-preview-002

Original test `an iPhone photo opens at full resolution and downloads its original (application/octet-stream, sidebar first=true)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-heic-preview.test.tsx#L29).

- **Given** A chat contains an iPhone photo named photo.HEIC with content type application/octet-stream and stored name photo.HEIC, alongside a JPEG. The artifact sidebar preview is enabled initially.
- **When** The user opens the HEIC preview, navigates to the JPEG and back, then downloads the artifact.
- **Then** The HEIC displays through its full-resolution converted image URL in the sidebar, and navigation shows the JPEG then returns to the HEIC. The download uses the original signed attachment URL with an attachment disposition and retains the filename photo.HEIC.

## chat-heic-preview-003

Original test `an inaccessible HEIC artifact keeps its access error in the image viewer`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-heic-preview.test.tsx#L139).

- **Given** An assistant message links to an HEIC artifact that the user cannot access; resolving it returns a forbidden error.
- **When** The user opens the iPhone photo link.
- **Then** The image viewer shows the heading “You can’t view this artifact.”
