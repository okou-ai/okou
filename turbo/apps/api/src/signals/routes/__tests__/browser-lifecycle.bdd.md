# browser-lifecycle

## browser-lifecycle-001

- Vitest: "shared Browser public consumers > keeps screenshot attribution with out-of-order membership replies and moved=false"
- Mode: run
- Given: A signed-in member has two chats, A and B, whose Runs both use the shared Browser and receive separate windows in one provider instance. The provider answers the window lookup for A's page only after it has answered the lookup for B's page, and A's page stays in its own window while the screenshot is captured (moved=false).
- When: The member closes A's Browser with `POST /api/chat-threads/:threadId/browser/close`, background work completes, and the member reads both chats' Browsers with `GET /api/chat-threads/:threadId/browser`.
- Then: The close returns HTTP 200. A's Browser has a screenshot URL and exactly one WebP screenshot is uploaded, captured from A's page. B's Browser still reports its original window.

## browser-lifecycle-002

- Vitest: "shared Browser public consumers > keeps screenshot attribution with out-of-order membership replies and moved=true"
- Mode: run
- Given: A signed-in member has two chats, A and B, whose Runs both use the shared Browser and receive separate windows in one provider instance. The provider answers the window lookup for A's page only after it has answered the lookup for B's page, and A's page moves into B's window when the screenshot is captured (moved=true).
- When: The member closes A's Browser with `POST /api/chat-threads/:threadId/browser/close`, background work completes, and the member reads both chats' Browsers with `GET /api/chat-threads/:threadId/browser`.
- Then: The close returns HTTP 200. A's Browser has a null screenshot URL and no WebP screenshot is uploaded. B's Browser still reports its original window.

## browser-lifecycle-003

- Vitest: "shared Browser public consumers > reports a suspended Browser when its chat window expires during acquisition"
- Mode: run
- Given: A signed-in member's chat Run has used the shared Browser. The provider holds its reply to the session status read until the clock has advanced 11 minutes past the start, beyond the chat's idle lease.
- When: The member reads the chat's Browser with `GET /api/chat-threads/:threadId/browser?viewer=native` while the provider read is held, and the provider then replies with an active session.
- Then: The request returns HTTP 200 with the Browser status `suspended` and a null viewer.

## browser-lifecycle-004

- Vitest: "shared Browser public consumers > creates a proxyless shared Browser with the required extension"
- Mode: run
- Given: A signed-in member's chat Run is authenticated with its Run token and Browser Use is configured.
- When: The Run creates a Browser with `POST /api/browsers` and the name `Research browser`.
- Then: The request returns HTTP 201 with a Browser named `Research browser` in status `active` and the required Browser extension. The provider receives exactly one session request, with a null proxy country code.

## browser-lifecycle-005

- Vitest: "shared Browser public consumers > recovers a missing provider instance and preserves provider failures as failures"
- Mode: run
- Given: A signed-in member's chats A and B have Runs using separate windows of one shared Browser instance, with pages at `https://a.example.test/recovered` and `https://b.example.test/recovered`. The member has closed both chats' Browsers. The provider's session read then fails with HTTP 503.
- When: A's Run calls `POST /api/browsers/use`; the provider then reports the session as missing (HTTP 404) and its pages are gone, and A's Run calls use again, the member reads B's Browser, and B's Run calls use.
- Then: The first use returns HTTP 502 without a new provider session request. The second use returns a different instance, with still one provider profile created and two session requests in total; B reads as `suspended`; and the new instance contains only A's recovered URL. B's use joins the new instance with a window different from its original one, and that window contains only B's recovered URL.

## browser-lifecycle-006

- Vitest: "shared Browser public consumers > shares the owner Browser with a Slack chat and preserves its window after the Run ends"
- Mode: run
- Given: A signed-in member's web chat Run already uses the shared Browser. The member's workspace has Slack installed by the member, and a Slack `app_mention` from the member in a channel starts a Run that a Runner picks up.
- When: The Slack Run calls `POST /api/browsers/use`, then finishes through the agent-complete webhook callback with exit code 1, and the member reads the Slack chat's Browser with `GET /api/chat-threads/:threadId/browser`.
- Then: The Run log reports trigger source `slack`. The Slack chat's Browser is in the same instance as the web chat's Browser but in a different primary window. After the Run ends, the read returns HTTP 200 with the same window, and the provider received only one session request.

