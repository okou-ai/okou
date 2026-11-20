# Chat composer media previews

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [chat-composer-media-previews.test.tsx](chat-composer-media-previews.test.tsx).

## chat-composer-media-previews-001

Original test `A image shows its local thumbnail during upload and enables preview after completion`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-media-previews.test.tsx#L35).

- **Given** A user selects a PNG image while its upload is pending.
- **When** They wait for the local thumbnail to load, complete the upload, open and close the preview, then remove the attachment.
- **Then** The uploading thumbnail uses a local blob URL; preview is disabled and busy while uploading, with progress and a cancel control visible. After upload, preview is enabled and opens a dialog showing the same local image, with an annotation control. Removing the attachment removes its preview and releases the local URL.

## chat-composer-media-previews-002

Original test `A video shows its local thumbnail during upload and enables preview after completion`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-media-previews.test.tsx#L35).

- **Given** A user selects an MP4 video while its upload is pending.
- **When** They wait for the local thumbnail to load, complete the upload, open and close the preview, then remove the attachment.
- **Then** The uploading thumbnail uses a local blob URL; preview is disabled and busy while uploading, with progress and a cancel control visible. After upload, preview is enabled and opens a dialog showing the same local video with playback controls. Removing the attachment removes its preview and releases the local URL.

## chat-composer-media-previews-003

Original test `Cancelling a media upload releases its local preview`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-media-previews.test.tsx#L123).

- **Given** A user has selected a video whose upload is pending and whose local thumbnail is visible.
- **When** They cancel the upload.
- **Then** The video preview disappears and its local preview URL is released.

## chat-composer-media-previews-004

Original test `Sending local media uses the uploaded file identity and releases its draft preview`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-media-previews.test.tsx#L154).

- **Given** A user has an uploaded local video attached to a chat draft and has entered “Review this recording.”
- **When** They send the message with Enter.
- **Then** The sent message includes the uploaded file’s identity, filename, and content type. The attachment’s remove control disappears and its local draft preview URL is released.

## chat-composer-media-previews-005

Original test `A restored private video opens its authenticated player even when its thumbnail fails`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-media-previews.test.tsx#L199).

- **Given** A chat draft contains a restored private MP4 video whose thumbnail has failed to load.
- **When** The user opens the video preview.
- **Then** The dialog opens with the authenticated private video URL, playback controls, and download options despite the thumbnail failure.
