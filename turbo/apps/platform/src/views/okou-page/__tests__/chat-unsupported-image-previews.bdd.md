# Chat unsupported image previews

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [chat-unsupported-image-previews.test.tsx](chat-unsupported-image-previews.test.tsx).

## chat-unsupported-image-previews-001

Original test `assistant BMP images display the original in the thread and lightbox`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-unsupported-image-previews.test.tsx#L27).

- **Given** A conversation contains an assistant BMP image named “photo.BMP.”
- **When** The user views the image in the conversation and opens it in the lightbox.
- **Then** The conversation image and lightbox image both use the original image URL.

## chat-unsupported-image-previews-002

Original test `user BMP images display the original in the thread and lightbox`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-unsupported-image-previews.test.tsx#L27).

- **Given** A conversation contains a user BMP image named “photo.BMP.”
- **When** The user views the image in the conversation and opens its preview in the lightbox.
- **Then** The conversation image and lightbox image both use the original image URL.