## browser-lifecycle-007

- Vitest: "shared Browser public consumers > provisions one profile and instance for two chats, reads and resizes only each owned window"
- Mode: run
- Given: A signed-in member has two chats, A and B, each with a Run authenticated by its Run token.
- When: A's Run calls `POST /api/browsers/use` and `GET /api/browsers/current`, the member resizes A's Browser to aspect ratio 2 with `POST /api/chat-threads/:threadId/browser/resize`, B's Run calls use, A's Run calls use again, and the member reads B's Browser. The clock then advances one minute, A's Run renews with `POST /api/browsers/lease`, and the member reads B's Browser again.
- Then: A's use returns the required extension and the provider CDP URL, and current and resize return A's same window. B receives the same extension and CDP URL in the same instance but a different primary window, and A's repeat use returns its original window, extension and CDP URL. The provider created one profile and received one session request using that profile with a null proxy country code. A's window is 1440x720 and B's is 1440x900, and B's read still shows its window. A's lease expires at start plus 11 minutes while B's still expires at start plus 10 minutes.

## browser-lifecycle-008

- Vitest: "shared Browser public consumers > captures only the chat URLs and reopens a new window without recreating the live owner instance"
- Mode: run
- Given: A signed-in member's chats A and B have Runs using separate windows of one shared Browser instance, with A's page at `https://a.example.test/saved` and B's at `https://b.example.test/private`. The member closes A's Browser, and the provider then closes A's native window.
- When: A's Run calls `POST /api/browsers/use`, B's Run calls use, the clock advances 11 minutes, A's Run calls use again, and the member reads B's Browser.
- Then: A's first reuse returns the same instance with a new primary window that restores only `https://a.example.test/saved`, B gets its original window, and there is still one provider session request. After 11 minutes A gets a new instance from a second session request that uses the same single profile with a null proxy country code, and the provider contains only `https://a.example.test/saved`. B's Browser reads as `suspended` with no window.

## browser-lifecycle-009

- Vitest: "shared Browser public consumers > retains chat metadata and preview while another chat replaces the owner instance"
- Mode: run
- Given: A signed-in member's chat A Run uses the shared Browser, and chat B's Run creates a Browser named `Travel research` whose page is at `https://travel.example.test/saved`. The member closes B's Browser and background work completes.
- When: The member reads B's Browser, the clock advances 11 minutes, A's Run calls `POST /api/browsers/use`, the member reads B's Browser again, and B's Run calls use.
- Then: B's first read has a screenshot URL. A receives a new instance. B then reads as `suspended` with the name `Travel research`, its original creation time and the same screenshot URL. B's use returns the same name and creation time, and its new window contains only `https://travel.example.test/saved`.

## browser-lifecycle-010

- Vitest: "shared Browser public consumers > preserves a named Browser and its preview while an earlier open is still resolving"
- Mode: run
- Given: A signed-in member's chat Run has used the shared Browser, and the provider holds its first native window reply for the next use.
- When: The Run calls `POST /api/browsers/use` again; while that call is held, the Run creates a Browser named `Trip planning` with `POST /api/browsers`, the member closes it with `POST /api/chat-threads/:threadId/browser/close` and reads it; then the held reply is released and the member reads the Browser again.
- Then: The create returns HTTP 201 with the name `Trip planning`, and the read after closing has a screenshot URL. After the earlier use completes, the Browser still has the same screenshot URL and the name `Trip planning`.

## browser-lifecycle-011

- Vitest: "shared Browser public consumers > preserves a new window's preview when the old window's screenshot upload finishes late"
- Mode: run
- Given: A signed-in member's chats A and B have Runs using the shared Browser. Object storage holds the first WebP screenshot upload until released.
- When: The member closes A's Browser, which starts the held screenshot upload. Meanwhile the provider closes A's original page, A's Run calls `POST /api/browsers/use`, the member closes A's Browser again and reads it; then the first upload is released and the member reads A's Browser once more.
- Then: A's replacement has a different primary window. The first upload contains a screenshot of A's old page, while the preview URL points to the second upload. After the late first upload finishes, A's preview URL is still the second upload's URL, and exactly two screenshots were uploaded.

## browser-lifecycle-012

