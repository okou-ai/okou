# browser-viewer

## browser-viewer-001

- Vitest: "a mounted viewer renews only its current chat window through https: without input evidence"
- Mode: run
- Given: Two chats under one authenticated owner have open browser windows. The browser provider uses `https:` for the viewer transport.
- When: At two minutes the owner renews the first thread’s browser lease without sending input evidence.
- Then: The lease returns HTTP 200 and the same thread and window. The first thread expires twelve minutes after the original start while the sibling keeps its previous expiry.

## browser-viewer-002

- Vitest: "a mounted viewer renews only its current chat window through wss: without input evidence"
- Mode: run
- Given: Two chats under one authenticated owner have open browser windows. The browser provider uses `wss:` for the viewer transport.
- When: At two minutes the owner renews the first thread’s browser lease without sending input evidence.
- Then: The lease returns HTTP 200 and the same thread and window. The first thread expires twelve minutes after the original start while the sibling keeps its previous expiry.
