# s3-list

## s3-list-001

- Vitest: "bounded S3 object listing provider contract > preserves first-page requests, zero-byte objects and cancellation ownership"
- Mode: run
- Intent: review
- Given: The first provider page in the user-storage bucket contains a zero-byte object under `chat-events/`, last modified at `2026-09-01T00:00:00Z`.
- When: A consumer requests a page of up to 1,000 objects with its own cancellation signal and no cursor.
- Then: S3 receives a single request for the bucket, prefix and limit with the caller's signal. The result is complete and retains the object's key, zero size and modification time.

## s3-list-002

- Vitest: "bounded S3 object listing provider contract > returns an empty completed page without fetching again"
- Mode: run
- Intent: review
- Given: S3 has no objects to return and marks the result complete.
- When: The consumer requests a bounded page under `chat-events/`.
- Then: The result is an empty complete page after one provider request.

## s3-list-003

- Vitest: "bounded S3 object listing provider contract > can continue past 1000 unchanged versions of one thread within its shard"
- Mode: run
- Intent: review
- Given: A chat event shard contains 1,501 S3 versions of one thread in provider key order.
- When: The consumer lists at most 1,000 keys and requests a second page using the last returned key as `StartAfter`.
- Then: The first result is truncated with 1,000 objects and the second is complete. The two pages together match every input key in order. S3 receives one request per page with the same shard prefix and limit.

## s3-list-004

- Vitest: "bounded S3 object listing provider contract > resumes after a key that was deleted between page requests"
- Mode: run
- Intent: review
- Given: A one-key page returns `chat-events/first`, which is then deleted. `chat-events/second` remains.
- When: The consumer asks for the next page using the deleted key as its cursor.
- Then: The provider request still uses `StartAfter: chat-events/first`, and the result contains only `chat-events/second`.

## s3-list-005

- Vitest: "bounded S3 object listing provider contract > uses UTF-8 provider key order rather than UTF-16 string order"
- Mode: run
- Intent: review
- Given: S3 returns keys under the same prefix ending in U+E000 and U+10000, in that order.
- When: The consumer lists a page of two keys.
- Then: The API returns the keys in the same order as S3.

## s3-list-006

- Vitest: "bounded S3 object listing provider contract > rejects a cursor outside the requested namespace"
- Mode: run
- Intent: review
- Given: The requested prefix is `chat-events/` and the cursor is `other/key`.
- When: A consumer supplies the cursor to a bounded list operation.
- Then: The operation throws `S3 list cursor must belong to its prefix` before any provider request.

## s3-list-007

- Vitest: "bounded S3 object listing provider contract > rejects another shard's cursor even inside the same bucket namespace"
- Mode: run
- Intent: review
- Given: The requested prefix is chat-event shard 123 and the cursor belongs to shard 124 in the same bucket.
- When: A consumer supplies the cursor to a bounded list operation.
- Then: The operation throws `S3 list cursor must belong to its prefix` before any provider request.

## s3-list-008

- Vitest: "bounded S3 object listing provider contract > rejects objects outside the requested prefix"
- Mode: run
- Intent: review
- Given: The requested prefix is `chat-events/`, but S3 returns `other/key`.
- When: A consumer reads the returned page.
- Then: The operation rejects with `S3 object listing escaped its prefix`.

## s3-list-009

- Vitest: "bounded S3 object listing provider contract > propagates a provider rejection without retries or implicit pages"
- Mode: run
- Intent: review
- Given: S3 rejects the listing with a provider-unavailable error.
- When: A consumer requests a bounded page.
- Then: The caller receives the same error and S3 receives one request.

## s3-list-010

- Vitest: "bounded S3 object listing provider contract > makes no provider request for an already cancelled owner"
- Mode: run
- Intent: review
- Given: The caller's signal has already been aborted with a caller-owned reason.
- When: The caller requests a bounded page using that signal.
- Then: The operation rejects with the exact abort reason before making any S3 request.

## s3-list-011

- Vitest: "bounded S3 object listing provider contract > does not publish a page after cancellation while its provider response is pending"
- Mode: run
- Intent: review
- Given: The provider request is already in flight using the consumer's cancellation signal.
- When: The consumer aborts, then S3 returns an object in its response.
- Then: The caller receives the exact cancellation reason and no page. The only S3 request used the caller's signal.