- Vitest: "shared Browser capture publication and admission > distinguishes a closed native window when capturing recovery URLs"
- Mode: run
- Given: A signed-in member's chats A and B have Runs using separate windows of one shared Browser instance. A's page is at `https://a.example.test/recoverable` and the member has closed A's Browser once. The provider then closes A's native window (state `closed`).
- When: The member closes A's Browser again, the provider removes A's page, A's Run calls `POST /api/browsers/use`, and the member reads B's Browser.
- Then: A receives a new primary window whose only page is `https://a.example.test/recoverable`. B's Browser keeps its original window and idle expiry.

## browser-lifecycle-013

- Vitest: "shared Browser capture publication and admission > distinguishes a blank native window when capturing recovery URLs"
- Mode: run
- Given: A signed-in member's chats A and B have Runs using separate windows of one shared Browser instance. A's page is at `https://a.example.test/recoverable` and the member has closed A's Browser once. A's native window then navigates to `about:blank` (state `blank`).
- When: The member closes A's Browser again, the provider removes A's page, A's Run calls `POST /api/browsers/use`, and the member reads B's Browser.
- Then: A receives a new primary window whose only page is `about:blank`. B's Browser keeps its original window and idle expiry.

## browser-lifecycle-014

- Vitest: "shared Browser capture publication and admission > keeps the restored winner when native loser cleanup succeeds=true"
- Mode: run
- Given: A signed-in member's chats A and B have Runs using separate windows of one shared Browser instance. A's window has pages at `https://a.example.test/first` and `https://a.example.test/second`; the member closes A's Browser and the provider then closes A's native window. Provider window creation is held until two windows have been requested, and closing a losing window succeeds (succeeds=true).
- When: A's Run calls `POST /api/browsers/use`, and after the first new window is requested a second use for A starts concurrently.
- Then: One use returns HTTP 200 and the other HTTP 409 with `BROWSER_RECLAIMING`. A's Browser reads the winner's window, which contains exactly the two saved URLs. The provider has only the winner's window and B's window, B keeps its window and idle expiry, and there is still one provider session request.

## browser-lifecycle-015

- Vitest: "shared Browser capture publication and admission > keeps the restored winner when native loser cleanup succeeds=false"
- Mode: run
- Given: A signed-in member's chats A and B have Runs using separate windows of one shared Browser instance. A's window has pages at `https://a.example.test/first` and `https://a.example.test/second`; the member closes A's Browser and the provider then closes A's native window. Provider window creation is held until two windows have been requested, and closing a losing window fails (succeeds=false).
- When: A's Run calls `POST /api/browsers/use`, and after the first new window is requested a second use for A starts concurrently.
- Then: One use returns HTTP 200 and the other HTTP 409 with `BROWSER_RECLAIMING`. A's Browser reads the winner's window, which contains exactly the two saved URLs. The provider keeps both newly created windows plus B's window, B keeps its window and idle expiry, and there is still one provider session request.

## browser-lifecycle-016

- Vitest: "shared Browser capture publication and admission > keeps newer recovery URLs after a delayed native reply with previous=false and retirement=missing"
- Mode: run
- Given: A signed-in member's chats A and B have Runs using separate windows of one shared Browser instance, with no earlier close of A (previous=false). The provider holds its first native window reply for A's window. A's page shows `https://a.example.test/older-observation` at one second after start.
- When: The member closes A's Browser with `POST /api/chat-threads/:threadId/browser/close`; while that capture is held, the clock moves to two seconds, A's page changes to `https://a.example.test/newer-accepted` and the member closes A's Browser again; the held reply is then released at three seconds. The provider then removes A's native window (retirement=missing), and A's Run calls `POST /api/browsers/use`.
- Then: Both closes return HTTP 200. A receives the same instance with a new primary window that contains only `https://a.example.test/newer-accepted`. B keeps its original window and idle expiry.

## browser-lifecycle-017

- Vitest: "shared Browser capture publication and admission > keeps newer recovery URLs after a delayed native reply with previous=true and retirement=missing"
- Mode: run
- Given: A signed-in member's chats A and B have Runs using separate windows of one shared Browser instance. A's page was at `https://a.example.test/previous` and the member closed A's Browser once (previous=true). The provider holds its next native window reply for A's window. A's page shows `https://a.example.test/older-observation` at one second after start.
- When: The member closes A's Browser; while that capture is held, the clock moves to two seconds, A's page changes to `https://a.example.test/newer-accepted` and the member closes A's Browser again; the held reply is then released at three seconds. The provider then removes A's native window (retirement=missing), and A's Run calls `POST /api/browsers/use`.
- Then: The closes return HTTP 200. A receives the same instance with a new primary window that contains only `https://a.example.test/newer-accepted`. B keeps its original window and idle expiry.

