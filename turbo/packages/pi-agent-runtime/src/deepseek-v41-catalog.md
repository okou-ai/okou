# DeepSeek V4.1 Flash Pi catalog

This is a historical provenance record. The hand-pinned V4.1 model and its
limit override are retired after memory moved to Luna and captured execution
and late usage drained. See the
[retirement contract](https://github.com/okou-ai/okou/blob/efdfb1ce76686698e2446eceb5a439caf88cd854/docs/deployment-compatibility.md#deepseek-memory-execution-retirement-2026-10-08).
The sections below describe the former implementation, not current execution
authority. Historical catalog labels and accounting identities remain.

`model.ts:sourceModel` supplies the exact OpenRouter V4.1 identity missing from
pi-ai 0.85.1. The commit-addressed CLI registers this same metadata in
the real SDK ModelRuntime. This is a model definition, not a substitute V4
request or a second admission policy.

## Effective limit corrections (2026-10-02)

The [model-limit audit](model-limits-audit.md) supersedes the historical output
snapshots below. The exact V4.1 Flash direct-API maximum in the provider's
[Models documentation](https://api-docs.deepseek.com/api/list-models/) is 393,216,
not 384,000. The OpenRouter primary-provider maximum is separately 943,718
according to its live Models and endpoint metadata; it is not interchangeable
with the direct API or a guarantee for every fallback endpoint. Both retain
1,048,576 total context.

`model-limits.ts` applies these corrections at the shared resolver and includes
them in installed-CLI parity. The hand-pinned identity, cost, input modalities
and dialect-compatibility boundary remain unchanged. Legacy V4 retains its
provider-specific definition and is not remapped to V4.1.

## Provenance (2026-09-15)

- [DeepSeek model details](https://api-docs.deepseek.com/quick_start/pricing/)
  identify `deepseek-flash` as V4.1 Flash, with thinking, vision, 1M context and
  384K maximum output. The existing product catalog fixes context at 1,048,576.
- [DeepSeek Responses](https://api-docs.deepseek.com/guides/responses_api)
  documents `/responses`, stateless `store: false`, text/image user input and
  tool image output. Its accepted but ignored fields do not change transport.
- [OpenRouter model API](https://openrouter.ai/api/v1/models) returned the exact
  ID `deepseek/deepseek-v4.1-flash`, canonical slug
  `deepseek/deepseek-v4.1-flash-20260910`, text/image inputs, context 1,048,576,
  maximum completion 384,000 and reasoning levels low/high/max (default high).
  Those supported levels constrain SDK clamping; product effort overrides for
  V4.1 remain unsupported in `model-reasoning-effort.ts`.
- Both provider sources returned peak USD per million input/output/cache-read
  of 0.3/1.2/0.006, with off-peak discounts. SDK cost fields are a static peak
  estimate, not the billing authority. Cache creation has no separately quoted
  provider rate. Okou's existing logical-model usage pricing remains unchanged.

Only the OpenRouter identity `deepseek/deepseek-v4.1-flash`, used by the fixed
built-in memory maintenance binding, is hand-pinned. Other provider/model pairs
still require a matching SDK entry; no version-prefix lookup or experimental
vision alias is used. Replace this definition only when the pinned SDK has
verified equivalent V4.1 metadata and the actual API/CLI transport and
continuation tests pass.

## Deployment and retained work

New V4.1 Pi admission requires the serving API's exact commit-addressed CLI
artifact (`https://static.okou.io/okou-cli/<GIT_COMMIT_SHA>/package.tgz`). A
mutable, foreign or differently pinned package fails before provider transport.
Release verification must prove that immutable artifact contains this reader.
This uses the existing Responses config and handoff generations; no DDL or
Runner capability changes are needed.

Old queued/running contexts retain their original runtime, model, package and
accounting writer. New API and CLI still read all existing supported Responses
and session formats. Existing Codex history is governed by
`canReuseSession`/`resolveChatThreadSession`: native JSONL is reused only within
one runtime and model family, while a runtime change uses the existing canonical
chat-context continuity path. No Codex JSONL is reinterpreted as Pi and no
historical selections, sessions or usage rows are rewritten.

After V4.1 Pi contexts exist, serving/recovery and rollback APIs must include
this model's config reader and API usage writer until queued/active/finalizing
work drains. Disabling Pi does not erase existing work or its billing ownership.
Controller acceptance owns the actual artifact, rollback-target and production
checks. This PR neither activates deferred Sandbox nor changes release tooling.
