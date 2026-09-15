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

## JSON files and selected fields

`inspect`, `posts`, `search`, `comments`, `transcript`, and `summarize` support
`--output <path>`, `--select <fields>`, `--format json|csv`, and `--overwrite`.
JSON remains the default; `--json` controls compactness. Without an output path,
JSON is printed on stdout as before. Export options are unavailable on download,
download discovery, capabilities, and service status.

```bash
okou social inspect https://www.instagram.com/p/example/ --output result.json
okou social search "small business" --platform youtube --limit 20 \
  --select title,url --format csv --output research.csv
```

`--select` addresses fields inside a single result's `data`, or inside each
collection `data.items` row. JSON retains all envelope metadata and collection
context. The selector is an ordered comma-separated list of 1–32 unique paths.
Each path has at most 128 characters and eight dot-separated segments. Segments
start with a letter, `_`, or `$`, followed by letters, digits, `_`, `$`, or `-`.
Array indexes, wildcards, and prototype properties are rejected. Only own
properties are read.

Selected JSON keys retain the path name: `--select author.name,title` produces
`{"author.name":"Example","title":"A post"}` for each row. Missing fields
are omitted; explicit null, false, zero, objects, and arrays retain their JSON
values. `summarize --fields` and `--fields-file` still supply provider extraction
instructions; they do not select output columns.

## CSV and metadata receipts

CSV supports normalized `posts`, `search`, and `comments` collections and
requires both `--output` and `--select`. Columns follow selector order, including
for empty collections. There is no inferred schema. Files use UTF-8 and CRLF
record separators, quote string values, double embedded quotes, and retain
embedded newlines. Objects and arrays are compact JSON within a quoted cell.
Missing fields become empty cells; null becomes literal `null`; numbers and
booleans are unquoted. CSV is textual: readers may conflate missing/empty cells
or a null with the string `"null"`. Use JSON when type distinctions matter.

Strings beginning with spreadsheet formula prefixes (`=`, `+`, `-`, `@`,
including preceding whitespace/control characters), tabs, or newlines
gain an apostrophe before CSV quoting. This prevents public content from being
treated as a spreadsheet formula. Numeric negative values are unchanged.

Every successful file publication prints one metadata-only JSON receipt with
`kind: "export"`, the original status, collection bounds, billing, warnings,
and any error/progress. `export` contains the absolute path, format, selected
fields when supplied, and `visibility: "local"`. **Retain the receipt with a
CSV file**: CSV rows alone cannot describe source completeness or accounting.
JSON files also include that metadata in their result envelope. An exported
partial collection preserves its ordinary exit code (1 for failure, 2 for an
unsatisfied source limit).

## Filesystem and streaming boundaries

The parent directory must exist and be writable. Existing paths are rejected
unless `--overwrite` is explicit; symlinks, directories, and devices are rejected
even with overwrite. The CLI prepares a private staging file in the destination
directory before provider work, writes it completely, then publishes it without
clobbering an existing destination. Overwrite uses atomic replacement; it never
truncates the old file before the replacement is ready. Staging files are removed
after handled success/failure. Abrupt termination can leave a staging file.

Invalid selectors, formats, and combinations are rejected before requests.
`--stream` cannot be combined with `--output`, `--select`, `--format`, or
`--overwrite`; it retains its existing JSON Lines contract. `--overwrite`
requires `--output`. JSONL files and text/SRT/VTT transcript exports are outside
this interface.

Disk or directory state may change after preflight. If projection or publication
fails after retrieval, the CLI prints the full original envelope to stdout,
reports an actionable export error on stderr, and exits 1. It does not repeat
provider requests. A path in a receipt refers to the local runtime, not a hosted
artifact. Use `okou web upload-file` when delivering that file to a web-chat user.
