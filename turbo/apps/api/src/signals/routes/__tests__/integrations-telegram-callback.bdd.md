# integrations-telegram-callback

## integrations-telegram-callback-001

- Vitest: "Telegram callback HTTP/browser protocol > fails closed without explicit callback context (fragment=false)"
- Mode: run
- Given: A browser opens the Telegram login callback with Telegram's login proof (id, first name, auth date, hash) in the query string and a target origin `https://app.okou.ai`, but without the `callbackProtocol`, `operationId` and `bot` context parameters. The opener window is open.
- When: The browser loads `GET /api/integrations/telegram/auth-callback` and runs the returned page script.
- Then: The response is HTTP 422, the page posts no message to the opener, and it performs no navigation.

## integrations-telegram-callback-002

- Vitest: "Telegram callback HTTP/browser protocol > fails closed without explicit callback context (fragment=true)"
- Mode: run
- Given: A browser opens the Telegram login callback with Telegram's login proof in the URL fragment and a target origin `https://app.okou.ai`, but without the `callbackProtocol`, `operationId` and `bot` context parameters. The opener window is open.
- When: The browser loads `GET /api/integrations/telegram/auth-callback` and runs the returned page script.
- Then: The response is HTTP 422, the page posts no message to the opener, and it performs no navigation.

## integrations-telegram-callback-003

- Vitest: "Telegram callback HTTP/browser protocol > scrubs proof and waits for a binding outcome (fragment=false)"
- Mode: run
- Given: A browser opens the Telegram login callback with full callback context (target origin `https://app.okou.ai`, protocol 2, an operation ID, bot `official`) and Telegram's login proof in the query string. The opener window at that origin is open.
- When: The browser loads `GET /api/integrations/telegram/auth-callback`; the opener then sends `telegram-auth-ready`, an identity acknowledgement and a `linked` result, and 250 ms pass.
- Then: The response is HTTP 200 with `cache-control: no-store` and `referrer-policy: no-referrer`. The page replaces its URL once with `?callbackProtocol=2` and posts `telegram-auth-bridge-ready` to the opener origin. After ready it posts `telegram-auth` with exactly the proof; the identity acknowledgement causes no navigation; the result is acknowledged with a `result` stage ack. After 250 ms it navigates to `https://app.okou.ai/settings/telegram?bot=official` and leaves no timers or listeners.

## integrations-telegram-callback-004

- Vitest: "Telegram callback HTTP/browser protocol > scrubs proof and waits for a binding outcome (fragment=true)"
- Mode: run
- Given: A browser opens the Telegram login callback with full callback context (target origin `https://app.okou.ai`, protocol 2, an operation ID, bot `official`) and Telegram's login proof in the URL fragment. The opener window at that origin is open.
- When: The browser loads `GET /api/integrations/telegram/auth-callback`; the opener then sends `telegram-auth-ready`, an identity acknowledgement and a `linked` result, and 250 ms pass.
- Then: The response is HTTP 200 with `cache-control: no-store` and `referrer-policy: no-referrer`. The page replaces its URL once with `?callbackProtocol=2` and posts `telegram-auth-bridge-ready` to the opener origin. After ready it posts `telegram-auth` with exactly the proof; the identity acknowledgement causes no navigation; the result is acknowledged with a `result` stage ack. After 250 ms it navigates to `https://app.okou.ai/settings/telegram?bot=official` and leaves no timers or listeners.

## integrations-telegram-callback-005

- Vitest: "Telegram callback HTTP/browser protocol > retries readiness and unacknowledged identity within the document deadline"
- Mode: run
- Given: A browser has loaded the Telegram login callback page with full context and login proof, and the opener window is open.
- When: 500 ms pass, the opener sends `telegram-auth-ready`, another 500 ms pass, the opener acknowledges the identity and sends ready again, and the page is hidden.
- Then: The page re-posts the bridge-ready message after 500 ms (two messages). After ready it posts the identity and re-sends the identical identity message after 500 ms without an acknowledgement. Once the identity is acknowledged, a further ready message is answered with `telegram-auth-bridge-ready` instead of the identity. After page hide no timers or listeners remain.

## integrations-telegram-callback-006

