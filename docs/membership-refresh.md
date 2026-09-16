# Authorization membership refresh

The shared membership reader serves PAT and Agent authorization, GitHub/Slack/
Teams OAuth membership checks, and membership-aware run-error formatting. These
callers share the same process-local coordination, negative cache and limits.
The positive database cache retains its 60-second lifetime. Cache hits do not
renew that timestamp, and expired roles are never served while a refresh is
pending or Clerk is unavailable.

Each API process coalesces overlapping misses for the same `(orgId, userId)`.
The owner rechecks the database and shares the Clerk read and cache write with
its callers. There is no positive in-memory cache. In an overlapping burst,
P participating processes can still perform P refreshes, with up to 3P upstream
attempts for retryable Clerk failures. Different keys, cold starts, eviction and
non-overlapping failures can produce additional reads. This is not fleet-wide
deduplication or a global Clerk queue.

Definitive non-membership and deleted identity are separate negative results,
retained for five seconds from observation. Hits never extend expiry. A
non-member retains the existing user-only context; a deleted identity fails
authentication. Rejoining or identity recovery is observed after at most this
five-second cache window, plus provider/database latency. Fresh positive
database data takes precedence over a local negative. Negative storage holds
at most 512 keys; expired entries are pruned on misses and the oldest is evicted
at capacity. Eviction can increase provider reads, but cannot grant authority.
429, 5xx, transport, database and cancellation errors are never negative-cached.
Existing Clerk retry and HTTP error classifications remain in effect.

At most 512 refreshes are coordinated per process. Existing keys can still join
at capacity, and fresh database hits remain available. Excess cold keys fail
with a refresh-unavailable error. Each shared refresh has a 15-second deadline;
expiry produces the same error with a deadline reason. The PAT/Agent auth
boundary maps these errors to a non-cacheable 503. Other callers use their
existing OAuth or run-error handling paths; the shared reader does not convert
these failures into non-membership or prescribe their HTTP response.

One caller cancelling only stops its own wait. The final caller leaving aborts
the owner. Settlement, deadline or abandonment removes that exact owner, so
late work cannot remove a replacement refresh. The deadline timer is cancelled
when ownership ends.

Clerk SDK 3.13.1 does not expose cancellation for the membership HTTP request.
Logical cancellation releases coordination and observes any late promise
settlement; it does not claim to stop that network request. Abort checks prevent
late provider results from starting cache writes. A database write already
issued cannot be rolled back by an AbortSignal; its timestamp was fixed before
issuance and followers never renew it. No database transaction is held across
Clerk work. These limits describe application coordination, not a global bound
on provider sockets or database execution time.

There is no schema, token or response-format migration. Old and new API instances
can coexist; old instances retain their previous request amplification. Source
and test counts are not measurements of production traffic or 429 incidence.
