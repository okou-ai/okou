# Raw video thumbnail

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [raw-video-thumbnail.test.tsx](raw-video-thumbnail.test.tsx).

## raw-video-thumbnail-001

Original test `Raw video resolves an authorized artifact-reference poster before displaying a thumbnail`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/raw-video-thumbnail.test.tsx#L27).

- **Given** A user views a chat containing a raw video with an artifact-reference poster whose authorized URL is not yet available.
- **When** The poster authorization completes.
- **Then** Before authorization, the video has no poster but retains its source, controls, and preload=none. Afterward, its poster uses the authorized URL through the image CDN, while the video source remains unchanged.

## raw-video-thumbnail-002

Original test `Raw video resolves an authorized uploaded-file poster before displaying a thumbnail`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/raw-video-thumbnail.test.tsx#L27).

- **Given** A user views a chat containing a raw video with an uploaded-file poster whose authorized URL is not yet available.
- **When** The poster authorization completes.
- **Then** Before authorization, the video has no poster but retains its source, controls, and preload=none. Afterward, its poster uses the authorized URL through the image CDN, while the video source remains unchanged.

## raw-video-thumbnail-003

Original test `Shared raw videos preserve playback with or without public posters`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/raw-video-thumbnail.test.tsx#L88).

- **Given** A signed-out visitor views a shared conversation containing one raw video with a public poster and one without a poster.
- **When** The shared page renders both videos.
- **Then** The video with a poster displays its poster through the image CDN; both videos retain the video source, controls, and preload=none.
