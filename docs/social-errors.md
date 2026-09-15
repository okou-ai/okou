# Social errors and download recovery

Ordinary social errors retain the `{ error: { code, message } }` envelope and
can add `reason`, `retryable`, and `retryAfterSeconds`. The CLI exposes these in
JSON and human-readable output. Public reasons do not depend on the underlying
provider name.

| Reason                     | Meaning and next action                                                               |
| -------------------------- | ------------------------------------------------------------------------------------- |
| `content_restricted`       | Access or media constraints prevent extraction. Use eligible content.                 |
| `content_unavailable`      | The source identifies unavailable content. Check its URL and accessibility.           |
| `no_transcript`            | Captions are confirmed absent. Stop automatic retries.                                |
| `transcript_not_ready`     | Captions are not currently usable. Check later; they may remain unavailable.          |
| `media_not_ready`          | A stream is live or upcoming. Wait for its completed recording.                       |
| `upstream_failure`         | Extraction or processing failed. Follow explicit retry advice.                        |
| `rate_limited`             | The service or source is throttling requests. Respect the retry delay.                |
| `provider_quota_exhausted` | The shared provider account lacks capacity. Wait for service capacity to be restored. |
| `provider_authentication`  | The service's provider authentication needs repair.                                   |
| `invalid_input`            | Correct the request before repeating it.                                              |

Provider quota uses HTTP 503; it is distinct from the user's Okou balance error
(HTTP 402). Provider-account balances and top-up/upgrade links are never
forwarded. Content restrictions use 422, and project rate limits use 429.
Existing unstructured transcript errors retain `transcript_unavailable`,
`availability_unknown`, and `access_denied` classifications.

## Retry policy

A valid explicit boolean takes precedence over code and HTTP-status guesses,
including `false` on a 5xx response. When a provider omits or malforms optional
fields, recognized codes determine advice; otherwise 429 and 5xx allow a later
bounded retry, and other statuses do not. Unknown async failure codes without
valid advice do not authorize resubmission. Code tokens are bounded to 128
characters. Unknown fields, raw diagnostic bodies, credentials and account
links are not carried into public error metadata.

`Retry-After` accepts integer delta-seconds or an IMF-fixdate HTTP date. Past
dates become zero seconds. Invalid values, values longer than 128 characters,
and delays outside 0–2,147,483,647 seconds are ignored. Valid delays appear as
`retryAfterSeconds`; download reconciliation does not retry earlier than that
delay or its existing backoff. A delay is not permission to retry an explicitly
nonretryable operation. No automatic ordinary request or download submission
retry is added.

## Download actions

- `error.retryable` describes retrying recovery of the same download. A
  `provider_failed` task always has `retryable: false` and must stop polling.
- Optional `error.resubmitRetryable` describes whether a **new submission** may
  succeed later after a terminal provider failure. This never restarts the
  failed task or automatically submits another one.
- A processing error retains the download ID and surfaces its reason and delay.
  The CLI stops its current polling invocation and prints
  `okou social download --resume <download-id>`. Transport/API polling failures
  also retain this command in JSON `recovery` and human output.
- A provider quota error during polling can represent a ready, unpaid file.
  Resume the same download after capacity is restored. Do not create a new job.
- A billed artifact failure continues to recover the existing artifact. Durable
  usage settlement and its idempotency key are unchanged.

## Compatibility and internal evidence

New response and JSONB fields are optional. Existing rows containing only
code/message remain readable; absent resubmission advice stays absent rather
than being invented. Current local artifact/reconciliation errors can also
legitimately omit provider advice. No migration or backfill is needed.

The API persists bounded provider status/code/retryability evidence separately
from public download metadata; ordinary request diagnostics retain the same
allowlisted evidence in server logs. The public projection never includes that
evidence object. Safe existing download code/message diagnostics remain usable.

Old commit-addressed CLIs still handle code/message envelopes and ignore new
metadata. New CLIs keep the existing status-based retry advice for responses
that lack a valid explicit boolean, including older API responses and local
errors. Retiring an old API/CLI shape requires the deployment and run-drain
gates in [deployment compatibility](./deployment-compatibility.md); this change
does not retire those shapes.

Provider references: [errors](https://docs.socialkit.dev/api-reference/errors)
and [async downloads](https://docs.socialkit.dev/api-reference/async-download-api).
