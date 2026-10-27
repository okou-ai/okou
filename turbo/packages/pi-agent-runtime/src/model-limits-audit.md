# Pi model-limit audit

Verified on 2026-10-02 against the first-party sources below, with Pi 0.87.1.
It covers the identities in `PI_RUNTIME_RESOLVABLE_MODELS` plus the internal
DeepSeek V4.1 Flash memory binding. It does not admit new models or reinterpret
opaque deployment names as provider identities.

The DeepSeek V4.1 entry below is historical: its memory execution binding and
limit override are retired after the
[production drain gate](https://github.com/okou-ai/okou/blob/9813db4b51faa42c982dcfec1720caf5bd5b1b82/docs/deployment-compatibility.md#deepseek-memory-execution-retirement-2026-10-08).
The Codex correction remains active in the bundled CLI.

## Meaning of the numbers

Pi's `contextWindow` drives conversation compaction and remaining-context output
clamping; `maxTokens` is the model's ordinary output ceiling. Neither field is a
pricing threshold, a summary budget, a promise that the model generates that
many tokens, or a guarantee for every OpenRouter fallback endpoint.

A Codex subscription has its own runtime policy: OpenAI's own catalog gives
these models a 272,000 default context budget and a separate 872,000 maximum
configurable context. Keep that official default rather than silently opting
subscription runs into a larger budget or borrowing the API's total context.

For OpenRouter, use the primary-provider context/output fields rather than the
aggregate context when they differ. OpenRouter owns provider selection;
changing its advertised ceiling does not pin or reroute to a different provider.

## Inventory and dispositions

Numbers below are the effective Pi context/output after this correction.
Grouped rows explicitly enumerate every catalog identity they cover.

| Catalog provider | Exact model identities                                       | Context / output    | Disposition                                                                                                        |
| ---------------- | ------------------------------------------------------------ | ------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `openai-codex`   | `gpt-6-sol`, `gpt-6-luna`, `gpt-5.6-sol`, `gpt-5.6-luna`     | 272,000 / 128,000   | Existing official subscription default retained.                                                                   |
| `openai-codex`   | `gpt-6.1-sol`                                                | 272,000 / 128,000   | Correct the hand pin that copied the API's 1,050,000 context into a subscription binding.                          |
| `openai-codex`   | `gpt-6.1-terra`                                              | 500,000 / 128,000   | Added 2026-10-27 with the hand pin; Codex ships a 500,000 subscription default for this model.                     |
| `openrouter`     | `deepseek/deepseek-v4.1-flash`                               | 1,048,576 / 943,718 | Correct the old output snapshot to the live primary-provider ceiling. This is not the direct DeepSeek API ceiling. |
| `openrouter`     | product-owned `okou-1.0` / request preset `@preset/okou-1-0` | 1,050,000 / 128,000 | Existing backing-model metadata matches the OpenRouter GPT-6 Luna route.                                           |

## First-party sources

### Codex subscription

The provider-owned
[Codex catalog at `14a477ea89712071944244022e8a10142845456e`](https://github.com/openai/codex/blob/14a477ea89712071944244022e8a10142845456e/codex-rs/models-manager/models.json)
contains all five exact identities, with `context_window: 272000`,
`max_context_window: 872000` and `supports_experimental_context: false`.
The [configuration reference](https://developers.openai.com/codex/config-reference)
distinguishes the active context budget from the auto-compaction threshold.
Their existing 128,000 Pi output ceilings are unchanged; this audit does not
infer subscription capacity or availability from a public API model page.

`gpt-6.1-terra` was added later: the
[Codex catalog at `126a0ee92ed2c5e73cd8a8f7e37563e8527552d7`](https://github.com/openai/codex/blob/126a0ee92ed2c5e73cd8a8f7e37563e8527552d7/codex-rs/models-manager/models.json)
gives it `context_window: 500000`, `max_context_window: 872000` and
`supports_experimental_context: false`. Its 128,000 output ceiling matches the
other Codex identities; only the hand pin's display prices come from the
[API model page](https://developers.openai.com/api/docs/models/gpt-6.1-terra).

### OpenRouter

- [Live Models API](https://openrouter.ai/api/v1/models)
- [Primary-provider field semantics](https://openrouter.ai/docs/guides/overview/models)
- [V4.1 Flash endpoints](https://openrouter.ai/api/v1/models/deepseek/deepseek-v4.1-flash/endpoints)

The live V4.1 primary provider reports 1,048,576 / 943,718. Individual endpoints
are heterogeneous: observed output limits range from 131,072 to 943,718, and
some contexts are smaller. The primary-provider snapshot is not a promise that
all fallback endpoints accept its maximum. No routing or account setting is
changed.

## Implementation and refresh contract

`model-limits.ts` is a small correction table, not an admission registry or live
metadata fetch. `resolvePiAgentModel` first requires a valid source model, then
looks up the exact provider and `catalogModel ?? model`. Only context/output
numbers are changed; costs, pricing tiers, credentials, dialect compatibility,
reasoning defaults and the opaque request model remain with their existing
owners.

Re-audit the exact provider bindings before changing a correction. When the
upstream SDK actually carries matching metadata, remove the redundant override
while verifying the request identity and effective context/output limits. Do not
substitute a similar model or create a new provider reader.

## Bundled CLI deployment

Pi uses the CLI bundled into its owning Runner. Model-limit corrections reach
sandbox sessions through a Runner release; an API-only deployment does not
update that runtime. No historical session, selection, usage or event is
rewritten.

## Incident and policy boundary

This aligns verified runtime metadata; it is not proof that all failures in
#37167/#37541 are fixed. Pi's separate 13,107-token compaction-summary budget,
reasoning strength and retry/recovery ownership are unchanged. Deployment, bounded production recurrence checks
and final task recovery remain separate work.
