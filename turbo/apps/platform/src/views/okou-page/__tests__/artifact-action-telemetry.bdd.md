# Artifact action telemetry

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [artifact-action-telemetry.test.tsx](artifact-action-telemetry.test.tsx).

## artifact-action-telemetry-001

Original test `A generic ZIP preview counts downloads but copies its link without hosted-site analytics`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/artifact-action-telemetry.test.tsx#L58).

- **Given** A user previews a ZIP artifact named confidential-release-bundle.zip in the artifact catalog.
- **When** They download it, download it again from Download options, then copy its link from Share.
- **Then** The two downloads use the artifact URL and each records one archive download action, first on file_preview and then on dialog. Previewing, opening Download options, and copying the link add no actions; the copied link is the artifact's owner URL.

## artifact-action-telemetry-002

Original test `An Office chip opens without intent; confidential-forecast.bin downloads with its type`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/artifact-action-telemetry.test.tsx#L172).

- **Given** A chat attachment named confidential-forecast.bin has content type application/octet-stream, alongside a Word document attachment.
- **When** The user previews the Word document, then downloads confidential-forecast.bin from the chat.
- **Then** Opening the Office preview records no action and downloads nothing. The binary file downloads using its private URL with ?download=1, and records one attachment_chip download action with type other.

## artifact-action-telemetry-003

Original test `An Office chip opens without intent; confidential-forecast downloads with its type`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/artifact-action-telemetry.test.tsx#L172).

- **Given** A chat attachment named confidential-forecast has an Office spreadsheet content type with mixed-case MIME type and a charset parameter, alongside a Word document attachment.
- **When** The user previews the Word document, then downloads confidential-forecast from the chat.
- **Then** Opening the Office preview records no action and downloads nothing. The spreadsheet downloads using its private URL with ?download=1, and records one attachment_chip download action with type spreadsheet.

## artifact-action-telemetry-004

Original test `A shared-thread viewer reports its independent download, not preview or fullscreen`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/artifact-action-telemetry.test.tsx#L268).

- **Given** A signed-out visitor views a shared-thread video preview.
- **When** They open the preview, enter fullscreen, and download the video using the current download URL.
- **Then** Opening the preview and entering fullscreen record no action. The download uses the fresh URL, not the stale URL, and records one shared_preview download action with type video.

## artifact-action-telemetry-005

Original test `An expanded diagram reports only its download, never its document or source`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/artifact-action-telemetry.test.tsx#L336).

- **Given** A user views a chat document containing a diagram and opens the diagram source.
- **When** They expand the diagram, fill the view, and download it.
- **Then** Viewing the document or source and entering fullscreen record no action. The download is diagram.svg with SVG content type and records one diagram_preview download action with type image.
