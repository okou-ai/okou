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

This hint alone does not preserve fetched-but-unemitted items and is not a
guarantee that retrying a failed request is safe. Use the explicit checkpoint
interface below for recovery across invocations.

## Checkpoints and resume

For operations with reviewed pagination, opt in before collecting:

```bash
okou social comments https://www.instagram.com/p/example/ --limit 2 --checkpoint comments.json --json
okou social resume comments.json --limit 10 --json
```

`posts`, `search`, and `comments` accept `--checkpoint <file>`. Offline
`okou social capabilities [platform] --json` reports
`collection.continuation.supported` for each operation/variant. Cursorless and
single-batch operations reject checkpoint creation before any request. This
includes Instagram search and the currently cursorless YouTube collections.

`social resume <file>` preserves the saved operation, canonical URL/query,
platform, and filters. It accepts only output options and a new `--limit`:
the maximum **additional** items to emit in this invocation, default 10.
For example, if the provider returned three items and the first command emitted
two, resume emits the third item before requesting another page. A resume with
`--limit 1` needs no provider request. The tail remains available even when its
page already reported source completion. Once it is drained, source completion
and provider limitations remain terminal.

Initial collection can combine `--checkpoint` with JSON/CSV export or
`--select`. Selection affects the emitted/exported rows; the checkpoint keeps
the original buffered items. Use distinct paths for the exported results, the
checkpoint, and its `.lock` file, including through parent-directory aliases.
Conflicting paths are rejected before provider work, even with `--overwrite`.
`social resume` accepts `--json` or `--stream`; save its returned output when
needed.

Checkpointed terminal records add these fields under `collection`:

| Field                        | Meaning                                                      |
| ---------------------------- | ------------------------------------------------------------ |
| `bufferedItemsReturned`      | Previously fetched items emitted in this invocation          |
| `cumulative`                 | Accepted page/item progress and usage across all invocations |
| `continuation.version`       | Checkpoint format version, currently 1                       |
| `continuation.path`          | Absolute path to the saved local file                        |
| `continuation.available`     | Whether buffered items or a pending page remain              |
| `continuation.bufferedItems` | Number of fetched items still waiting to be emitted          |
| `continuation.expiresAt`     | Fixed expiry time of the checkpoint                          |
| `continuation.resumeCommand` | Next command, present only when continuation is available    |

Existing `collection.pages`, `itemsReturned`, `itemsObserved`, `progress`, and
top-level `billing` describe the current invocation. Buffered items increase
`itemsReturned` but not newly observed items or page/usage counts. They were
already accounted for by the original page, so a buffer-only resume has zero
new billing. `cumulative.itemsObserved` includes the fetched tail;
`cumulative.itemsReturned` counts emitted items. All usage remains limited to
accepted responses, and failed requests can still have unknown charges.

With `--stream`, replay emits a `kind: "page", source: "checkpoint"` record
with zero billing and no fetched-page number. Newly fetched pages keep their
existing records. Exactly one metadata-only terminal summary follows. A
failure after emitting buffered items is partial even if no new page succeeded.

An explicit resume may request a recoverable failed page again. Completed page
identities remain in the checkpoint and are never requested again during normal
continuation. Repeated/invalid cursors and permanent cursor rejection stop
network continuation. The CLI never restarts or retries automatically, and
cannot guarantee that a saved provider cursor remains usable.

Connection failures, timeouts, and interrupted response transfers retain an
already saved pending page for explicit resume. They report a retryable
`TRANSPORT_ERROR` without inventing an HTTP status or assuming that the
failed request had no provider effects or charges. Invalid responses and
explicit permanent API errors still stop network continuation.

### File and credential lifetime

Version 1 is a private local file authenticated with a domain-separated HMAC
bound to the **same `OKOU_TOKEN` and API endpoint**. Credentials are never stored
in the file. The file includes public results and the caller's query/filters;
keep it private. Changed credentials, including a new run token, cannot resume
it. This is recovery between CLI invocations in one credential context.

Checkpoints expire 24 hours after creation; resume does not extend that deadline.
Altered, expired, incompatible, mismatched-context, and exhausted checkpoints
fail with guidance before provider I/O. The maximum file size is 16 MiB.
Provider cursor expiry and token expiry can end recovery sooner.

The destination parent must exist. Initial collection requires a new file;
resume atomically updates that same file. An exclusive `.lock` file prevents
concurrent use of the same canonical path. Symbolic links and hard-linked files
are rejected. Wait for active invocations; remove a stale lock only after
confirming the command stopped and inspecting its output.

Lock-cleanup failures are reported separately on stderr and set exit code 1.
They do not replace accepted stdout results or an existing collection failure.
Machine-readable stderr may contain separate JSON Lines for cleanup and
collection errors; stdout still contains exactly one terminal record.

