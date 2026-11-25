# hosted-site-scope

## hosted-site-scope-001

- Vitest: "thread-independent hosted publication through host APIs > redeploys one organization site across chats"
- Mode: run
- Given: An organization owner has prepared a deployment for a site through their session and can publish from two different chat Runs.
- When: Each Run uses its issued bearer token to prepare the same site from its own thread with different content.
- Then: All three preparations return the same site ID, public slug and URL with versions 1, 2 and 3.

## hosted-site-scope-002

- Vitest: "thread-independent hosted publication through host APIs > resubmits concurrent cross-chat allocation conflicts and rejects other owners"
- Mode: run
- Given: An organization owner has prepared version 1 of a site and has active Runs in three distinct chats. Another member belongs to the same organization.
- When: All three Run tokens concurrently prepare the same site, retry any allocation conflict with the original request, then the other member tries the same site name.
- Then: Any concurrent conflict returns HTTP 409 and asks the owner to retry publishing the same site. Successful results retain the site ID and slug and give versions 2, 3 and 4. The other member gets HTTP 409 explaining that the site belongs to another owner and asking for a different site name.
