# Codex access-program rejection fixture

`access-program-http-body.json` is the complete `TurnError.message` captured
from **codex-cli 0.166.0**, the version pinned by Runner, on 2026-11-05.
Whitespace inside the JSON is retained; the file adds a trailing newline.

The capture ran the real `codex app-server` with a fresh `CODEX_HOME`, no account
credentials, and a loopback HTTP fixture. Configure a custom `responses` provider
with `requires_openai_auth=false`, `supports_websockets=false`, and a loopback
`base_url`. Initialize the app-server, start a thread, and submit a text turn.
Return HTTP 400 with this JSON body from `POST /v1/responses`.

The app-server made one Responses request and emitted both a non-retrying
`error` notification and a failed `turn/completed` notification. Both contained:

```json
{
  "message": "<the complete fixture JSON body>",
  "codexErrorInfo": "other",
  "additionalDetails": null,
  "misalignment": null
}
```

No top-level HTTP status or raw provider error fields were present in either
notification. The fixture models a local upstream executable capture, not a live
provider account rejection. Dynamic thread/turn IDs and timestamps are supplied
by the mock rather than retained from the capture.

Pinned upstream authority (tag `rust-v0.166.0`, commit
`6ff1e1ca3b30fc8b914720681fcf5fe62e95f856`):

- [TurnError schema](https://github.com/openai/codex/blob/6ff1e1ca3b30fc8b914720681fcf5fe62e95f856/codex-rs/app-server-protocol/schema/typescript/v2/TurnError.ts)
- [HTTP 400 body preservation](https://github.com/openai/codex/blob/6ff1e1ca3b30fc8b914720681fcf5fe62e95f856/codex-rs/codex-api/src/api_bridge.rs#L161-L195)
- [Native error projection](https://github.com/openai/codex/blob/6ff1e1ca3b30fc8b914720681fcf5fe62e95f856/codex-rs/protocol/src/error.rs#L500-L559)
- [WebSocket error wrapper and status alias](https://github.com/openai/codex/blob/6ff1e1ca3b30fc8b914720681fcf5fe62e95f856/codex-rs/codex-api/src/endpoint/responses_websocket.rs#L669-L747)

The normalization tests also wrap this body in the supported WebSocket
`type:error` envelope with status 400. Upstream sends that complete envelope
through the same HTTP error translation, preserving it as the native message.
