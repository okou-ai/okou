# transcribe

## transcribe-001

- Vitest: "ordered private recordings share one Vertex request and one credit settlement across retries"
- Mode: run
- Given: A Pro organization member has chat-send and chat-read MCP credentials, two private WAV recordings uploaded in order and a Run token obtained after sending those recordings in a chat message. Vertex initially rate-limits the request and then can transcribe the two recordings.
- When: The member prepares, uploads, completes and plays back the recordings using the relevant scopes, then the Run calls `POST /api/voice/transcribe` with their ordered IDs and retries with the same operation ID. It also resubmits that operation with reversed IDs, and a different organization attempts the operation.
- Then: Chat-read alone gets HTTP 403 for private prepare and completion, chat-send gets HTTP 401 on ordinary prepare and HTTP 400 on private prepare for a non-audio type. Chat-send cannot play the recording (403), an unrelated chat-read caller gets HTTP 404, and owner playback returns the original bytes and private no-store policy. Chat history retains both the ordered voice clips and file attachment. The upstream failure returns HTTP 503 without charging credits. Both later matching requests return HTTP 200 with `第一段。第二段。`, with one successful Vertex call in input order and one three-credit settlement total. Reordering returns HTTP 409 and the other organization gets HTTP 404.