## browser-lifecycle-018

- Vitest: "shared Browser capture publication and admission > keeps newer recovery URLs after a delayed native reply with previous=true and retirement=healthy"
- Mode: run
- Given: A signed-in member's chats A and B have Runs using separate windows of one shared Browser instance. A's page was at `https://a.example.test/previous` and the member closed A's Browser once (previous=true). The provider holds its next native window reply for A's window. A's page shows `https://a.example.test/older-observation` at one second after start.
- When: The member closes A's Browser; while that capture is held, the clock moves to two seconds, A's page changes to `https://a.example.test/newer-accepted` and the member closes A's Browser again; the held reply is released at three seconds. At nine minutes the member renews B with `POST /api/chat-threads/:threadId/browser/lease`, A's native window stays healthy (retirement=healthy), the clock moves to 11 minutes, and A's Run calls `POST /api/browsers/use`.
- Then: A receives the same instance with a new primary window that contains only `https://a.example.test/newer-accepted`. B keeps its original window, and its idle expiry is start plus 19 minutes.

## browser-lifecycle-019

- Vitest: "shared Browser capture publication and admission > keeps newer recovery URLs after a delayed native reply with previous=true and retirement=unavailable"
- Mode: run
- Given: A signed-in member's chats A and B have Runs using separate windows of one shared Browser instance. A's page was at `https://a.example.test/previous` and the member closed A's Browser once (previous=true). The provider holds its next native window reply for A's window. A's page shows `https://a.example.test/older-observation` at one second after start.
- When: The member closes A's Browser; while that capture is held, the clock moves to two seconds, A's page changes to `https://a.example.test/newer-accepted` and the member closes A's Browser again; the held reply is released at three seconds. At nine minutes the member renews B with `POST /api/chat-threads/:threadId/browser/lease`, the provider then fails native window reads for A's window (retirement=unavailable), the clock moves to 11 minutes, and A's Run calls `POST /api/browsers/use`.
- Then: A receives the same instance with a new primary window that contains only `https://a.example.test/newer-accepted`. B keeps its original window, and its idle expiry is start plus 19 minutes.

## browser-lifecycle-020

- Vitest: "shared Browser capture publication and admission > keeps newer close URLs when a delayed native retirement capture wins closing"
- Mode: run
- Given: A signed-in member's chats A and B have Runs using separate windows of one shared Browser instance. At nine minutes the member renews B's Browser. The provider holds its first native window reply for A's window. At 11 minutes, after A's idle lease has expired, A's page shows `https://a.example.test/older-retirement`.
- When: A's Run calls `POST /api/browsers/use`, whose retirement capture of A's old window is held; one second later A's page changes to `https://a.example.test/newer-accepted` and the member closes A's Browser with `POST /api/chat-threads/:threadId/browser/close`; the held reply is then released and the member reads B's Browser.
- Then: The close returns HTTP 200 and the use completes in the same instance with a new primary window that contains only `https://a.example.test/newer-accepted`. B keeps its original window and the idle expiry from its renewal.

## browser-lifecycle-021

- Vitest: "shared Browser capture publication and admission > keeps the newer preview after a delayed native screenshot with previous=false"
- Mode: run
- Given: A signed-in member's chat Run uses the shared Browser and the Browser has not been closed before (previous=false). The provider holds its first native screenshot reply.
- When: At one second the member closes the Browser with `POST /api/chat-threads/:threadId/browser/close`; while its screenshot is held, at two seconds the member closes it again and reads it; the held screenshot is then released at three seconds and the member reads the Browser again.
- Then: Both closes return HTTP 200. The read after the second close has a screenshot URL, and after the earlier screenshot completes the Browser still reports that same screenshot URL.

## browser-lifecycle-022

