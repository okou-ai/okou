# browser-profile-cleanup

## browser-profile-cleanup-001

- Vitest: "server-owned shared Browser recovery > publishes one owner instance and cleans only the losing profile during concurrent first opens"
- Mode: run
- Given: A signed-in member has two chats, A and B, whose Runs have not yet opened a Browser and have no provider profile. The provider holds each profile creation until both profile requests have arrived.
- When: A's Run and B's Run call `POST /api/browsers/use` concurrently.
- Then: One request returns HTTP 200 and the other HTTP 409. The provider created two profiles but received only one session request; the profile used by that session still exists (HTTP 200) and the other profile has been deleted (HTTP 404).

## browser-profile-cleanup-002

- Vitest: "server-owned shared Browser recovery > cancels a losing profile cleanup at its deadline without deleting the winner"
- Mode: run
- Given: A signed-in member has two chats, A and B, whose Runs have not yet opened a Browser. The provider holds both profile creations until both have arrived and then holds the second one further. The provider accepts profile deletion requests but never answers them.
- When: A's Run and B's Run call `POST /api/browsers/use` concurrently; after the first returns HTTP 200 the held profile creation is released, and once the losing profile's deletion has started the Browser operation deadline expires. The member then reads the winning chat's Browser with `GET /api/chat-threads/:threadId/browser`.
- Then: One use returns HTTP 200 and the other HTTP 502 with `BROWSER_USE_TIMEOUT`, and the pending profile deletion is cancelled. The provider created two profiles and received one session request; the deleted profile is not the one used by that session, which still exists (HTTP 200). The winning chat's Browser is `active` with the winner's window.

## browser-profile-cleanup-003

- Vitest: "server-owned shared Browser recovery > cleans an unadopted profile after the Run ends during preparation"
- Mode: run
- Given: A signed-in member's chat Run has not yet opened a Browser, and the provider holds its profile creation reply.
- When: The Run calls `POST /api/browsers/use`; after the provider has created the profile, the Run ends through the agent-complete webhook callback with exit code 1, and the profile creation reply is then released.
- Then: The callback returns HTTP 200 and the use returns HTTP 409. The provider received no session request, and every profile it created has been deleted (HTTP 404).
