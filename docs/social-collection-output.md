# Social collection output

`okou social posts`, `search`, and `comments` apply `--limit` to the total
returned items across all accepted pages. Without `--stream`, stdout contains
one `kind: "result"` object with `data.items` and `data.context`. `--json` makes
that object compact; the default output is pretty-printed JSON.

With `--stream`, stdout is JSON Lines: one `kind: "page"` record per accepted
page, followed by exactly one metadata-only `kind: "summary"` record. The
summary contains no `data`, so already emitted items are never duplicated.
An accepted empty page still produces a page record.

## Outcomes and exit status

| Collection state   | Top-level status | Exit | Meaning                                                                                                              |
| ------------------ | ---------------- | ---- | -------------------------------------------------------------------------------------------------------------------- |
| `complete`         | `complete`       | 0    | The source reported completion.                                                                                      |
| `caller_limited`   | `complete`       | 0    | The requested limit was satisfied; additional source items may exist.                                                |
| `provider_limited` | `partial`        | 2    | The requested count was not reached and the source cannot expose more items, or the safety page ceiling was reached. |
| `provider_limited` | `complete`       | 0    | The requested count was satisfied despite a source limitation.                                                       |
| `failed`           | `partial`        | 1    | A handled failure stopped collection after at least one accepted page.                                               |
| `failed`           | `error`          | 1    | Collection failed before accepting any page.                                                                         |

Handled collection failures now emit a terminal stdout record in both output
modes. This is additive to the existing success records and stderr diagnostics.
Scripts must inspect the exit status and terminal record; nonempty stdout does
not imply successful completion. Argument parsing and intent-validation errors
before collection begins continue to use stderr without a collection record.

## Failure records

A failed aggregate result retains every accepted item within the requested
limit. A failed stream retains its emitted pages and adds one terminal summary.
Both terminal forms include:

- `error`: the structured diagnostic, including its kind, code, message,
  retryability, and HTTP status when available.
- `collection`: `state: "failed"`, accepted page/item counts, the requested
  count, and the last reported total when available.
- `progress`: accepted `pages`, `itemsReturned`, `itemsObserved`,
  `billingQuantity`, and `creditsCharged`.
- `billing`: the accumulated accounting from accepted responses, or `null`
  when no page was accepted.

Machine-readable modes also emit the existing structured error and progress on
stderr; default mode emits a human-readable diagnostic. Handled collection
failures set exit code 1 and allow stdout to drain before the process exits.

Billing and progress describe accepted responses only. They do not claim that
a failed request or malformed response had no provider effects or charges.
Successful pages are billed independently, including items trimmed by the
caller limit. The CLI does not automatically retry or restart a collection.

## Continuation hints

On failure or the safety page ceiling, `collection.nextInput` may retain the
validated cursor/page input for the pending request after an accepted page.
Consumed, invalid, and repeated pagination hints are omitted. A first-page
failure has no continuation hint; neither do cursorless operations.

This is diagnostic state, not a checkpoint, a collection `--resume` interface,
or a guarantee that retrying a failed request is safe. In particular, stopping
at a caller limit can leave fetched-but-unemitted items, and a next cursor alone
would skip them. Durable checkpoints, owner/context validation, and buffered-tail
replay are tracked separately in
[#34030](https://github.com/vm0-ai/vm0/issues/34030).

Terminal records cover handled execution failures. Abrupt termination, a killed
process, or an unusable stdout cannot guarantee a final record. These changes
affect CLI output only; existing CLI/API wire contracts remain unchanged.
