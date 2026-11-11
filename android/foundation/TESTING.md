# Foundation State Tests

Test the actual state holder and semantic actions without an Android SDK.
Commands live in the [Android README](../README.md); shared rules are in
[Android testing](../../docs/android/android-testing.md).

| Contract                                                                          | Owning test                 |
| --------------------------------------------------------------------------------- | --------------------------- |
| Blank draft validation and preserving an existing preview                         | DraftStateHolderTest        |
| Verbatim Unicode/whitespace text and preview snapshots independent of later edits | DraftStateHolderTest        |
| Actions use the owner's latest state without a UI collector                       | DraftStateHolderTest        |
| Independent owner instances and coherent derived validation                       | DraftStateHolderTest        |
| Real text input, action eligibility and preview rendering                         | FoundationScreenTest in app |
| Lifecycle stop pauses UI collection; resume observes the latest retained value    | FoundationScreenTest in app |
| Screen-owner replacement rebinds state and business actions                       | FoundationScreenTest in app |

These tests express CCState's single-source, derivation, action and owner
discipline using native Kotlin StateFlow and Android lifecycle collection.
They do not promise TS graph behavior, reference identity notifications,
lossless intermediate emissions or browser cancellation-event semantics.

The scaffold starts no async business request. Add cancellation, shared work,
error recovery and stale-result tests through their actual feature owners when
those operations are implemented; do not invent a request framework solely to
test native Job/Flow primitives. Durable storage, process recreation, real IME,
device performance and remote operations require separate acceptance.
