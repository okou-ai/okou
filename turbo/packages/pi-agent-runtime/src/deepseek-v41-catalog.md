# DeepSeek V4.1 Flash Pi catalog

`model.ts:sourceModel` supplies the exact V4.1 identities missing from pi-ai
0.85.1. API-first and the commit-addressed CLI register this same metadata in
the real SDK ModelRuntime. This is a model definition, not a substitute V4
request or a second admission policy.

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

The native catalog identity `deepseek-v4.1-flash` exists only for explicitly
mapped custom Responses deployments. Their opaque request model is preserved.
Other provider/model pairs still require a matching SDK entry; no version-prefix
lookup or experimental vision alias is used. Existing V4 entries are unchanged.
Replace this definition only when the pinned SDK has verified equivalent V4.1
metadata and the actual API/CLI transport and continuation tests pass.

## Deployment and retained work

New V4.1 Pi admission requires the serving API's exact commit-addressed CLI
artifact (`https://static.okou.io/okou-cli/<GIT_COMMIT_SHA>/package.tgz`). A
mutable, foreign or differently pinned package fails before provider transport.
Release verification must prove that immutable artifact contains this reader.
This uses the existing Responses config and handoff generations; no DDL,
Runner capability or native Claude catalog vocabulary changes are needed.

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
