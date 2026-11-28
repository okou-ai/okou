# workflow-owner-profile-negative-cache

## workflow-owner-profile-negative-cache-001

- Vitest: "workflow owner profile negative cache > evicts the oldest missing owner only after reaching 512 entries"
- Mode: run
- Intent: review
- Given: A new owner-profile cache records 512 distinct missing owners at the same timestamp.
- When: The first and last owners are checked, then a 513th missing owner is recorded.
- Then: Both original checks are present at capacity. After the additional record, the oldest entry is gone, and the second and newest entries remain.

## workflow-owner-profile-negative-cache-002

- Vitest: "workflow owner profile negative cache > expires missing owners after sixty seconds"
- Mode: run
- Intent: review
- Given: A missing owner has been recorded at time 1000 milliseconds.
- When: The cache is queried at time 60,999 milliseconds and again at 61,000 milliseconds.
- Then: The first lookup reports a cached miss. The second lookup finds that the cached miss has expired.
