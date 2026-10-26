# Memory citation provenance

The stateful hidden-envelope parser, final assistant projection, citation body
parser, protocol shape, and shared fixture semantics are adapted from these
OpenAI Codex files at commit `5adb68a49933ae446bf11935662c83dba55a0804`, under the Apache-2.0 license:

- `codex-rs/utils/stream-parser/src/citation.rs`
- `codex-rs/utils/stream-parser/src/inline_hidden_tag.rs`
- `codex-rs/core/src/stream_events_utils.rs`
- `codex-rs/memories/read/src/citations.rs`
- `codex-rs/protocol/src/memory_citation.rs`

Okou's TypeScript authority is
`api-contracts/src/contracts/pi-memory-citations.ts`; the Rust Sandbox adapter
is `guest-agent/src/cli/pi_memory_citation.rs`. Both consume the same
`fixtures/pi-memory-citations.json`. The producer projection additionally
removes complete stray delimiters, bounds untrusted fields and counts, and
keeps citation metadata out of derived public text and exported Pi JSONL.

Canonical Pi session JSONL remains immutable. Guest normalizes derived
assistant/result text before admission. The API separates supplied citation
metadata and stores it in `run_output_memory_citations`, keyed by run and event
sequence, as an auxiliary write after event admission.

Chat event row projection preserves stored content without parsing citation
markup. Browser cache hydration, incremental synchronization, and Snapshot
validation use that projection, so loading a thread does not rescan its entire
history for citations. Existing historical content is passed through unchanged;
these reads neither rewrite stored rows nor perform deferred text cleanup.
Other public projections, including shared-thread, search, callback, and
activity reads, retain their text-only citation handling.

Issue #32569 adds bounded escaping for isolated, closed code examples of the
delimiter constants. The producer projection also hides real envelopes inside
code. The native Codex 0.153.4 source/order evidence, literal grammar and public caller audit are
documented in [the delimiter boundary](https://github.com/okou-ai/okou/blob/9813db4b51faa42c982dcfec1720caf5bd5b1b82/docs/citation-delimiter-literals.md).
