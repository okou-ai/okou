# Chat continuity uploads

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [chat-continuity-uploads.test.tsx](chat-continuity-uploads.test.tsx).

## chat-continuity-uploads-001

Original test `Attach supported files with the file picker`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-continuity-uploads.test.tsx#L151).

- **Given** A chat composer is open and file upload is available.
- **When** The user selects a Markdown file and an uncommon-extension file in the picker.
- **Then** Both files appear as removable attachments. The Markdown file is prepared as text/markdown, and the uncommon file as application/octet-stream; storage PUT requests include no cookies, authorization, client-type, or preview-bypass headers.

## chat-continuity-uploads-002

Original test `Accept supported drops and reject an oversized dropped file`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-continuity-uploads.test.tsx#L179).

- **Given** A chat composer is open and a dropped file is within the 5 GB limit while another exceeds it.
- **When** The user drops both files onto the composer.
- **Then** The supported file is attached and prepared as text/plain. The oversized archive is not prepared, and the user sees that archive.iso exceeds the 5 GB limit.

## chat-continuity-uploads-003

Original test `Complete uploads returned as absolute private Artifact URLs`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-continuity-uploads.test.tsx#L203).

- **Given** A chat composer is open, and upload preparation returns an absolute private Artifact URL for private.txt.
- **When** The user uploads private.txt and its storage transfer succeeds.
- **Then** The file appears as a removable attachment, and upload completion is requested once for its upload ID.

## chat-continuity-uploads-004

Original test `Keep successful attachments after another upload fails`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-continuity-uploads.test.tsx#L254).

- **Given** A chat composer contains a message, and ready.txt can upload while failed.txt receives a storage 503 response.
- **When** The user selects both files, then sends the message after the failure.
- **Then** ready.txt remains attached, failed.txt is absent from the composer, and one failure message names failed.txt. The sent message contains only ready.txt.

## chat-continuity-uploads-005

Original test `Show byte progress while a single PUT is still transferring`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-continuity-uploads.test.tsx#L308).

- **Given** A 4 MiB file is uploading through a single PUT, and the transfer and finalization have not yet completed.
- **When** Storage reports 25%, 50%, and 75% of the bytes sent, then the PUT succeeds while finalization is still pending.
- **Then** The progress indicator advances from 0% through 25%, 50%, and 75%, then reaches 99% during pending finalization. After finalization succeeds, progress disappears and the file is attached.

## chat-continuity-uploads-006

Original test `Bound concurrent parts and show byte progress until finalization succeeds`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-continuity-uploads.test.tsx#L427).

- **Given** A 20 MiB plus 1 byte recording is being uploaded in 5 MiB parts, with transfers and finalization held pending.
- **When** The user uploads the recording, one part reports half its bytes, and part 2 completes before the remaining parts.
- **Then** Four part transfers start initially, and progress reaches 12%. Completing part 2 starts the fifth transfer and progress reaches 37%; the fifth part contains 1 byte. Once all parts transfer, progress reaches 99% until finalization succeeds, then disappears as the recording becomes attached.

## chat-continuity-uploads-007

Original test `Preserve partial byte progress across a retry without double counting`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-continuity-uploads.test.tsx#L487).

- **Given** A 10 MiB recording is uploading in two parts; the first attempt for part 1 will fail, while the other part and retry remain pending.
- **When** Part 1 reports 2 MiB sent, fails, then its retry reports 1 MiB and 3 MiB sent before succeeding.
- **Then** Progress first reaches 20%; the retry's 1 MiB report leaves it at 20%, and its 3 MiB report raises it to 30%. Successful retry completion raises progress to 50%, then the other part's completion attaches the recording and removes progress. Part 2 is transferred only once.

## chat-continuity-uploads-008

Original test `Retry transient part failures without retransferring successful parts`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-continuity-uploads.test.tsx#L549).

- **Given** A 5 MiB plus 1 byte recording is uploading in two parts; part 1 fails first with 503 and then with a network error.
- **When** The upload retries the transient part failures.
- **Then** The recording is attached without a failure message. Part 1 is attempted three times, while the successful 1-byte part 2 is transferred once.

## chat-continuity-uploads-009

Original test `Show one failure toast after storage returns 503`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-continuity-uploads.test.tsx#L586).

- **Given** A 5 MiB recording is uploading as one multipart part, and storage returns 503 for every attempt.
- **When** The user uploads the recording.
- **Then** One failure message names recording.mp4, the progress indicator disappears, and storage is attempted five times.

## chat-continuity-uploads-010

Original test `Show one failure toast after storage returns 403`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-continuity-uploads.test.tsx#L586).

- **Given** A 5 MiB recording is uploading as one multipart part, and storage returns 403.
- **When** The user uploads the recording.
- **Then** One failure message names recording.mp4, the progress indicator disappears, and storage is attempted once.

## chat-continuity-uploads-011

Original test `Report a finalization failure once without replaying completion`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-continuity-uploads.test.tsx#L609).

- **Given** A multipart recording upload's storage transfer succeeds, but the completion request returns a 404 with the message Multipart upload not found.
- **When** The user uploads the recording.
- **Then** That finalization message is shown once; completion is requested once, and no generic upload-failure message appears.

## chat-continuity-uploads-012

Original test `Keep unauthorized upload preparation quiet`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-continuity-uploads.test.tsx#L636).

- **Given** Upload preparation for an unauthorized user is pending.
- **When** The user selects unauthorized.txt and preparation returns 401 Unauthorized.
- **Then** The loading indicator disappears without showing an Unauthorized message or a generic upload-failure message.

## chat-continuity-uploads-013

Original test `Accept the 5 GiB picker boundary before starting the transfer`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-continuity-uploads.test.tsx#L662).

- **Given** The user has a 5 GiB recording, exactly at the picker upload-size limit.
- **When** The user selects the recording in the file picker.
- **Then** Upload preparation receives the full 5 GiB size and a loading indicator appears, showing that the file was accepted to start transfer. The test then cancels the upload.

## chat-continuity-uploads-014

Original test `Cancel active parts without a failure toast or starting queued parts`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-continuity-uploads.test.tsx#L681).

- **Given** A 20 MiB plus 1 byte recording is uploading in five parts, with four active transfers held pending and the fifth queued.
- **When** The user cancels the recording upload.
- **Then** The progress indicator disappears, no failure message appears, and the queued fifth part never starts; the number of started transfers remains four.
