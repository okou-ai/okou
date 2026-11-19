# Chat composer presigned previews

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [chat-composer-presigned-previews.test.tsx](chat-composer-presigned-previews.test.tsx).

## chat-composer-presigned-previews-001

Original test `restored private composer images show a presigned thumbnail and open the same original`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-presigned-previews.test.tsx#L25).

- **Given** A chat has a restored draft containing the private image composer-photo.png.
- **When** The user opens the image preview.
- **Then** The composer thumbnail uses a presigned thumbnail URL, and the preview dialog opens the same original image URL without replacing the thumbnail.
