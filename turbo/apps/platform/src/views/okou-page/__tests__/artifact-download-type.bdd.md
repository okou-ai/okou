# Artifact download type

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [artifact-download-type.test.tsx](artifact-download-type.test.tsx).

## artifact-download-type-001

Original test `Catalog hosted-site download retains its type (sidebar: false)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/artifact-download-type.test.tsx#L44).

- **Given** The artifact catalog contains a hosted-site artifact titled “Confidential board review.png,” and sidebar preview is disabled.
- **When** The user opens the artifact and downloads it from the lightbox menu.
- **Then** The downloaded filename is “Confidential board review.html,” and download telemetry identifies the artifact as a website on the dialog surface.

## artifact-download-type-002

Original test `Catalog presentation download retains its type (sidebar: false)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/artifact-download-type.test.tsx#L44).

- **Given** The artifact catalog contains a presentation titled “Confidential board review.png,” and sidebar preview is disabled.
- **When** The user opens the artifact and downloads it from the lightbox menu.
- **Then** The downloaded filename is “Confidential board review.html,” and download telemetry identifies the artifact as a presentation on the dialog surface.

## artifact-download-type-003

Original test `Catalog hosted-site download retains its type (sidebar: true)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/artifact-download-type.test.tsx#L44).

- **Given** The artifact catalog contains a hosted-site artifact titled “Confidential board review.png,” and sidebar preview is enabled.
- **When** The user opens the artifact and downloads it from the sidebar menu.
- **Then** The downloaded filename is “Confidential board review.html,” and download telemetry identifies the artifact as a website on the page surface.

## artifact-download-type-004

Original test `Catalog presentation download retains its type (sidebar: true)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/artifact-download-type.test.tsx#L44).

- **Given** The artifact catalog contains a presentation titled “Confidential board review.png,” and sidebar preview is enabled.
- **When** The user opens the artifact and downloads it from the sidebar menu.
- **Then** The downloaded filename is “Confidential board review.html,” and download telemetry identifies the artifact as a presentation on the page surface.

## artifact-download-type-005

Original test `A generic thread preview and its menu use the resolved file MIME`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/artifact-download-type.test.tsx#L125).

- **Given** A chat message links to a generic file named “forecast.bin” whose resolved MIME type is an Excel spreadsheet.
- **When** The user opens the link and downloads once from the preview and once from its download menu.
- **Then** Both downloads are recorded, with telemetry identifying the file as a spreadsheet on the file-preview surface and on the dialog surface, respectively.

## artifact-download-type-006

Original test `A MIME-only draft video download retains its preview type`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/artifact-download-type.test.tsx#L193).

- **Given** A chat draft contains an attachment named “recording” identified only by the MIME type video/mp4.
- **When** The user opens its video preview and downloads it from the preview menu.
- **Then** One download is recorded, and telemetry identifies it as a video on the dialog surface.

## artifact-download-type-007

Original test `A MIME-only sent audio attachment retains its type in the sidebar`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/artifact-download-type.test.tsx#L230).

- **Given** A sent chat message contains an attachment named “recording” identified only by the MIME type audio/mpeg, with sidebar preview enabled.
- **When** The user opens its audio preview and downloads it from the sidebar menu.
- **Then** The sidebar audio player uses the attachment URL, one download is recorded, and telemetry identifies it as audio on the page surface.