- Vitest: "Telegram callback HTTP/browser protocol > rejects wrong source, origin, operation, protocol and bot, including ready and ack"
- Mode: run
- Given: A browser has loaded the Telegram login callback page with full context and login proof, and the opener window at `https://app.okou.ai` is open.
- When: The page receives ready messages from another window, from `https://evil.example`, and with another operation ID, protocol 1 or bot `other`; then a valid ready; then `linked` results from another window, from another origin, with a stale operation, a string protocol or bot `other`, a result with unknown status `success`, and an identity ack from another window; then 500 ms pass.
- Then: None of the invalid ready messages is answered (the page has posted only its bridge-ready message). After the valid ready, none of the invalid results or acks is accepted: after 500 ms the page re-posts `telegram-auth` with the proof, and it never navigates.

## integrations-telegram-callback-007

- Vitest: "Telegram callback HTTP/browser protocol > accepts an early native-channel binding result and acknowledges duplicates without replay"
- Mode: run
- Given: A browser has loaded the Telegram login callback page with full context and login proof, and the opener window is open.
- When: Before any ready message, the opener sends a `linked` result carrying extra `returnUrl` and `hash` fields, then the same `linked` result, a ready message and a `failed` result; after 250 ms it sends the `linked` result again.
- Then: The page posts exactly its bridge-ready message and two `result` stage acknowledgements, never the identity proof. It navigates exactly once to `https://app.okou.ai/settings/telegram?bot=official`.

## integrations-telegram-callback-008

- Vitest: "Telegram callback HTTP/browser protocol > shows sanitized cancelled guidance without success navigation"
- Mode: run
- Given: A browser has loaded the Telegram login callback page with full context and login proof, and the opener window is open.
- When: The opener sends a result with status `cancelled` and an error text containing "secret" and a URL, and 250 ms pass.
- Then: The page does not navigate, its status text does not contain "secret", its settings link is `https://app.okou.ai/settings/telegram?bot=official`, and no listeners or timers remain.

## integrations-telegram-callback-009

- Vitest: "Telegram callback HTTP/browser protocol > shows sanitized failed guidance without success navigation"
- Mode: run
- Given: A browser has loaded the Telegram login callback page with full context and login proof, and the opener window is open.
- When: The opener sends a result with status `failed` and an error text containing "secret" and a URL, and 250 ms pass.
- Then: The page does not navigate, its status text does not contain "secret", its settings link is `https://app.okou.ai/settings/telegram?bot=official`, and no listeners or timers remain.

## integrations-telegram-callback-010

- Vitest: "Telegram callback HTTP/browser protocol > shows sanitized conflict guidance without success navigation"
- Mode: run
- Given: A browser has loaded the Telegram login callback page with full context and login proof, and the opener window is open.
- When: The opener sends a result with status `conflict` and an error text containing "secret" and a URL, and 250 ms pass.
- Then: The page does not navigate, its status text does not contain "secret", its settings link is `https://app.okou.ai/settings/telegram?bot=official`, and no listeners or timers remain.

## integrations-telegram-callback-011

- Vitest: "Telegram callback HTTP/browser protocol > shows sanitized expired guidance without success navigation"
- Mode: run
- Given: A browser has loaded the Telegram login callback page with full context and login proof, and the opener window is open.
- When: The opener sends a result with status `expired` and an error text containing "secret" and a URL, and 250 ms pass.
- Then: The page does not navigate, its status text does not contain "secret", its settings link is `https://app.okou.ai/settings/telegram?bot=official`, and no listeners or timers remain.

## integrations-telegram-callback-012

- Vitest: "Telegram callback HTTP/browser protocol > shows sanitized interrupted guidance without success navigation"
- Mode: run
- Given: A browser has loaded the Telegram login callback page with full context and login proof, and the opener window is open.
- When: The opener sends a result with status `interrupted` and an error text containing "secret" and a URL, and 250 ms pass.
- Then: The page does not navigate, its status text does not contain "secret", its settings link is `https://app.okou.ai/settings/telegram?bot=official`, and no listeners or timers remain.

## integrations-telegram-callback-013

