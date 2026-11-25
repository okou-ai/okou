# ios-push-registrations

## ios-push-registrations-001

- Vitest: "native iOS push registration > requires an active session and fences a late registration after unregister"
- Mode: run
- Given: A Clerk-authenticated workspace admin first has no session ID, then an active native session; the iOS installation binding is at revision 1 with a production device token.
- When: The caller sends `POST /api/ios-push-registrations` without a session, then with the active session; unregisters the installation at revision 3 with `DELETE /api/ios-push-registrations`; then registers again at revision 2 and at revision 4.
- Then: The sessionless registration returns HTTP 403 `FORBIDDEN`. The registration with the active session returns HTTP 200 and the revision 3 unregister returns HTTP 200. The late revision 2 registration returns HTTP 409, and the revision 4 registration returns HTTP 200.

## ios-push-registrations-002

- Vitest: "native iOS push registration > atomically rebinds accounts and rejects stale sign-out and token updates from the prior session"
- Mode: run
- Given: One iOS installation is used by two users in the same workspace, each signed in with an active native session.
- When: The first user registers it at revision 1 with `POST /api/ios-push-registrations`; the second user registers revision 2 with a new device token; the first user tries `DELETE /api/ios-push-registrations` at revision 3 and re-registration at revision 1; the second user registers revision 3, then from a replacement session registers revision 4, then from the original session unregisters at revision 5.
- Then: Both initial registrations return HTTP 200. The first user's stale unregister and re-registration both return HTTP 409. The second user's revision 3 registration returns HTTP 200 with `success` true, and the replacement session's revision 4 registration returns HTTP 200. The unregister from the earlier session returns HTTP 409.

## ios-push-registrations-003

- Vitest: "native iOS push registration > rejects a revoked session before creating a registration"
- Mode: run
- Given: A workspace admin is authenticated, but Clerk reports their session as `revoked` (parameter).
- When: The caller sends `POST /api/ios-push-registrations` with a new installation binding.
- Then: The API returns HTTP 401 with error code `UNAUTHORIZED`.

## ios-push-registrations-004

- Vitest: "native iOS push registration > rejects a expired session before creating a registration"
- Mode: run
- Given: A workspace admin is authenticated, but Clerk reports their active session as already expired (parameter: expired).
- When: The caller sends `POST /api/ios-push-registrations` with a new installation binding.
- Then: The API returns HTTP 401 with error code `UNAUTHORIZED`.