- Vitest: "shared Browser capture publication and admission > keeps the newer preview after a delayed native screenshot with previous=true"
- Mode: run
- Given: A signed-in member's chat Run uses the shared Browser, and the member has already closed it once so that it has a screenshot URL (previous=true). The provider holds its next native screenshot reply.
- When: At one second the member closes the Browser with `POST /api/chat-threads/:threadId/browser/close`; while its screenshot is held, at two seconds the member closes it again and reads it; the held screenshot is then released at three seconds and the member reads the Browser again.
- Then: The first read has a screenshot URL. Both later closes return HTTP 200, the read after the newest close has a screenshot URL, and after the earlier screenshot completes the Browser still reports that newest screenshot URL.

## browser-lifecycle-023

- Vitest: "shared Browser capture publication and admission > preserves the newer same-window preview with sequential completion"
- Mode: run
- Given: A signed-in member's chat Run uses the shared Browser. Each native screenshot returns distinct content, and object storage holds the first WebP screenshot upload.
- When: The member closes the Browser with `POST /api/chat-threads/:threadId/browser/close`; once its upload is held, the upload is released and that close completes (sequential completion); the member then closes the Browser again and reads it with `GET /api/chat-threads/:threadId/browser`, and reads it once more afterward.
- Then: Both closes return HTTP 200. The reads keep the original window, the uploads are `capture:1` then `capture:2`, and the screenshot URL points to the second upload. The final read still reports the second upload's screenshot URL.

## browser-lifecycle-024

- Vitest: "shared Browser capture publication and admission > preserves the newer same-window preview with older-last completion"
- Mode: run
- Given: A signed-in member's chat Run uses the shared Browser. Each native screenshot returns distinct content, and object storage holds the first WebP screenshot upload.
- When: The member closes the Browser with `POST /api/chat-threads/:threadId/browser/close`; while its upload is held, the member closes the Browser again and reads it with `GET /api/chat-threads/:threadId/browser`; the first upload is then released (older-last completion) and the member reads the Browser again.
- Then: Both closes return HTTP 200. The reads keep the original window, the uploads are `capture:1` then `capture:2`, and the screenshot URL points to the second upload. After the older upload finishes, the Browser still reports the second upload's screenshot URL.

## browser-lifecycle-025

- Vitest: "shared Browser capture publication and admission > preserves the newer same-window preview with older-first completion"
- Mode: run
- Given: A signed-in member's chat Run uses the shared Browser. Each native screenshot returns distinct content, and object storage holds the first WebP screenshot upload.
- When: The member closes the Browser with `POST /api/chat-threads/:threadId/browser/close`; while its upload is held, the clock advances one minute and the member closes the Browser again; when the second upload starts, the first upload is released and the first close completes before the second upload continues (older-first completion). The member then reads the Browser with `GET /api/chat-threads/:threadId/browser` and reads it again afterward.
- Then: Both closes return HTTP 200. The reads keep the original window, the uploads are `capture:1` then `capture:2`, and the screenshot URL points to the second upload. The final read still reports the second upload's screenshot URL.

## browser-lifecycle-026

- Vitest: "shared Browser capture publication and admission > restores newer URLs with reverse=false, clocks=0/0 and warmup=false"
- Mode: run
- Given: A signed-in member's chats A and B have Runs using separate windows of one shared Browser instance, with no earlier close of A (warmup=false). Key-management encryption of the first saved Browser snapshot is held.
- When: At the start time A's page shows `https://a.example.test/older` and the member closes A's Browser with `POST /api/chat-threads/:threadId/browser/close`; once that save reaches encryption it is released and completes (reverse=false); still at the start time (clocks=0/0) A's page changes to `https://a.example.test/newer` and the member closes A's Browser again. The provider then removes A's native window, A's Run calls `POST /api/browsers/use`, and the member reads B's Browser.
- Then: Both closes return HTTP 200. A receives the same instance with a new primary window that contains only `https://a.example.test/newer`. B keeps its original window and idle expiry.

## browser-lifecycle-027

- Vitest: "shared Browser capture publication and admission > restores newer URLs with reverse=true, clocks=0/0 and warmup=false"
- Mode: run
- Given: A signed-in member's chats A and B have Runs using separate windows of one shared Browser instance, with no earlier close of A (warmup=false). Key-management encryption of the first saved Browser snapshot is held.
- When: At the start time A's page shows `https://a.example.test/older` and the member closes A's Browser with `POST /api/chat-threads/:threadId/browser/close`; while that save is held (reverse=true), still at the start time (clocks=0/0) A's page changes to `https://a.example.test/newer` and the member closes A's Browser again; the held encryption is then released. The provider then removes A's native window, A's Run calls `POST /api/browsers/use`, and the member reads B's Browser.
- Then: Both closes return HTTP 200. A receives the same instance with a new primary window that contains only `https://a.example.test/newer`. B keeps its original window and idle expiry.

