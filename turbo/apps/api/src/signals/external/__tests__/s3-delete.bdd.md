# s3-delete

## s3-delete-001

- Vitest: "S3 object deletion provider contract > makes no provider request for an empty list"
- Mode: run
- Intent: review
- Given: The deletion request contains zero object keys.
- When: A storage consumer asks to delete those keys from the user-storage bucket.
- Then: The operation resolves with no value and does not initialize an S3 client or send a provider request.

## s3-delete-002

- Vitest: "S3 object deletion provider contract > deletes all 1000 keys within the provider limit"
- Mode: run
- Intent: review
- Given: The user-storage bucket is selected and the provider accepts deletion of 1000 requested keys.
- When: A storage consumer requests deletion of the entire list.
- Then: The operation succeeds and S3 receives ordered batches of 1,000 keys against the same bucket. The flattened provider requests exactly match the input keys.

## s3-delete-003

- Vitest: "S3 object deletion provider contract > deletes all 1001 keys within the provider limit"
- Mode: run
- Intent: review
- Given: The user-storage bucket is selected and the provider accepts deletion of 1001 requested keys.
- When: A storage consumer requests deletion of the entire list.
- Then: The operation succeeds and S3 receives ordered batches of 1,000 and 1 keys against the same bucket. The flattened provider requests exactly match the input keys.

## s3-delete-004

- Vitest: "S3 object deletion provider contract > deletes all 2501 keys within the provider limit"
- Mode: run
- Intent: review
- Given: The user-storage bucket is selected and the provider accepts deletion of 2501 requested keys.
- When: A storage consumer requests deletion of the entire list.
- Then: The operation succeeds and S3 receives ordered batches of 1,000, 1,000 and 501 keys against the same bucket. The flattened provider requests exactly match the input keys.

## s3-delete-005

- Vitest: "S3 object deletion provider contract > preserves the client and bucket for test-user-storages across batches"
- Mode: run
- Intent: review
- Given: The selected bucket is `test-user-storages` and it has separate configured S3 credentials.
- When: A storage consumer requests deletion of 1,001 object keys.
- Then: Both deletion requests target the selected bucket and share a single S3 client configured with that bucket's access key.

## s3-delete-006

- Vitest: "S3 object deletion provider contract > preserves the client and bucket for test-user-artifacts across batches"
- Mode: run
- Intent: review
- Given: The selected bucket is `test-user-artifacts` and it has separate configured S3 credentials.
- When: A storage consumer requests deletion of 1,001 object keys.
- Then: Both deletion requests target the selected bucket and share a single S3 client configured with that bucket's access key.

## s3-delete-007

- Vitest: "S3 object deletion provider contract > preserves the client and bucket for test-private-artifacts across batches"
- Mode: run
- Intent: review
- Given: The selected bucket is `test-private-artifacts` and it has separate configured S3 credentials.
- When: A storage consumer requests deletion of 1,001 object keys.
- Then: Both deletion requests target the selected bucket and share a single S3 client configured with that bucket's access key.

## s3-delete-008

- Vitest: "S3 object deletion provider contract > awaits each batch and does not complete before the final provider response"
- Mode: run
- Intent: review
- Given: Deleting 1,001 keys takes two provider requests. Each response is held until separately released.
- When: The caller starts deletion, then the provider completes the first and second responses in order.
- Then: Only one request is sent before the first response. The second request starts after that response, and deletion resolves successfully only after the second provider response.

## s3-delete-009

- Vitest: "S3 object deletion provider contract > rejects a later batch's request rejection without sending or retrying more batches"
- Mode: run
- Intent: review
- Given: A request covers 2,501 keys. The provider accepts the first 1,000-key request. The second batch is rejected with `S3 request failed`.
- When: A storage consumer waits for the operation to complete.
- Then: The operation rejects with the original provider error. The provider receives just the first two 1,000-key requests.

## s3-delete-010

- Vitest: "S3 object deletion provider contract > rejects a later batch's per-key error without sending or retrying more batches"
- Mode: run
- Intent: review
- Given: A request covers 2,501 keys. The provider accepts the first 1,000-key request. The second response indicates one deletion and an `AccessDenied` error for another key.
- When: A storage consumer waits for the operation to complete.
- Then: The operation rejects with `S3 object deletion failed for 1 object(s)`. The provider receives just the first two 1,000-key requests.

## s3-delete-011

- Vitest: "S3 object deletion provider contract > can retry the same list after earlier batches and part of a later batch succeeded"
- Mode: run
- Intent: review
- Given: S3 has 2,501 keys. A single key in the second batch fails once with `InternalError`. Subsequent deletes, including already absent keys, succeed.
- When: The consumer requests deletion and retries the identical list after the partial failure.
- Then: The first operation rejects with a one-object deletion error and leaves only the failing key and untouched final batch. The retry succeeds and no keys remain. Provider batch sizes across both calls are 1,000, 1,000, 1,000, 1,000 and 501.
