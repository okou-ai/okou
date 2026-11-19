# Chat artifact download

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [chat-artifact-download.test.tsx](chat-artifact-download.test.tsx).

## chat-artifact-download-001

Original test `report.png remains downloadable when the browser reads bytes after the click`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-artifact-download.test.tsx#L38).

- **Given** An assistant message contains a downloadable report.png image artifact. The server serves its bytes only when the browser requests a cache reload.
- **When** The user opens the report preview and selects Download, then reads the download bytes after the click.
- **Then** The browser downloads report.png with image/png content and the exact bytes. The chat remains open; closing the preview retains the download blob until the user starts a new chat, when that blob is cleared.

## chat-artifact-download-002

Original test `report.pdf remains downloadable when the browser reads bytes after the click`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-artifact-download.test.tsx#L38).

- **Given** An assistant message contains a downloadable report.pdf artifact. The server serves its bytes only when the browser requests a cache reload.
- **When** The user opens the report preview and selects Download, then reads the download bytes after the click.
- **Then** The browser downloads report.pdf with application/pdf content and the exact bytes. The chat remains open; closing the preview retains the download blob until the user starts a new chat, when that blob is cleared.

## chat-artifact-download-003

Original test `photo.png downloads through a newly resolved attachment URL on every click`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-artifact-download.test.tsx#L167).

- **Given** A chat contains a photo.png image artifact with a resolvable attachment URL.
- **When** The user downloads it twice, with a newly granted download URL available for each click.
- **Then** Both downloads use the URL granted for that click, keep the filename photo.png, and do not navigate away from the chat. Each download is recorded as an image download from the preview dialog.

## chat-artifact-download-004

Original test `report.pdf downloads through a newly resolved attachment URL on every click`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-artifact-download.test.tsx#L167).

- **Given** A chat contains a report.pdf artifact with a resolvable attachment URL.
- **When** The user downloads it twice, with a newly granted download URL available for each click.
- **Then** Both downloads use the URL granted for that click, keep the filename report.pdf, and do not navigate away from the chat. Each download is recorded as a PDF download from the preview dialog.

## chat-artifact-download-005

Original test `clip.mp4 downloads through a newly resolved attachment URL on every click`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-artifact-download.test.tsx#L167).

- **Given** A chat contains a clip.mp4 video artifact with a resolvable attachment URL.
- **When** The user downloads it twice, with a newly granted download URL available for each click.
- **Then** Both downloads use the URL granted for that click, keep the filename clip.mp4, and do not navigate away from the chat. Each download is recorded as a video download from the preview dialog.

## chat-artifact-download-006

Original test `voice.mp3 downloads through a newly resolved attachment URL on every click`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-artifact-download.test.tsx#L167).

- **Given** A chat contains a voice.mp3 audio artifact with a resolvable attachment URL.
- **When** The user downloads it twice, with a newly granted download URL available for each click.
- **Then** Both downloads use the URL granted for that click, keep the filename voice.mp3, and do not navigate away from the chat. Each download is recorded as an audio download from the preview dialog.

## chat-artifact-download-007

Original test `upload.png downloads through a newly resolved attachment URL on every click`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-artifact-download.test.tsx#L167).

- **Given** A chat contains an uploaded user file named upload.png with a resolvable attachment URL.
- **When** The user downloads it twice, with a newly granted download URL available for each click.
- **Then** Both downloads use the URL granted for that click, keep the filename upload.png, and do not navigate away from the chat. Each download is recorded as an image download from the preview dialog.

## chat-artifact-download-008

Original test `proposal.DOCX downloads through a newly resolved attachment URL on every click`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-artifact-download.test.tsx#L167).

- **Given** A chat contains a proposal.DOCX document artifact with a resolvable attachment URL.
- **When** The user downloads it twice, with a newly granted download URL available for each click.
- **Then** Both downloads use the URL granted for that click, keep the filename proposal.DOCX, and do not navigate away from the chat. Each download is recorded as a document download from the preview dialog.

## chat-artifact-download-009

Original test `forecast#1.xlsx downloads through a newly resolved attachment URL on every click`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-artifact-download.test.tsx#L167).

- **Given** A chat contains a forecast#1.xlsx spreadsheet artifact with a resolvable attachment URL.
- **When** The user downloads it twice, with a newly granted download URL available for each click.
- **Then** Both downloads use the URL granted for that click, keep the filename forecast#1.xlsx, and do not navigate away from the chat. Each download is recorded as a spreadsheet download from the preview dialog.

## chat-artifact-download-010

Original test `strategy.pptx downloads through a newly resolved attachment URL on every click`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-artifact-download.test.tsx#L167).

- **Given** A chat contains a strategy.pptx presentation artifact with a resolvable attachment URL.
- **When** The user downloads it twice, with a newly granted download URL available for each click.
- **Then** Both downloads use the URL granted for that click, keep the filename strategy.pptx, and do not navigate away from the chat. Each download is recorded as a presentation download from the preview dialog.

## chat-artifact-download-011

Original test `a server-denied download keeps the preview available and opens the plans`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-artifact-download.test.tsx#L242).

- **Given** A chat contains a report.pdf artifact whose resolved download is denied by the server, while its preview URL remains available.
- **When** The user selects Download from the report preview's download options.
- **Then** No file is downloaded, the report preview remains available, and a Choose a plan dialog opens.
