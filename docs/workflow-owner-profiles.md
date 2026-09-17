# Workflow owner display profiles

Ordinary workflow list, detail, and mutation responses contain `ownerUserId`
but do not resolve or serialize owner names or avatars. CLI list, ID lookup,
and name resolution keep their existing request paths and output. This removes
profile enrichment only; authentication and membership can still call Clerk.

`GET /api/workflows/:workflowId/owner-profile` applies the existing workflow
read authentication, organization and visibility rules before any cache lookup.
It derives the author from `ownerUserId`, which remains the meaning of the
existing **Created by** label. It loads no volume files or automations and
returns only nullable `displayName` and `imageUrl` fields. Invisible workflows
return the ordinary non-disclosing 404; a confirmed missing Clerk user returns
200 with both fields null.

The list and detail title tooltips share one loader. Pointer or keyboard open
starts the request; rendering and a pointer pass that never opens the tooltip
do not. Title, description and **Runs as** remain independent of the author
request. The author row has localized loading, unavailable and retry guidance.
Close/reopen retries errors without failing workflow operations.

## Cache ownership

| Layer                    | Scope and bound                                                                      | Freshness and cleanup                                                                                                                                                                                      |
| ------------------------ | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| API positive cache       | Existing shared `user_cache`, unchanged schema and other consumers                   | Existing 15-minute TTL; refresh via the controlled direct Clerk `getUser` gateway. Users without email are returned without inserting a fabricated address.                                                |
| API negative cache       | One process; at most 512 owner IDs                                                   | Only an authoritative Clerk 404; 60 seconds. Prune expired entries on access and evict the oldest at capacity. Never return stale cached identity after a confirmed miss.                                  |
| API refresh coalescing   | One process; at most 512 concurrent owner IDs                                        | Request consumers share a refresh. Final consumer settlement/cancellation removes it; final cancellation aborts the shared work. Excess concurrent owners receive retryable 503.                           |
| App cache and coalescing | One Store and page, at most 32 workflow IDs, scoped to current user and organization | Success: 15 minutes; unavailable: 60 seconds. Prune on access and evict the oldest settled entry at capacity. Errors are removed; pending entries are coalesced and never evicted to start duplicate work. |

App requests belong to the page, so closing one tooltip cannot cancel another
consumer. A Clerk identity change aborts pending work and clears cached data;
page teardown also removes the Clerk listener. Results carry page/user/org and
workflow identity, so a late response cannot render under a different identity.
Caches are filled only by tooltip opens. TTL is checked on the next open, not by
background polling.

API refresh and negative-cache guarantees are instance-local. Cold starts and
different instances may independently read Clerk; this is not fleet-wide
deduplication. Clerk rate limits retain `Retry-After`, exhausted 5xx retries
return 503, and network failures remain errors. Neither these failures nor
cancellation populate the negative cache. Gateway retry and cancellation
boundaries remain unchanged.

## Deployment compatibility

| Pairing                  | Behavior                                                                                                                                                                                |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Old App / new API        | The removed fields were optional and nullable. Parsing continues to work; an already-open App temporarily shows its existing owner-ID fallback until refresh.                           |
| New App / old API        | An absent endpoint's 404 takes the ordinary author-row error path. Reopening retries; it is never cached as a deleted user. The rest of the tooltip and workflow operations still work. |
| Old or new CLI / new API | No author fields or endpoint calls are needed for list/view/name resolution.                                                                                                            |
| New App / new API        | Only actual tooltip opens request display profiles.                                                                                                                                     |

There is no stored-state migration, eager compatibility lookup, or new App
version floor. The author-row error presentation is the permanent recovery
behavior for an optional display request, including rollback to an API without
this endpoint; there is no separate legacy protocol reader to retire.
