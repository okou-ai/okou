# Platform OpenRouter US routing

`OpenRouterUsRouting` (`openRouterUsRouting`) is enabled by default for staff
organizations and disabled by default for other users. Existing per-user
feature-switch overrides take precedence, including an explicit `false` for
staff. When enabled, it selects `https://us.openrouter.ai` only for platform-owned
keys and the verified model/API pairs in `openrouter-routing.ts`. It does not
change built-in provider priority: DeepSeek models still prefer the direct
DeepSeek candidate unless the independent `DeepSeekOpenRouterRouting`
(`deepSeekOpenRouterRouting`) switch requires OpenRouter. Only a selected
OpenRouter candidate changes endpoint. BYOK, connection presets, saved URLs,
other direct providers and model defaults are unchanged.

`DeepSeekOpenRouterRouting` is also enabled by default for staff organizations
and disabled by default for other users, with the same explicit per-user
override precedence. When enabled, platform-owned built-in DeepSeek models can
select only their OpenRouter candidate. It does not imply US routing:
`OpenRouterUsRouting` still independently selects the global or eligible US
endpoint after the OpenRouter candidate is chosen.

The 2026-09-13 tests and official US catalog comparison in
[#33565](https://github.com/vm0-ai/vm0/issues/33565), plus the 2026-09-18
recheck, support four Claude Messages models and seven GPT/DeepSeek Responses
models among the current platform routes. The recheck completed V4 Flash and V4
Pro Responses on the US host; V4.1 Flash was present in the authenticated US
catalog and reached its only in-region upstream, BaseTen, where the shared pool
returned a temporary 429 rather than a data-region rejection. Gemini voice uses
Google Cloud after [#33769](https://github.com/vm0-ai/vm0/pull/33769) and is
outside this OpenRouter switch. No remaining platform Chat Completions or
dedicated transcription model has verified US support. Unsupported combinations
retain their global endpoint, including Claude Fable 5.1, the current internal
text/image/translation helpers and dedicated transcription. Catalog presence
alone does not authorize another API or model; update the allowlist only after
verifying that combination.

## Selection and capture

Built-in primary/fallback selection resolves the first available platform key in
canonical provider order before choosing the endpoint. With
`DeepSeekOpenRouterRouting` disabled, an allowlisted OpenRouter candidate is a
fallback after direct DeepSeek. With it enabled, the direct candidate is
ineligible; a missing or cooling OpenRouter key makes the route unavailable
instead of falling back to direct DeepSeek. `OpenRouterUsRouting` then changes
only an eligible selected OpenRouter route from the global endpoint to the US
endpoint. The execution context captures the selected provider, environment,
Codex/Pi metadata, and exact firewall destinations together. US overrides use
an existing inline firewall entry so a later name lookup cannot restore the
global endpoint. Unverified API paths retain their current destination and auth
binding.

Pi memory Stage 1 retains its batch-selected
platform model/key, but reads each work owner's feature context before inference;
a batch must not borrow one user's switch for another user's work.
Provider capability checks still apply after route selection. The current
OpenRouter V4 Flash catalog entry does not publish Stage 1's pinned `low`
reasoning effort, so an owner who requires OpenRouter fails that work closed as
unsupported instead of borrowing the direct DeepSeek route. Phase 2's V4.1
Flash `high` effort remains supported on its OpenRouter route.

Switch changes affect new provider selections and OpenRouter endpoint captures.
Queued/claimed executions and requests already in progress keep their captured
provider, endpoint and credentials. There is no failure-triggered retry against
direct DeepSeek or the global OpenRouter host. Ordinary existing retry, error
handling, billing and provider selection remain in place.

## Deployment and rollback

The staff default takes effect when this revision is deployed. Confirm the
platform keys' Business/Enterprise in-region entitlement and compatible API,
commit-pinned CLI and Runner native readers for that rollout. The earlier live
probes used the authorized connector key; they do not establish entitlement for
every platform key.

GA Claude Code/Codex consumers use existing environment, runtime configuration
and inline-firewall contracts; no new job fields or database migration are
needed. New readers continue accepting existing global contexts.

Pi native Messages has a strict endpoint reader in both TypeScript and Rust.
The new reader accepts US only for eligible builtin-owned Messages routes.
Turning the switch off stops new US selection but does not rewrite captured
work or stored metadata. Retain supporting readers for those contexts; an older
API/Runner rollback can reject them even after switch-off. Prefer reverting the
writer policy while keeping the readers that understand captured US contexts.
PiLoop remains non-GA, with a
staff-default rollout, and no additional compatibility path is introduced.
Follow [deployment compatibility](deployment-compatibility.md) when planning
rollout or rollback. Changing the registry default does not itself deploy this
revision.
