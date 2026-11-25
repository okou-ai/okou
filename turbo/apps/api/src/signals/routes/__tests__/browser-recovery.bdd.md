# browser-recovery

## browser-recovery-001

- Vitest: "server-owned shared Browser recovery > bounds a silent native close and reopens without stopping its active sibling"
- Mode: run
- Given: A signed-in member's chats A and B have Runs using separate windows of one shared Browser instance, with A's page at `https://a.example.test/native-close-recovery`. The member renews B at nine minutes and the clock moves to 11 minutes so A's idle lease has expired. The Browser extension never replies to window close requests, and the Browser operation deadline expires once a close reply is withheld.
- When: A's Run calls `POST /api/browsers/use` and the member reads B's Browser with `GET /api/chat-threads/:threadId/browser`.
- Then: A's old page still exists at the provider. B keeps its window and the idle expiry from its renewal, no provider session is stopped, and there is one session request. A's use returns the same instance with a new primary window that contains only `https://a.example.test/native-close-recovery`.

## browser-recovery-002

- Vitest: "server-owned shared Browser recovery > preserves an accepted profile on lookup failure and replaces it only after confirmed deletion"
- Mode: run
- Given: A signed-in member's chat Run has used the shared Browser, whose page is at `https://a.example.test/restored`. The provider's lookup of the accepted profile fails with HTTP 503. The clock moves to 11 minutes so the idle lease has expired.
- When: The Run calls `POST /api/browsers/use`; the provider then reports the profile as missing with HTTP 404 and the Run calls use again.
- Then: The first use returns HTTP 502 with still one profile created and one session request. The second use succeeds after a second profile is created; the second session request uses the new profile, and the provider's only page is `https://a.example.test/restored`.

## browser-recovery-003

- Vitest: "server-owned shared Browser recovery > preserves another owner's accepted profile when the provider repeats its identity"
- Mode: run
- Given: A first member's chat Run has used a Browser with an accepted provider profile. A second member in another workspace has a chat Run, and the provider's profile creation returns the first member's existing profile identity.
- When: The second member's Run calls `POST /api/browsers/use`, and the first member's Run then calls use.
- Then: The second member's use returns HTTP 502 with `BROWSER_USE_INVALID_RESPONSE`. The first member's profile still exists (HTTP 200), no provider session is stopped, and the first member's use returns an `active` Browser.

## browser-recovery-004

- Vitest: "server-owned shared Browser recovery > preserves another owner instance when provider correlation repeats its ID"
- Mode: run
- Given: A first member's chat Run has used a Browser with a running provider session. A second member in another workspace has a chat Run. The provider's session creation fails with a network error, and its metadata search for the second member's new instance ID returns the first member's session ID.
- When: The second member's Run calls `POST /api/browsers/use`, the clock advances two minutes and it calls use again; the first member's Run then calls use.
- Then: The second member's uses return HTTP 502 and then HTTP 409. The first member's provider session is still running and no provider session is stopped, and the first member's use returns an `active` Browser.

## browser-recovery-005

- Vitest: "server-owned shared Browser recovery > finishes snapshot-ready final retirement through confirmed provider stop when native close fails"
- Mode: run
- Given: A signed-in member's chat Run uses the shared Browser, whose window has pages at `https://a.example.test/first` and `https://a.example.test/second`. Closing native windows has no effect until the provider receives a session stop request. The clock moves to 11 minutes so the idle lease has expired.
- When: The Run calls `POST /api/browsers/use`.
- Then: The use returns a new instance. The provider has stopped one session and received two session requests, and the new instance contains `https://a.example.test/first` and `https://a.example.test/second`.

## browser-recovery-006

- Vitest: "server-owned shared Browser recovery > recovers a lost create response only after finding its exact provider identity"
- Mode: run
- Given: A signed-in member's chat Run has not opened a Browser yet. The provider creates the first requested session but its response is lost with a network error, and the provider's metadata search initially returns no sessions.
- When: The Run calls `POST /api/browsers/use` twice, the clock advances two minutes and it calls use again; the provider's search then returns the lost session and the Run calls use once more.
- Then: The uses return HTTP 502, HTTP 409 and HTTP 409, with one session request and no session stopped. The final use stops the lost session and succeeds with one profile created and two session requests; the second request uses the same profile and the returned instance ID, which differs from the lost session's instance ID.

## browser-recovery-007

- Vitest: "server-owned shared Browser recovery > rejects ambiguous provider correlation without stopping an unrelated Browser"
- Mode: run
- Given: A signed-in member's chat Run has not opened a Browser yet. The provider's session creation always fails with a network error, and its metadata search returns one unrelated session tagged with a different instance ID.
- When: The Run calls `POST /api/browsers/use`, the clock advances two minutes, and it calls use again.
- Then: The uses return HTTP 502 and then HTTP 409. The provider receives exactly one session creation request and no provider session is stopped.

## browser-recovery-008

- Vitest: "server-owned shared Browser recovery > does not renew a missing native window and restores it without disturbing its sibling"
- Mode: run
- Given: A signed-in member's chats A and B have Runs using separate windows of one shared Browser instance, with A's page at `https://a.example.test/recovered`. The member closes A's Browser and the provider then closes A's page. The clock advances one minute.
- When: The member renews A's Browser with `POST /api/chat-threads/:threadId/browser/lease` and reads it, A's Run calls `POST /api/browsers/use`, and the member reads B's Browser.
- Then: The renewal returns HTTP 409 and A reads as `suspended`. A's use returns the same instance with a new primary window that contains only `https://a.example.test/recovered`. B's idle expiry is unchanged and there is one provider session request.