Saving a checkpoint is part of handled completion, not a crash-safe output
transaction. A save failure preserves accepted terminal output and reports an
error without advertising a new continuation. Inspect that output before
reusing an older file: it may replay already emitted items. Likewise, copied
checkpoints, abrupt termination, or output delivery failures cannot guarantee
exactly-once emission. The terminal file is retained with
`continuation.available: false` when no recovery remains.

Terminal records cover handled execution failures. Abrupt termination, a killed
process, or an unusable stdout cannot guarantee a final record. These changes
affect CLI output only; existing CLI/API wire contracts remain unchanged.

## JSON files and selected fields

`inspect`, `posts`, `search`, `comments`, `transcript`, and `summarize` support
`--output <path>`, `--select <fields>`, `--format json|csv`, and `--overwrite`.
Transcript also supports `--format text|srt|vtt` with `--output`, as described
below. JSON remains the default; `--json` controls compactness. Without an output path,
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
after handled success/failure. If filesystem access prevents cleanup, stderr
reports the staging path and the command exits 1 without replacing the original
request/export error. Abrupt termination can also leave a staging file.

Invalid selectors, formats, and combinations are rejected before requests.
`--stream` cannot be combined with `--output`, `--select`, `--format`, or
`--overwrite`; it retains its existing JSON Lines contract. `--overwrite`
requires `--output`. JSONL file export is outside this interface.

Disk or directory state may change after preflight. If projection or publication
fails after retrieval, the CLI prints the full original envelope to stdout,
reports an actionable export error on stderr, and exits 1. It does not repeat
provider requests. A path in a receipt refers to the local runtime, not a hosted
artifact. Use `okou web upload-file` when delivering that file to a web-chat user.

## Transcript text and timed subtitles

```bash
okou social transcript https://youtu.be/example --format text --output transcript.txt
okou social transcript https://youtu.be/example --format srt --output captions.srt
okou social transcript https://youtu.be/example --format vtt --output captions.vtt
```

Choose the desired format before extraction. These examples are separate requests;
formatting the retrieved result never adds a provider request. Each format requires
`--output` and rejects `--select`. `--json` controls the stdout receipt's compactness,
and `--overwrite` retains the same explicit replacement behavior as JSON/CSV.

Plain text uses a nonblank full `data.transcript` once. When it is absent or blank,
the CLI joins `data.transcriptSegments[].text` in source order. It preserves Unicode,
language and full-text formatting, adding a final newline when needed. Missing
segment text or a result with no usable text fails instead of silently producing
an incomplete or empty transcript.

SRT and WebVTT use the supplied segment text and require every segment to have a
finite nonnegative `start` and a finite positive `duration`, both in seconds.
Each end is computed from that segment's start plus duration. A display `timestamp`,
the next segment's start, or a full transcript cannot establish a missing duration.
Extraction support in `capabilities` does not guarantee timestamped output for an
individual source.

Cue starts must be nondecreasing in source order; actual overlaps are preserved.
Absolute starts and ends are rounded to milliseconds, and intervals that collapse
at that precision or exceed safe integer milliseconds fail. Hours do not wrap at 24. SRT uses numbered cues and comma milliseconds; WebVTT uses a `WEBVTT` header,
numbered cue identifiers, and period milliseconds.

WebVTT escapes cue ampersands, angle brackets and nonbreaking spaces as literal text, following its
[cue payload format](https://developer.mozilla.org/en-US/docs/Web/API/WebVTT_API/Web_Video_Text_Tracks_Format#cue_payload).
SRT preserves source cue text without adding WebVTT character references, which
some SRT readers display literally. SRT readers differ in
[markup support](https://www.loc.gov/preservation/digital/formats/fdd/fdd000569.shtml);
choose WebVTT when literal markup display matters. Both formats normalize CRLF/CR
line endings to LF and remove blank cue lines so they cannot terminate a cue.
Nonblank lines and Unicode are preserved. Blank or NUL-containing cue text is
rejected. This does not translate, align, or fabricate speech or timing.

Files contain only transcript/subtitle content. Retain the separate stdout JSON
receipt for status, warnings, errors, and credits; its `export.language` also keeps
the source language when supplied. JSON exports retain their original envelope.

Unavailable or invalid timing returns an actionable error, preserves the complete
retrieved result on stdout, and leaves an existing output file intact. Save
`data.transcript` or join the recovered segment texts as plain text without making
another Social request. A failed export is not a reason to retry extraction, and
an empty/unavailable transcript does not prove that a video contains no speech.
Malformed API responses (such as negative or nonnumeric timing fields) still fail
the existing response validation before formatting; they produce no accepted
result or subtitle file.