- Vitest: "Telegram callback HTTP/browser protocol > shows sanitized prerequisite guidance without success navigation"
- Mode: run
- Given: A browser has loaded the Telegram login callback page with full context and login proof, and the opener window is open.
- When: The opener sends a result with status `prerequisite` and an error text containing "secret" and a URL, and 250 ms pass.
- Then: The page does not navigate, its status text does not contain "secret", its settings link is `https://app.okou.ai/settings/telegram?bot=official`, and no listeners or timers remain.

## integrations-telegram-callback-014

- Vitest: "Telegram callback HTTP/browser protocol > fails closed for malformed explicit context {\"callbackProtocol\":\"3\"} and scrubs proof"
- Mode: run
- Given: A browser opens the Telegram login callback with login proof in the query and otherwise valid context, but `callbackProtocol` is `3`. The opener window is open.
- When: The browser loads `GET /api/integrations/telegram/auth-callback` and runs the returned page script.
- Then: The response is HTTP 422, the page URL is scrubbed to `?callbackProtocol=2`, no message is posted, no navigation happens and no listeners remain.

## integrations-telegram-callback-015

- Vitest: "Telegram callback HTTP/browser protocol > fails closed for malformed explicit context {\"callbackProtocol\":\"\"} and scrubs proof"
- Mode: run
- Given: A browser opens the Telegram login callback with login proof in the query and otherwise valid context, but `callbackProtocol` is empty. The opener window is open.
- When: The browser loads `GET /api/integrations/telegram/auth-callback` and runs the returned page script.
- Then: The response is HTTP 422, the page URL is scrubbed to `?callbackProtocol=2`, no message is posted, no navigation happens and no listeners remain.

## integrations-telegram-callback-016

- Vitest: "Telegram callback HTTP/browser protocol > fails closed for malformed explicit context {\"operationId\":\"\"} and scrubs proof"
- Mode: run
- Given: A browser opens the Telegram login callback with login proof in the query and otherwise valid context, but `operationId` is empty. The opener window is open.
- When: The browser loads `GET /api/integrations/telegram/auth-callback` and runs the returned page script.
- Then: The response is HTTP 422, the page URL is scrubbed to `?callbackProtocol=2`, no message is posted, no navigation happens and no listeners remain.

## integrations-telegram-callback-017

- Vitest: "Telegram callback HTTP/browser protocol > fails closed for malformed explicit context {\"bot\":\"other\"} and scrubs proof"
- Mode: run
- Given: A browser opens the Telegram login callback with login proof in the query and otherwise valid context, but `bot` is `other`. The opener window is open.
- When: The browser loads `GET /api/integrations/telegram/auth-callback` and runs the returned page script.
- Then: The response is HTTP 422, the page URL is scrubbed to `?callbackProtocol=2`, no message is posted, no navigation happens and no listeners remain.

## integrations-telegram-callback-018

- Vitest: "Telegram callback HTTP/browser protocol > fails closed for malformed explicit context {\"bot\":\"\"} and scrubs proof"
- Mode: run
- Given: A browser opens the Telegram login callback with login proof in the query and otherwise valid context, but `bot` is empty. The opener window is open.
- When: The browser loads `GET /api/integrations/telegram/auth-callback` and runs the returned page script.
- Then: The response is HTTP 422, the page URL is scrubbed to `?callbackProtocol=2`, no message is posted, no navigation happens and no listeners remain.

## integrations-telegram-callback-019

- Vitest: "Telegram callback HTTP/browser protocol > fails closed for malformed explicit context {\"targetOrigin\":\"https://evil.example\"} and scrubs proof"
- Mode: run
- Given: A browser opens the Telegram login callback with login proof in the query and otherwise valid context, but `targetOrigin` is `https://evil.example`. The opener window is open.
- When: The browser loads `GET /api/integrations/telegram/auth-callback` and runs the returned page script.
- Then: The response is HTTP 422, the page URL is scrubbed to `?callbackProtocol=2`, no message is posted, no navigation happens and no listeners remain.

## integrations-telegram-callback-020

- Vitest: "Telegram callback HTTP/browser protocol > fails closed for malformed explicit context {\"targetOrigin\":\"https://app.okou.ai/path\"} and scrubs proof"
- Mode: run
- Given: A browser opens the Telegram login callback with login proof in the query and otherwise valid context, but `targetOrigin` is `https://app.okou.ai/path` (an origin with a path). The opener window is open.
- When: The browser loads `GET /api/integrations/telegram/auth-callback` and runs the returned page script.
- Then: The response is HTTP 422, the page URL is scrubbed to `?callbackProtocol=2`, no message is posted, no navigation happens and no listeners remain.

