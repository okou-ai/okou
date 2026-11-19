# Artifact catalog preview

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [artifact-catalog-preview.test.tsx](artifact-catalog-preview.test.tsx).

## artifact-catalog-preview-001

Original test `HTML artifact cards resolve their stored private cover image`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/artifacts-page/__tests__/artifact-catalog-preview.test.tsx#L25).

- **Given** The catalog contains a hosted-site card whose thumbnail points to a stored private cover image, and resolving that reference returns an authorized URL.
- **When** The user views the card preview.
- **Then** The card's thumbnail uses the resolved private image URL.

## artifact-catalog-preview-002

Original test `An avatar card and its viewer share one private video URL`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/artifacts-page/__tests__/artifact-catalog-preview.test.tsx#L58).

- **Given** The Avatars catalog contains an avatar video with a canonical private-file reference; resolving the reference first returns a signed URL.
- **When** The user views the card and opens its preview.
- **Then** The card preview uses the first resolved URL with a 0.001-second start offset, and the viewer uses that same URL without the offset.

## artifact-catalog-preview-003

Original test `A binary can be downloaded from its preview`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/artifacts-page/__tests__/artifact-catalog-preview.test.tsx#L122).

- **Given** The catalog contains a ZIP file whose preview can be opened and whose file URL returns archive content.
- **When** The user opens the preview and chooses Download.
- **Then** A download is initiated for release-bundle.zip from its original artifact URL.

## artifact-catalog-preview-004

Original test `A native PPTX in Presentations keeps its Office preview and original download`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/artifacts-page/__tests__/artifact-catalog-preview.test.tsx#L180).

- **Given** The catalog contains a native PowerPoint presentation file, and its preview and original file URL are available.
- **When** The user opens the file preview and chooses Download.
- **Then** The preview retains its Office presentation URL, and a download is initiated for the original quarterly-review.pptx from its original URL.

## artifact-catalog-preview-005

Original test `Opening a text artifact shows its content on demand`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/artifacts-page/__tests__/artifact-catalog-preview.test.tsx#L238).

- **Given** The Files catalog contains launch-plan.txt, and its content is available from the artifact URL but has not yet been shown.
- **When** The user opens the artifact.
- **Then** The text content, “launch plan,” is displayed.
