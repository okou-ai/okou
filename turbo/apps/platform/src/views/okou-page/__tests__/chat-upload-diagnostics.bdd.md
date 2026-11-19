# Chat upload diagnostics

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [chat-upload-diagnostics.test.tsx](chat-upload-diagnostics.test.tsx).

## chat-upload-diagnostics-001

Original test `reports one exhausted upload with safe terminal diagnostics`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-upload-diagnostics.test.tsx#L72).

- **Given** A user is composing a chat message and selects a 5 MiB video file named private-recording.mp4. The storage upload fails on all five attempts.
- **When** The upload finishes exhausting its retries.
- **Then** The composer shows “Failed to upload private-recording.mp4.” Exactly one storage-upload exception is reported with terminal diagnostics for part 1 of 1, attempt 5, 5 MiB total, an error event with status 0, timeout 0, online true, and credentials disabled. Diagnostic URLs expose only the target origin and a redacted presigned-object breadcrumb; the signed URL’s private values are absent.

## chat-upload-diagnostics-002

Original test `does not report an upload error when a transient network failure recovers`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-upload-diagnostics.test.tsx#L144).

- **Given** A user is composing a chat message and selects a 5 MiB video file. The first storage upload attempt has a transient network failure, but a subsequent attempt succeeds.
- **When** The upload completes successfully.
- **Then** The file appears as an attachment with a Remove private-recording.mp4 control, and upload progress is gone. No error is reported.

## chat-upload-diagnostics-003

Original test `does not report an upload error when the user cancels`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-upload-diagnostics.test.tsx#L167).

- **Given** A user is composing a chat message and selects a 5 MiB video file while its storage upload is still pending.
- **When** The user cancels the upload.
- **Then** Upload progress disappears, the failure message is not shown, and no error is reported.
