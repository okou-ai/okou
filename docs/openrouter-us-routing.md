# Platform OpenRouter US routing

`OpenRouterUsRouting` (`openRouterUsRouting`) is enabled by default for staff
organizations and disabled by default for other users. Existing per-user
feature-switch overrides take precedence, including an explicit `false` for
staff. When enabled, it selects `https://us.openrouter.ai` only for platform-owned
keys and the product-approved non-DeepSeek model/API pairs in
`openrouter-routing.ts`. It does not change built-in provider priority or any
DeepSeek endpoint. BYOK, connection presets, saved URLs, other direct providers
and model defaults are unchanged.

`DeepSeekAlternativeRouting` is also enabled by default for staff organizations
and disabled by default for other users, with the same explicit per-user
override precedence. When enabled, platform-owned built-in DeepSeek models skip
the direct `deepseek` candidate and evaluate the remaining candidates in their
canonical order. OpenRouter is currently the only remaining candidate, but the
switch does not restrict future fallback providers to OpenRouter. It also does
not imply US routing: DeepSeek OpenRouter candidates always use the global
endpoint, regardless of `OpenRouterUsRouting`.

The 2026-09-13 tests and official US catalog comparison in
[#33565](https://github.com/vm0-ai/vm0/issues/33565), plus the 2026-09-18
recheck, established US support for the current Claude Messages and GPT
Responses routes. DeepSeek is intentionally excluded from US routing so its
OpenRouter route retains the global provider pool instead of narrowing to one
regional upstream. Gemini voice uses Google Cloud after
[#33769](https://github.com/vm0-ai/vm0/pull/33769) and is outside this OpenRouter
switch. No remaining platform Chat Completions or dedicated transcription model
has verified US support. Unsupported combinations retain their global endpoint,
including all DeepSeek models, Claude Fable 5.1, the current internal
text/image/translation helpers and dedicated transcription. Catalog presence
alone does not authorize another API or model; update the allowlist only after
verifying that combination.

## Selection and capture

Built-in primary/fallback selection resolves the first available platform key in
canonical provider order before choosing the endpoint. With
`DeepSeekAlternativeRouting` disabled, an allowlisted OpenRouter candidate is a
fallback after direct DeepSeek. With it enabled, the direct candidate is
ineligible and the remaining candidates retain their catalog order. The route
is unavailable only when none of those candidates has an available key; it does
not fall back to direct DeepSeek. DeepSeek OpenRouter candidates remain global;
`OpenRouterUsRouting` changes only an eligible non-DeepSeek route from the global
endpoint to the US endpoint.
The execution context captures the selected provider, environment, Codex/Pi
metadata, and exact firewall destinations together. US overrides use an existing
inline firewall entry so a later name lookup cannot restore the global endpoint.
Unverified API paths retain their current destination and auth binding.

Pi memory Stage 1 retains its batch-selected
platform model/key, but reads each work owner's feature context before inference;
a batch must not borrow one user's switch for another user's work.
Provider capability checks still apply after route selection. The current
OpenRouter V4 Flash catalog entry does not publish Stage 1's pinned `low`
reasoning effort, so an owner using alternative routing currently fails that
work closed as unsupported instead of borrowing the direct DeepSeek route.
Phase 2's V4.1 Flash `high` effort remains supported on its OpenRouter route.

Switch changes affect new provider selections and OpenRouter endpoint captures.
Queued/claimed executions and requests already in progress keep their captured
provider, endpoint and credentials. Existing DeepSeek work captured on the US
host remains readable, while new DeepSeek selections capture the global host.
There is no failure-triggered retry against direct DeepSeek or another
OpenRouter host. Ordinary existing retry, error handling, billing and provider
selection remain in place.

## Deployment and rollback

The staff default takes effect when this revision is deployed. Confirm the
platform keys' Business/Enterprise in-region entitlement and compatible API for
the retained Claude and GPT routes. The earlier live probes used the authorized
connector key; they do not establish entitlement for every platform key.

GA Claude Code/Codex consumers use existing environment, runtime configuration
and inline-firewall contracts; no new job fields or database migration are
needed. New readers continue accepting existing global contexts.

Pi native Messages has a strict endpoint reader in both TypeScript and Rust.
The new reader accepts US only for eligible builtin-owned Messages routes.
Turning the switch off stops new US selection but does not rewrite captured
work or stored metadata. Retain supporting readers for those contexts; an older
API/Runner rollback can reject them even after switch-off. Prefer reverting the
writer policy while keeping the readers that understand captured US contexts.
PiLoop is enabled by default for all users, while `OpenRouterUsRouting` retains
its staff-default rollout. No additional compatibility path is introduced.
Follow [deployment compatibility](deployment-compatibility.md) when planning
rollout or rollback. Changing the registry default does not itself deploy this
revision.
