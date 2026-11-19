# Shared thread private artifacts

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [shared-thread-private-artifacts.test.tsx](shared-thread-private-artifacts.test.tsx).

## shared-thread-private-artifacts-001

Original test `anonymous conversation snapshots preview temporary bytes and keep full stable links when copied`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/shared-thread-page/__tests__/shared-thread-private-artifacts.test.tsx#L80).

- **Given** A signed-out visitor opens a shared conversation containing image, HTML, video, audio, and PDF artifact references, plus a download link.
- **When** The conversation loads and the visitor copies the assistant message.
- **Then** Previews load from temporary resolved URLs while preview and download links retain the full stable artifact URLs, including fragments. The HTML preview iframe uses its temporary URL with the original fragment, and the copied text exactly preserves the original message.

## shared-thread-private-artifacts-002

Original test `anonymous prompt attachments load snapshot thumbnails while opening the stable reference`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/shared-thread-page/__tests__/shared-thread-private-artifacts.test.tsx#L149).

- **Given** A signed-out visitor opens a shared conversation with image and PDF prompt attachments.
- **When** The prompt attachments load and the visitor opens their references.
- **Then** The image thumbnail uses the temporary resolved image URL with the attachment preview dimensions, while both attachments link to their stable original references.

## shared-thread-private-artifacts-003

Original test `denied or revoked snapshots show unavailable previews without loading the reference as bytes: 403`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/shared-thread-page/__tests__/shared-thread-private-artifacts.test.tsx#L191).

- **Given** A signed-out visitor opens a shared conversation with image and HTML artifact previews and an image attachment; resolving each snapshot reference returns HTTP 403.
- **When** The conversation loads.
- **Then** Three unavailable statuses appear. No screenshot or attachment image and no site-preview title are shown; the HTML preview and attachment still link to their stable original references rather than loading those references as bytes.
