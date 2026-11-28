# browser-expiry

## browser-expiry-001

- Vitest: "stops the last expired Browser after failed native window and restores only accepted URLs"
- Mode: run
- Given: A workspace member's chat A has a launched Run whose token acquired the only Browser. The member saved A's window at an accepted URL via `POST /api/chat-threads/:threadId/browser/close`, after which the page moved to an unsaved URL. The provider then fails to report A's native window ("Native window unavailable").
- When: At minute 11, after the idle lease has expired, A's Run token calls `POST /api/browsers/use` again.
- Then: The expired provider session is stopped and a new one started (one live session, one stopped, two session requests, one profile). The restored window is on a new Browser instance and contains only the accepted URL.

## browser-expiry-002

- Vitest: "stops the last expired Browser after failed empty capture and restores only accepted URLs"
- Mode: run
- Given: A workspace member's chat A has a launched Run whose token acquired the only Browser. The member saved A's window at an accepted URL via `POST /api/chat-threads/:threadId/browser/close`, after which the page moved to an unsaved URL. The provider then returns an empty capture of the window contents.
- When: At minute 11, after the idle lease has expired, A's Run token calls `POST /api/browsers/use` again.
- Then: The expired provider session is stopped and a new one started (one live session, one stopped, two session requests, one profile). The restored window is on a new Browser instance and contains only the accepted URL.

## browser-expiry-003

- Vitest: "stops the last expired Browser after failed encryption and restores only accepted URLs"
- Mode: run
- Given: A workspace member's chat A has a launched Run whose token acquired the only Browser. The member saved A's window at an accepted URL via `POST /api/chat-threads/:threadId/browser/close`, after which the page moved to an unsaved URL. The key management service then fails to encrypt captures ("KMS unavailable").
- When: At minute 11, after the idle lease has expired, A's Run token calls `POST /api/browsers/use` again.
- Then: The expired provider session is stopped and a new one started (one live session, one stopped, two session requests, one profile). The restored window is on a new Browser instance and contains only the accepted URL.

## browser-expiry-004

- Vitest: "retires expired A after failed native window without changing active B or importing residual URLs"
- Mode: run
- Given: A workspace member has chats A and B whose Runs share one Browser. A was saved at an accepted URL and then moved to an unsaved orphan URL; B's lease was renewed at minute 9 via `POST /api/chat-threads/:threadId/browser/lease`. The provider then fails to report A's native window and cannot close targets.
- When: At minute 11 A's Run token calls `POST /api/browsers/use`, and the member reads B with `GET /api/chat-threads/:threadId/browser`.
- Then: A's orphan page target is left untouched, B keeps its window and renewed idle expiry, and no provider session is stopped. A is restored on the same Browser instance in a new window containing only the accepted URL, B's window is still unchanged after the provider recovers, and only one provider session was ever requested.

## browser-expiry-005

- Vitest: "retires expired A after failed encryption without changing active B or importing residual URLs"
- Mode: run
- Given: A workspace member has chats A and B whose Runs share one Browser. A was saved at an accepted URL and then moved to an unsaved orphan URL; B's lease was renewed at minute 9 via `POST /api/chat-threads/:threadId/browser/lease`. The key management service then fails to encrypt captures, and the provider cannot close targets.
- When: At minute 11 A's Run token calls `POST /api/browsers/use`, and the member reads B with `GET /api/chat-threads/:threadId/browser`.
- Then: A's orphan page target is left untouched, B keeps its window and renewed idle expiry, and no provider session is stopped. A is restored on the same Browser instance in a new window containing only the accepted URL, B's window is still unchanged after recovery, and only one provider session was ever requested.

## browser-expiry-006

- Vitest: "preserves a healthy logical window on CDP failure: {\"code\":-32000,\"message\":\"Native health unavailable\"}"
- Mode: run
- Given: A workspace member's chat A has a launched Run whose token holds a Browser window (primary window 0). At minute 9 the provider's window-bounds health check fails with CDP error -32000 "Native health unavailable".
- When: A's Run token calls `POST /api/browsers/use`, the member reads `GET /api/chat-threads/:threadId/browser`, and after the provider recovers the member renews via `POST /api/chat-threads/:threadId/browser/lease`.
- Then: The use returns HTTP 502. The read shows the same window and original idle expiry, and no provider session is stopped. The renewal returns the same window, and only one provider session was ever requested.

