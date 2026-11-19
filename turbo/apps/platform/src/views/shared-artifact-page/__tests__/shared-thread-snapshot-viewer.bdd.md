# Shared thread snapshot viewer

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [shared-thread-snapshot-viewer.test.tsx](shared-thread-snapshot-viewer.test.tsx).

## shared-thread-snapshot-viewer-001

Original test `a snapshot viewer copies its full reference and downloads newly authorized bytes (signed in: false)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/shared-artifact-page/__tests__/shared-thread-snapshot-viewer.test.tsx#L42).

- **Given** An anonymous visitor views a snapshot image with a URL fragment, and the download authorization can be renewed.
- **When** They select Share, then download the image after authorization is renewed.
- **Then** The image preview keeps its fragment and the app does not redirect. Share copies the full app reference with fragment, displays “Link copied,” and shows no audience controls. Download uses the newly authorized URL and original filename without a blob fetch, while leaving the preview URL unchanged.

## shared-thread-snapshot-viewer-002

Original test `a snapshot viewer copies its full reference and downloads newly authorized bytes (signed in: true)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/shared-artifact-page/__tests__/shared-thread-snapshot-viewer.test.tsx#L42).

- **Given** A signed-in visitor views a snapshot image with a URL fragment, and the download authorization can be renewed.
- **When** They select Share, then download the image after authorization is renewed.
- **Then** The image preview keeps its fragment and the app does not redirect. Share copies the full app reference with fragment, displays “Link copied,” and shows no audience controls. Download uses the newly authorized URL and original filename without a blob fetch, while leaving the preview URL unchanged.

## shared-thread-snapshot-viewer-003

Original test `an anonymous HTML snapshot keeps its temporary credential and slide fragment inside the viewer`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/shared-artifact-page/__tests__/shared-thread-snapshot-viewer.test.tsx#L107).

- **Given** An anonymous visitor views an HTML snapshot with a slide fragment and a temporary download credential.
- **When** They view the preview and select Download.
- **Then** The viewer keeps the fragment on the preview, uses the origin referrer policy and a sandbox allowing only same-origin and scripts, and downloads the original filename using the credential-bearing URL without a blob fetch.

## shared-thread-snapshot-viewer-004

Original test `a snapshot pasted into an ordinary thread cannot expose source permissions even to its owner`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/shared-artifact-page/__tests__/shared-thread-snapshot-viewer.test.tsx#L150).

- **Given** An artifact owner views a snapshot link pasted into an ordinary chat thread, where the source sharing status is private.
- **When** They open the link and select Share.
- **Then** The image preview opens and Share copies the full app snapshot reference. No audience controls appear, so the snapshot does not expose source permissions.
