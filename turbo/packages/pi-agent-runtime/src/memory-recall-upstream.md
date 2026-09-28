# Pi memory recall and ad-hoc note provenance

The progressive-disclosure prose in `memory-recall.ts` is adapted from
OpenAI Codex `codex-rs/ext/memories/templates/memories/read_path.md` at commit
`5adb68a49933ae446bf11935662c83dba55a0804`, shipped in `@openai/codex`
0.152.1.

Portions copyright OpenAI. The upstream source is licensed under the Apache
License, Version 2.0: <https://www.apache.org/licenses/LICENSE-2.0>.

`memory-recall.test.ts` pins both the adapted rendered prompt and the exact
`o200k_base` truncation boundary. Update those fixtures intentionally whenever
the compatibility target changes.

The `add_ad_hoc_note` schema, filename validation, explicit-user-request
boundary, verbatim Markdown handling, fixed `extensions/ad_hoc/notes` layout,
and create-new semantics in `memory-tools-node.ts` are adapted from these files
at the same pinned commit:

- `codex-rs/ext/memories/src/tools/ad_hoc_note.rs`
- `codex-rs/ext/memories/src/local/ad_hoc_note.rs`

The Pi port additionally applies the existing descriptor-based memory path and
race validation, a 64 KiB note limit, and a sandbox-staging result contract.

## Hidden memory citations

The stateful hidden-envelope parser, final assistant projection, citation body
parser, protocol shape, and shared fixture semantics are adapted from these
OpenAI Codex files at the same pinned commit and Apache-2.0 license:

- `codex-rs/utils/stream-parser/src/citation.rs`
- `codex-rs/utils/stream-parser/src/inline_hidden_tag.rs`
- `codex-rs/core/src/stream_events_utils.rs`
- `codex-rs/memories/read/src/citations.rs`
- `codex-rs/protocol/src/memory_citation.rs`

Okou's TypeScript authority is
`api-contracts/src/contracts/pi-memory-citations.ts`; the Rust Sandbox adapter
is `guest-agent/src/cli/pi_memory_citation.rs`. Both consume the same
`fixtures/pi-memory-citations.json`. Okou additionally removes complete stray
delimiters, bounds untrusted fields and counts, and never exposes citation
metadata through public text, logs, metrics, Stage 1 input, or exported Pi
JSONL derivatives.

Canonical Pi session JSONL remains immutable. Sandbox runtime and shared projections normalize
only derived assistant/result events. The common API defensively normalizes old
Guest output and transactionally stores private provenance in the additive
`run_output_memory_citations` table, keyed by run and event sequence. Historical
chat, Snapshot, browser-cache, shared-thread, search, callback, and activity
reads apply the same text-only defense without rewriting source rows or blobs.

Issue #32569 adds bounded escaping for isolated, closed code examples of the
delimiter constants. Real envelopes inside code remain private. The native
Codex 0.153.4 source/order evidence, literal grammar and public caller audit are
documented in [the delimiter boundary](../../../../docs/citation-delimiter-literals.md).
