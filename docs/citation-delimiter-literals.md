# Citation delimiter literal boundary

Issue #32569 repairs explanatory code examples without changing the private
citation transport established by #31959 / #31967 or the retained native memory
and checkpoint decisions in #31067. `OPEN` and `CLOSE` below denote the existing
parser constants; examples deliberately avoid printing control delimiters.

## Literal grammar

The TS and Rust scanners share `fixtures/pi-memory-citations.json`. Only an
entire `OPEN` or `CLOSE` inside a fully closed backtick span is exempt. A fence
may contain ASCII whitespace around one delimiter, but no other content. Fences
use at least three backticks or tildes, at most three leading spaces, a simple
ASCII language label, and a same-character closing run at least as wide as the
opening run. A shorter run is non-whitespace body content, even with supported
indentation or trailing whitespace, so it disqualifies the entire literal
candidate. A closing fence at EOF is supported. Candidates retain at most 4,096
characters, including their code delimiters.

Only delimiter angle brackets become `&lt;` and `&gt;`. Their source segment
ownership is retained. Entities stay encoded on every subsequent projection;
old readers therefore cannot reinterpret the example as transport. This is a
deliberately narrow grammar, not a Markdown parser or renderer change.

Unclosed, mismatched, oversized or larger code bodies go through the existing
private-envelope scanner unchanged. A real envelope inside code remains
private. A closed code span inside an already open private envelope does not
escape that envelope's closing delimiter. Missing closers and zero parsed
entries never authorize publication. Existing body/provenance size limits and
the Rust allocation fix from #32348 remain in place.

## Native source and publication order

The audited runtime is Codex CLI 0.153.4, upstream `rust-v0.153.4` commit
[`3d2ee51ca2d5db578f328aa75e20aa22c0197c9a`](https://github.com/openai/codex/tree/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a).
The generated experimental protocol exposes `experimentalRawEvents` on
`thread/start`, but not on `thread/resume`. In the actual binary, fresh native
`item/completed` precedes `rawResponseItem/completed`; a resumed thread in a
new process does not emit the latter. Neither a fresh subscription assumption
nor normalized `item.text` can repair the reported truncation.

Guest uses one private source for both cases: the canonical rollout selected
by the existing descriptor-safe session history resolver. Native
`core/src/tasks/mod.rs` flushes the rollout before emitting turn completion;
`core/src/rollout/recorder.rs` materializes a compressed rollout before opening
it for append on resume. The executable probe below verifies both contracts.

The resolver binds the canonical thread UUID, rejects ambiguous paths and
symlinks, and pins the file descriptor. Guest checks `session_meta.id` and sets
the resume cursor to EOF **before** `turn/start`, so it does not scan historical
message bodies. Fresh resolution may be deferred until the first eligible
message, with one final bounded attempt at turn completion. Reads are bounded
to 4 MiB per record, 64 MiB per run, and 1 MiB of eligible text.

Only an assistant `response_item` message with the exact native turn ID, item
ID and commentary/final-answer phase is decoded as text. Its content must
contain only `output_text` parts. Other rows, roles, reasoning and tool payloads
are never public text sources. Raw notifications are not subscribed to or
forwarded by this repair.

Before replacement, Guest requires that the pinned native citation-only
projection of the raw text exactly equals native normalized text. Messages
containing proposed-plan controls are ineligible, including controls hidden
after the erroneous opener. This preserves native contributor/other
normalization and prevents plan restoration. Only the normalized event's text
field is replaced; its existing native metadata/provenance is retained.

An eligible normalized completion waits privately for its matching persisted
item. Subsequent public events remain ordered behind it. Native turn completion
is the flush barrier, not a timer. The queue is bounded by 128 events / 16 MiB;
item deduplication is bounded by 4,096 identities. Missing, malformed, ambiguous,
oversized or incompatible evidence retains the original native safe projection
and emits at most one content-free diagnostic per run. Cancellation or process
failure releases only original normalized events. This external-evidence
failure policy is required by #32569, not a fleet compatibility fallback; a
future runtime replacement must re-audit the contract before removing it.

## Caller and compatibility audit

| Boundary                           | Owning code / evidence                                                                                                                                                                    |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Native app-server                  | `codex_app_server_backend.rs` prepares all three notification ingest paths; scope validation precedes repair; all terminal/cancellation paths drain safely.                               |
| Sandbox Pi / modern Guest          | `pi_rpc.rs` consumes the Rust parser; `events.rs` keeps the existing top-level private sidecar transport.                                                                                 |
| API-first Pi                       | `api-turn.ts` uses the TS segment projection and retains structured provenance.                                                                                                           |
| Old Guest / new API                | `pi-memory-citation-events.ts` retains the request-spanning legacy classifier; existing cap/retry/replay/ordering route regressions remain active.                                        |
| New Guest / old API                | Pinned rollback wire fixture and executable baseline consumers prove sidecar stripping; escaped literals remain complete in activity, chat and callbacks.                                 |
| Rows / Snapshot / cache            | `chat-event-row-projection.ts:chatEventFromRow` and `canonical-chat-event-read.service.ts` use the shared projector; row tests pin repeated projection and source immutability.           |
| Share / search / archive / export  | `shared-thread.service.ts`, `chat-search.service.ts`, canonical reads and `user-export.service.ts`; archive consumer route tests exercise historical raw examples with private envelopes. |
| Notification / callback / activity | `run-output.service.ts`, `internal-chat-run-callback.service.ts`, `run-detail.service.ts` reuse the same TS public projector.                                                             |
| Session export / Stage 1           | `session-memory.ts` and `stage1-memory.ts` project derivative copies and leave canonical session JSONL unchanged.                                                                         |

No schema, protocol field, storage identity, checkpoint writer, memory setting,
billing, model routing or history format changes. Old frontend/new API and new
frontend/old API keep the same response shape. Escaped bytes remain safe across
API skew (including the documented ~102-minute incident exposure), existing
runner/sandbox lifetimes (up to two hours), and old browser clients (~two days).
The existing #31964 compatibility remains; this fix establishes no deletion,
drain, rollback or production release gate.

## Reproduce installed-runtime acceptance

From the repository root, with dependencies installed, Codex 0.153.4 and libzstd:

```sh
cargo build --manifest-path crates/Cargo.toml --profile local -p guest-agent --example codex_citation_probe
python3 scripts/codex-citation-native-probe.py --codex /usr/bin/codex --guest-probe crates/target/local/examples/codex_citation_probe
```

The probe serves synthetic Responses SSE locally, reproduces raw 872 versus
native 114 characters, and verifies Guest emits the complete safely escaped
878-character answer exactly once. It starts a new app-server process for each
resume, including a compressed synthetic checkpoint, checks raw identity and
native publication order, and executes current plus pre-fix public readers
twenty times. It uses no provider credentials, user session, or public browser.
Only temporary fixture histories are created/compressed by the probe; production
repair code never writes history.

This is deterministic installed-binary acceptance, not production or browser
verification. It does not reconstruct already truncated historical public rows,
test every arbitrary Markdown extension, or claim support for an untested
future native protocol. Unsupported evidence intentionally retains native safe
text. Targeted parser/privacy, Guest lifecycle, API consumer and compatibility
tests complement the probe; full integration remains the PR pipeline's gate.
