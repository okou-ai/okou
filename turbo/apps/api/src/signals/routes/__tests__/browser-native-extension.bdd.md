# browser-native-extension

## browser-native-extension-001

- Vitest: "keeps public window health traffic constant as sibling tabs grow"
- Mode: run
- Given: A signed-in member's chats A and B have Runs using separate windows of one shared Browser instance. The member renews A's Browser once while B's window has one tab, and the provider's browser then gains 50 more tabs in B's window.
- When: The member renews A's Browser again with `POST /api/chat-threads/:threadId/browser/lease` and reads B's Browser with `GET /api/chat-threads/:threadId/browser`.
- Then: The second renewal sends exactly as many commands to the provider's browser as the first renewal did, and that count is greater than zero. B's Browser still reports its original window.

## browser-native-extension-002

- Vitest: "preserves scoped recovery after a native empty closing-window snapshot"
- Mode: run
- Given: A signed-in member's chats A and B have Runs using separate windows of one shared Browser instance. A's page was at `https://a.example.test/native-recovery` when the member closed A's Browser, and it later changed to `https://a.example.test/unsaved`. The member renews B at nine minutes, the clock moves to 11 minutes so A's idle lease has expired, and the Browser extension returns an empty tab list for the populated snapshot of a window.
- When: A's Run calls `POST /api/browsers/use` and the member reads B's Browser; the extension then returns normal snapshots again, A's Run calls use again, and the member reads B's Browser.
- Then: The first use returns HTTP 200, B keeps its original window, and there is one provider session request. The second use returns the same instance with a new primary window that contains only `https://a.example.test/native-recovery`. B still keeps its original window and there is still one provider session request.

## browser-native-extension-003

- Vitest: "preserves scoped recovery after a native unavailable bridge"
- Mode: run
- Given: A signed-in member's chats A and B have Runs using separate windows of one shared Browser instance. A's page was at `https://a.example.test/native-recovery` when the member closed A's Browser, and it later changed to `https://a.example.test/unsaved`. The member renews B at nine minutes, the clock moves to 11 minutes so A's idle lease has expired, and the required Browser extension bridge is unavailable.
- When: A's Run calls `POST /api/browsers/use` and the member reads B's Browser; the extension bridge then becomes available, A's Run calls use again, and the member reads B's Browser.
- Then: The first use returns HTTP 502, B keeps its original window, and there is one provider session request. The second use returns the same instance with a new primary window that contains only `https://a.example.test/native-recovery`. B still keeps its original window and there is still one provider session request.

## browser-native-extension-004

- Vitest: "restores accepted URLs and eventually stops the Browser after unfinished window close"
- Mode: run
- Given: A signed-in member's chats A and B have Runs using separate windows of one shared Browser instance, with A's page at `https://a.example.test/accepted`. The member renews B at nine minutes and the clock moves to 11 minutes so A's idle lease has expired. Closing a native window does not actually close it (unfinished window close).
- When: A's Run calls `POST /api/browsers/use`, A's old page then changes to another URL, and the member reads B's Browser. Window closing then works again, the clock moves to 30 minutes, A's Run calls use again, and the member reads B's Browser.
- Then: The first use returns the same instance with a new primary window whose only non-blank page is `https://a.example.test/accepted`, while A's old page still exists and its later URL is not restored. B keeps its window and there is one provider session request. After 30 minutes A gets a new instance, the provider has stopped one session and received two session requests, its only page is `https://a.example.test/accepted`, and B reads as `suspended`.

## browser-native-extension-005

- Vitest: "restores accepted URLs and eventually stops the Browser after lost close reply"
- Mode: run
- Given: A signed-in member's chats A and B have Runs using separate windows of one shared Browser instance, with A's page at `https://a.example.test/accepted`. The member renews B at nine minutes and the clock moves to 11 minutes so A's idle lease has expired. The Browser extension connection drops instead of replying to a window close (lost close reply).
- When: A's Run calls `POST /api/browsers/use` and the member reads B's Browser. Close replies then work again, the clock moves to 30 minutes, A's Run calls use again, and the member reads B's Browser.
- Then: The first use returns the same instance with a new primary window whose only non-blank page is `https://a.example.test/accepted`. B keeps its window and there is one provider session request. After 30 minutes A gets a new instance, the provider has stopped one session and received two session requests, its only page is `https://a.example.test/accepted`, and B reads as `suspended`.

## browser-native-extension-006

- Vitest: "restores accepted URLs and eventually stops the Browser after seed close error"
- Mode: run
- Given: A signed-in member's chats A and B have Runs using separate windows of one shared Browser instance, with A's page at `https://a.example.test/accepted`. The member renews B at nine minutes and the clock moves to 11 minutes so A's idle lease has expired. The provider's browser fails to close the seed page of a new window with an error (seed close error).
- When: A's Run calls `POST /api/browsers/use` and the member reads B's Browser. Page closing then works again, the clock moves to 30 minutes, A's Run calls use again, and the member reads B's Browser.
- Then: The first use returns the same instance with a new primary window whose only non-blank page is `https://a.example.test/accepted`. B keeps its window and there is one provider session request. After 30 minutes A gets a new instance, the provider has stopped one session and received two session requests, its only page is `https://a.example.test/accepted`, and B reads as `suspended`.

## browser-native-extension-007

- Vitest: "restores A's URLs while sibling native events advance the global sequence"
- Mode: run
- Given: A signed-in member's chats A and B have Runs using separate windows of one shared Browser instance, with A's page at `https://a.example.test/busy-sibling`. The member renews B at nine minutes. Every populated window snapshot is accompanied by a Browser extension tab-updated event for B's window. The clock moves to 11 minutes so A's idle lease has expired.
- When: A's Run calls `POST /api/browsers/use` and the member reads B's Browser with `GET /api/chat-threads/:threadId/browser`.
- Then: A receives the same instance, and its returned window contains only `https://a.example.test/busy-sibling`, and B keeps its original window.