## browser-lifecycle-028

- Vitest: "shared Browser capture publication and admission > restores newer URLs with reverse=false, clocks=0/-60000 and warmup=false"
- Mode: run
- Given: A signed-in member's chats A and B have Runs using separate windows of one shared Browser instance, with no earlier close of A (warmup=false). Key-management encryption of the first saved Browser snapshot is held.
- When: At the start time A's page shows `https://a.example.test/older` and the member closes A's Browser with `POST /api/chat-threads/:threadId/browser/close`; once that save reaches encryption it is released and completes (reverse=false); the clock then moves to one minute before the start (clocks=0/-60000), A's page changes to `https://a.example.test/newer` and the member closes A's Browser again. The provider then removes A's native window, A's Run calls `POST /api/browsers/use`, and the member reads B's Browser.
- Then: Both closes return HTTP 200. A receives the same instance with a new primary window that contains only `https://a.example.test/newer`. B keeps its original window and idle expiry.

## browser-lifecycle-029

- Vitest: "shared Browser capture publication and admission > restores newer URLs with reverse=true, clocks=0/60000 and warmup=false"
- Mode: run
- Given: A signed-in member's chats A and B have Runs using separate windows of one shared Browser instance, with no earlier close of A (warmup=false). Key-management encryption of the first saved Browser snapshot is held.
- When: At the start time A's page shows `https://a.example.test/older` and the member closes A's Browser with `POST /api/chat-threads/:threadId/browser/close`; while that save is held (reverse=true), the clock moves one minute later (clocks=0/60000), A's page changes to `https://a.example.test/newer` and the member closes A's Browser again; the held encryption is then released. The provider then removes A's native window, A's Run calls `POST /api/browsers/use`, and the member reads B's Browser.
- Then: Both closes return HTTP 200. A receives the same instance with a new primary window that contains only `https://a.example.test/newer`. B keeps its original window and idle expiry.

## browser-lifecycle-030

- Vitest: "shared Browser capture publication and admission > restores newer URLs with reverse=true, clocks=90000/60000 and warmup=true"
- Mode: run
- Given: A signed-in member's chats A and B have Runs using separate windows of one shared Browser instance. A's page was at `https://a.example.test/initial` and the member closed A's Browser two minutes after the start (warmup=true). Key-management encryption of the next saved Browser snapshot is held.
- When: At 90 seconds after the start A's page shows `https://a.example.test/older` and the member closes A's Browser with `POST /api/chat-threads/:threadId/browser/close`; while that save is held (reverse=true), the clock moves to 60 seconds after the start (clocks=90000/60000), A's page changes to `https://a.example.test/newer` and the member closes A's Browser again; the held encryption is then released. The provider then removes A's native window, A's Run calls `POST /api/browsers/use`, and the member reads B's Browser.
- Then: All closes return HTTP 200. A receives the same instance with a new primary window that contains only `https://a.example.test/newer`. B keeps its original window and idle expiry.

## browser-lifecycle-031

- Vitest: "shared Browser capture publication and admission > initializes native contents before publishing a window"
- Mode: run
- Given: A signed-in member's chat B Run uses the shared Browser. The provider reports each newly created sibling window at 1440x776 before replying.
- When: The member resizes B's Browser to aspect ratio 2 with `POST /api/chat-threads/:threadId/browser/resize`, and a Run of a new chat A then calls `POST /api/browsers/use`.
- Then: The resize returns HTTP 200 and B's window is 1440x720. A receives a window that is already 1440x900 when the use returns.

## browser-lifecycle-032

- Vitest: "shared Browser capture publication and admission > restores the saved chat URLs before publishing the replacement"
- Mode: run
- Given: A signed-in member's chats A and B have Runs using separate windows of one shared Browser instance, with A's page at `https://a.example.test/saved`. The member closes A's Browser and the provider then closes A's native window.
- When: A's Run calls `POST /api/browsers/use` and B's Run calls use.
- Then: A receives the same instance with a new primary window, B receives its original window, and A's new window contains only `https://a.example.test/saved` when the use returns.
