# ios-notifications

## ios-notifications-001

- Vitest: "iOS notification read-state reconciliation > dismisses archived reminders across clients without changing reading state"
- Mode: run
- Given: A signed-in member with a Pro entitlement has two chats whose runs ended (one left unread, one marked read), and an iPhone installation registered for push; APNs accepts badge updates.
- When: The member's iOS session posts `POST /api/ios-notifications/reconcile` with a delivered notification for the unread chat, archives both chats, reconciles again, then unarchives both chats and reconciles from the registered installation.
- Then: The first reconcile returns `{ unreadCount: 1, removeIdentifiers: [] }`. After archiving, APNs receives a badge of 0 and reconcile returns `{ unreadCount: 0, removeIdentifiers: ["unread"] }`, while the chat indicators still show the archived chat as `unread` with an unread time and neither chat's `lastReadAt` changes. After unarchiving, APNs receives a badge of 1, reconcile reports `unreadCount` 1, the chat is still `unread`, and both `lastReadAt` values are unchanged.

## ios-notifications-002

- Vitest: "iOS notification read-state reconciliation > restores reminders when an unmuted archived chat receives a new result"
- Mode: run
- Given: A signed-in member with a Pro entitlement has a chat whose previous run ended unread, and a new run in that chat is in progress.
- When: The member archives the chat, the new run's Sandbox reports failure (exit code 1), and the member's iOS session posts `POST /api/ios-notifications/reconcile` with no notifications.
- Then: The chat metadata reads `archived: false`, its indicator is `unread`, and reconcile reports `unreadCount` 1.

## ios-notifications-003

- Vitest: "iOS notification read-state reconciliation > acknowledges only this installation's badge while preserving unread chats across workspaces"
- Mode: run
- Given: A signed-in member has an unread chat in their workspace and another in a second workspace of the same user; a phone and a tablet installation are registered for iOS push; the clock advances one second between steps.
- When: The phone reconciles with `badgeClearSequence: 1` via `POST /api/ios-notifications/reconcile`; a new unread chat appears and the phone reconciles again with the same cursor, and the tablet reconciles without one; the phone re-registers with the next revision and reconciles; the member marks the new chat read and the old chat unread, and the phone reconciles again.
- Then: The first phone reconcile returns `unreadCount` 2 and `badgeCount` 0, and the old chat stays in the unread list. After the new chat, the phone gets `unreadCount` 3 with `badgeCount` 1 and the tablet gets exactly `{ unreadCount: 3, removeIdentifiers: [] }`. After re-registration the phone still gets 3 and 1. After the read-state changes the phone gets `unreadCount` 2 and `badgeCount` 0.

## ios-notifications-004

- Vitest: "iOS notification read-state reconciliation > never lets a delayed foreground acknowledgement move the badge cursor backwards"
- Mode: run
- Given: A signed-in member has one unread chat and a registered iOS installation; the clock advances one second between steps.
- When: The installation reconciles with `badgeClearSequence: 1`, a second unread chat appears, the installation reconciles with `badgeClearSequence: 2`, and a delayed reconcile with `badgeClearSequence: 1` arrives at `POST /api/ios-notifications/reconcile`.
- Then: The delayed reconcile returns `unreadCount` 2 and `badgeCount` 0.

## ios-notifications-005

- Vitest: "iOS notification read-state reconciliation > binds badge acknowledgement to the exact installation revision and signed-in account"
- Mode: run
- Given: One installation is registered for a previous account, then re-registered at the next revision for a different signed-in account; the clock advances one second between steps.
- When: Each account reconciles its own binding with `badgeClearSequence: 1`; a new unread chat appears for the current account; the previous account reconciles its old binding with `badgeClearSequence: 2`; the current account reconciles with `badgeClearSequence: 1` via `POST /api/ios-notifications/reconcile`.
- Then: The current account's reconcile returns `unreadCount` 1 and `badgeCount` 1.

## ios-notifications-006

- Vitest: "iOS notification read-state reconciliation > counts owned unread conversations across workspaces and clears only read or unavailable receipts"
- Mode: run
- Given: A signed-in member owns a chat they have read and, in another workspace of the same user, an unread chat; another user owns an unread chat.
- When: The member's iOS session posts `POST /api/ios-notifications/reconcile` with notifications `read`, `unread`, `foreign` (the other user's chat) and `missing` (unknown IDs); then the member mutes the unread chat in the other workspace and reconciles again.
- Then: The first reconcile returns exactly `{ unreadCount: 1, removeIdentifiers: ["read", "foreign", "missing"] }`. After muting, it returns `{ unreadCount: 0, removeIdentifiers: ["read", "unread", "foreign", "missing"] }`.

## ios-notifications-007

- Vitest: "iOS notification read-state reconciliation > removes an older read run while preserving a newer unread run in the same conversation"
- Mode: run
- Given: A signed-in member read a chat after its first run ended, and a later run in the same chat ended unread.
- When: The member's iOS session posts `POST /api/ios-notifications/reconcile` with notification `older` for the first run and `newer` for the later run.
- Then: The response is exactly `{ unreadCount: 1, removeIdentifiers: ["older"] }`.

## ios-notifications-008

- Vitest: "iOS notification prefetch diagnostics > accepts payload-free observations from a native app session"
- Mode: run
- Given: A signed-in member has a native iOS app session for their workspace.
- When: The session posts `POST /api/ios-notifications/prefetch` with source `app`, a completed notification ID, thread and run IDs, outcome `saved`, duration 120 ms, last sequence 42 and `containsRun: true`.
- Then: The API returns HTTP 200 with exactly `{ success: true }`.

## ios-notifications-009

- Vitest: "iOS notification prefetch diagnostics > accepts payload-free observations from a native extension session"
- Mode: run
- Given: A signed-in member has a native iOS notification extension session for their workspace.
- When: The session posts `POST /api/ios-notifications/prefetch` with source `extension`, `observedAt` `2026-10-27T01:23:45.678Z`, a completed notification ID, thread and run IDs, outcome `saved`, duration 120 ms, last sequence 42 and `containsRun: true`.
- Then: The API returns HTTP 200 with exactly `{ success: true }`.