## integrations-telegram-callback-021

- Vitest: "Telegram callback HTTP/browser protocol > fails closed for malformed explicit context {\"targetOrigin\":\"\"} and scrubs proof"
- Mode: run
- Given: A browser opens the Telegram login callback with login proof in the query and otherwise valid context, but `targetOrigin` is empty. The opener window is open.
- When: The browser loads `GET /api/integrations/telegram/auth-callback` and runs the returned page script.
- Then: The response is HTTP 422, the page URL is scrubbed to `?callbackProtocol=2`, no message is posted, no navigation happens and no listeners remain.

## integrations-telegram-callback-022

- Vitest: "Telegram callback HTTP/browser protocol > rejects duplicate context and duplicate provider proof"
- Mode: run
- Given: A browser opens the Telegram login callback with full context and login proof, once with a duplicated `callbackProtocol` parameter and once with a second `hash` proof parameter. The opener window is open.
- When: The browser loads `GET /api/integrations/telegram/auth-callback` for each URL and runs the returned page script.
- Then: The duplicate-context request returns HTTP 422 and posts no message. The duplicate-proof page also posts no message to the opener.

## integrations-telegram-callback-023

- Vitest: "Telegram callback HTTP/browser protocol > discards proof with an absent opener and offers explicit settings"
- Mode: run
- Given: A browser opens the Telegram login callback with full context and login proof, but the page has no opener window.
- When: The browser loads `GET /api/integrations/telegram/auth-callback` and runs the returned page script.
- Then: The page posts no message, offers a settings link to `https://app.okou.ai/settings/telegram?bot=official`, does not navigate and leaves no timers.

## integrations-telegram-callback-024

- Vitest: "Telegram callback HTTP/browser protocol > discards proof with an closed opener and offers explicit settings"
- Mode: run
- Given: A browser opens the Telegram login callback with full context and login proof, but the opener window is already closed.
- When: The browser loads `GET /api/integrations/telegram/auth-callback` and runs the returned page script.
- Then: The page posts no message, offers a settings link to `https://app.okou.ai/settings/telegram?bot=official`, does not navigate and leaves no timers.

## integrations-telegram-callback-025

- Vitest: "Telegram callback HTTP/browser protocol > interrupts on opener closure and ignores late results after timeout"
- Mode: run
- Given: Two browsers load the Telegram login callback page with full context and login proof while their opener windows are open.
- When: In the first, the opener closes and 500 ms pass. In the second, the opener sends ready, 120 seconds pass, a `linked` result arrives, and another 500 ms pass.
- Then: The first page leaves no timers. The second page does not navigate after the late result and leaves no timers or listeners.

## integrations-telegram-callback-026

- Vitest: "Telegram callback HTTP/browser protocol > reloading the scrubbed URL cannot recover proof or close as a legacy callback"
- Mode: run
- Given: A browser loaded the Telegram login callback page with full context and login proof, which scrubbed its URL to `?callbackProtocol=2`, and the page was hidden.
- When: The browser reloads the scrubbed URL via `GET /api/integrations/telegram/auth-callback?callbackProtocol=2`.
- Then: The reloaded page posts no message, and its settings link points to the default app URL `http://localhost:3002/settings/telegram?bot=official`.

## integrations-telegram-callback-027

- Vitest: "Telegram callback HTTP/browser protocol > rejects a late result even when the browser has throttled its timers"
- Mode: run
- Given: A browser has loaded the Telegram login callback page with full context and login proof, and the browser throttles its timers so that 120,001 ms of wall-clock time pass without any timer firing.
- When: The opener then sends a `linked` result.
- Then: The page does not navigate and leaves no timers.

## integrations-telegram-callback-028

- Vitest: "Telegram callback HTTP/browser protocol > does not deliver identity if history scrubbing is unavailable"
- Mode: run
- Given: A browser opens the Telegram login callback with full context and login proof, and the browser refuses history URL replacement.
- When: The browser loads `GET /api/integrations/telegram/auth-callback` and runs the returned page script.
- Then: The page posts no message to the opener and leaves no timers.
