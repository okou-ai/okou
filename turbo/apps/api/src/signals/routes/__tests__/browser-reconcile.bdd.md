# browser-reconcile

## browser-reconcile-001

- Vitest: "checks one instance over one native wire while preserving independent window outcomes"
- Mode: run
- Given: A signed-in member's chats A, B and C have Runs using separate windows of one shared Browser instance, and the member has opened Browsers for three more chats with `POST /api/chat-threads/:threadId/browser/open`. B's native window has closed at the provider and the health check for C's native window fails.
- When: The cron caller invokes `GET /api/cron/reconcile-browsers` with the cron secret; the member then reads A's, B's and C's Browsers, C's window health recovers, and C's Run calls `POST /api/browsers/use`.
- Then: The reconcile returns HTTP 200 with 1 error. It reads the provider session once, opens exactly one new native connection and sends six native commands. A keeps its window, B reads as `suspended`, and C keeps its window; C's later use returns the same window.

## browser-reconcile-002

- Vitest: "retains live bindings when the shared provider connection closes opening"
- Mode: run
- Given: A signed-in member's chats A and B have Runs using separate windows of one shared Browser instance. The provider's native connection is closed with code 1013 as soon as it opens (opening).
- When: The cron caller invokes `GET /api/cron/reconcile-browsers` with the cron secret, the member reads both Browsers, the cron runs again with a healthy connection, and B's Run calls `POST /api/browsers/use`.
- Then: The first reconcile returns HTTP 200 with 2 errors and opens exactly one native connection. A and B keep their windows and no provider session is stopped. The second reconcile reports 0 errors, and B's use returns its original window.

## browser-reconcile-003

- Vitest: "retains live bindings when the shared provider connection closes after-reply"
- Mode: run
- Given: A signed-in member's chats A and B have Runs using separate windows of one shared Browser instance. The provider's native connection closes with code 1013 after a window-bounds reply while the health reply for B's window is still pending (after-reply).
- When: The cron caller invokes `GET /api/cron/reconcile-browsers` with the cron secret, the member reads both Browsers, the cron runs again with a healthy connection, and B's Run calls `POST /api/browsers/use`.
- Then: The first reconcile returns HTTP 200 with 1 error and opens exactly one native connection. A and B keep their windows and no provider session is stopped. The second reconcile reports 0 errors, and B's use returns its original window.

## browser-reconcile-004

- Vitest: "rechecks expiry after batched health and preserves a concurrent renewal"
- Mode: run
- Given: A signed-in member's chats A and B have Runs using separate windows of one shared Browser instance. The clock is at nine minutes, and the provider holds the first native health reply for A's window.
- When: The cron caller invokes `GET /api/cron/reconcile-browsers`; while A's health check is held, the member renews B's Browser with `POST /api/chat-threads/:threadId/browser/lease` and the clock moves to 11 minutes; the reply is then released and the member reads both Browsers.
- Then: The reconcile returns HTTP 200 with 0 errors. A reads as `suspended`, B keeps its window and the idle expiry from its renewal, and no provider session is stopped.

## browser-reconcile-005

- Vitest: "reclaims expired usage before waiting on a live sibling's native health"
- Mode: run
- Given: A signed-in member's chats A and B have Runs using separate windows of one shared Browser instance. The member renews B at nine minutes and the clock moves to 11 minutes so A's idle lease has expired. The provider holds the native health reply for B's window.
- When: The cron caller invokes `GET /api/cron/reconcile-browsers`; while B's health check is held, the member reads A's and B's Browsers; the reply is then released.
- Then: While the check is held, A already reads as `suspended` and B keeps its window. The reconcile returns HTTP 200 with 0 errors, and no provider session is stopped.

## browser-reconcile-006

- Vitest: "bounds a withheld batch and recovers its retained native bindings"
- Mode: run
- Given: A signed-in member's chats A and B have Runs using separate windows of one shared Browser instance. The provider never replies to native window reads, and the Browser operation deadline expires once a reply is being withheld.
- When: The cron caller invokes `GET /api/cron/reconcile-browsers`, the member reads both Browsers, the provider resumes replying, and the cron runs again.
- Then: The first reconcile returns HTTP 200 with 2 errors and opens exactly one native connection, and A and B keep their windows. The second reconcile reports 0 errors and no provider session is stopped.

## browser-reconcile-007

- Vitest: "does not apply a late native observation to a replacement binding"
- Mode: run
- Given: A signed-in member's chats A and B have Runs using separate windows of one shared Browser instance. The provider holds the first native health reply for A's window.
- When: The cron caller invokes `GET /api/cron/reconcile-browsers`; while A's check is held, A's native window closes at the provider and A's Run calls `POST /api/browsers/use`; the held reply is then released and the member reads both Browsers.
- Then: A's use returns a new primary window. After the reconcile finishes, A still reads that replacement window and B keeps its original window.

## browser-reconcile-008

- Vitest: "keeps health transports and overlapping native window IDs separate across instances"
- Mode: run
- Given: Two different signed-in members, each with a chat Run using a Browser in their own provider instance. Both windows have the same native window ID but different instance IDs, and the provider reports both sessions as active.
- When: The cron caller invokes `GET /api/cron/reconcile-browsers` with the cron secret, and each member reads their own chat's Browser.
- Then: The reconcile returns HTTP 200 with 0 errors, reads the provider sessions twice and opens exactly one new native connection per instance. Each member's Browser still reports its own original window.