## browser-expiry-007

- Vitest: "preserves a healthy logical window on CDP failure: {\"code\":-32601,\"message\":\"Browser window not found\"}"
- Mode: run
- Given: A workspace member's chat A has a launched Run whose token holds a Browser window (primary window 0). At minute 9 the provider's window-bounds health check fails with CDP error -32601 "Browser window not found".
- When: A's Run token calls `POST /api/browsers/use`, the member reads `GET /api/chat-threads/:threadId/browser`, and after the provider recovers the member renews via `POST /api/chat-threads/:threadId/browser/lease`.
- Then: The use returns HTTP 502. The read shows the same window and original idle expiry, and no provider session is stopped. The renewal returns the same window, and only one provider session was ever requested.

## browser-expiry-008

- Vitest: "preserves the native health timeout response and recovers the same window"
- Mode: run
- Given: A workspace member's chat A has a launched Run whose token holds a Browser window, and the provider withholds its native window health reply until the Browser deadline passes.
- When: The member renews with `POST /api/chat-threads/:threadId/browser/lease`, and after the provider replies again renews once more.
- Then: The first renewal returns HTTP 503 with error code `BROWSER_USE_TIMEOUT`. The second returns the same window, only one provider session was requested, and none was stopped.

## browser-expiry-009

- Vitest: "stops after the last chat deletion even when its native bridge is unavailable"
- Mode: run
- Given: A workspace member has chats A and B whose Runs share one Browser, and the provider's native bridge becomes unavailable.
- When: The member deletes chat A with `DELETE /api/chat-threads/:id`, reads B with `GET /api/chat-threads/:threadId/browser`, and then deletes chat B.
- Then: After deleting A, B keeps its window and the provider session remains. After deleting B, no provider session remains, exactly one session was stopped, and only one Browser profile was created.

## browser-expiry-010

- Vitest: "retires expired usage on failed provider lookup without treating the instance as stopped"
- Mode: run
- Given: A workspace member's chat A has a launched Run whose Browser window was saved at an accepted URL. The provider's lookup of that Browser instance returns HTTP 503 "Provider unavailable".
- When: A's Run token calls `POST /api/browsers/use` at minute 9 and again at minute 11 (after idle expiry), and then again after the provider lookup recovers.
- Then: The minute-9 call returns HTTP 502 without a new session request. The minute-11 call returns HTTP 409 with error code `BROWSER_RECLAIMING`, while the provider instance is still live, not stopped, and no new session is requested. After recovery the old instance is stopped, and the restored window is on a new Browser instance containing only the accepted URL, with one Browser profile created.

## browser-expiry-011

- Vitest: "rejects late old-lifetime encryption after degraded expiry and a newer accepted snapshot"
- Mode: run
- Given: A workspace member's chat A has a launched Run whose Browser window was saved at an accepted URL and then moved to a late URL. At minute 11 the expiry retirement's first capture encryption is held open by the key management service, and later captures fail until the member saves again.
- When: A's Run token calls `POST /api/browsers/use`; while encryption is held, the token reopens A, the member navigates to a new URL and saves via `POST /api/chat-threads/:threadId/browser/close` at minute 12; then the held encryption completes and A is reopened after its window is lost.
- Then: The intermediate reopen stops the expired session and restores a new Browser instance with only the original accepted URL. Both concurrent operations succeed, and the final reopen restores only the newer accepted URL (the late old-lifetime capture is not applied). Only one Browser profile was created.

## browser-expiry-012

- Vitest: "cancels silent retirement encryption at its existing deadline and stops the unused Browser"
- Mode: run
- Given: A workspace member's chat A has a launched Run whose Browser window was saved at an accepted URL and then moved to an unsaved URL. At minute 11 the retirement capture's encryption call does not finish before the retirement's existing 15-second deadline.
- When: A's Run token calls `POST /api/browsers/use`.
- Then: The encryption call is cancelled by the deadline, the unused provider session is stopped, and the restored window is on a new Browser instance containing only the accepted URL.
