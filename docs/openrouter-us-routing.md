# Platform OpenRouter US routing

`OpenRouterUsRouting` (`openRouterUsRouting`) is enabled by default for staff
organizations and disabled by default for other users. Existing per-user
feature-switch overrides take precedence, including an explicit `false` for
staff. When enabled, it selects `https://us.openrouter.ai` only for platform-owned
keys and the verified model/API pairs in `openrouter-routing.ts`. Built-in
DeepSeek models then require their OpenRouter US candidate instead of selecting
the direct DeepSeek candidate. BYOK, connection presets, saved URLs, other
direct providers and model defaults are unchanged.

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

Built-in primary/fallback selection resolves the platform key before choosing
the endpoint. With the switch enabled, a built-in model that has a direct
DeepSeek candidate is restricted to an allowlisted OpenRouter US Responses
candidate. A missing or cooling OpenRouter key makes that route unavailable; it
does not fall back to direct DeepSeek or the global OpenRouter host. The
execution context captures the environment, Codex/Pi metadata, and exact
firewall destinations together. US overrides use an existing inline firewall
entry so a later name lookup cannot restore the global endpoint. Unverified API
paths retain their current destination and auth binding.

Pi memory Stage 1 retains its batch-selected
platform model/key, but reads each work owner's feature context before inference;
a batch must not borrow one user's switch for another user's work.

Switch changes affect new selections. Queued/claimed executions and requests
already in progress keep their captured endpoint and credentials. There is no
failure-triggered retry against the global OpenRouter host. Ordinary existing
retry, error handling, billing and provider selection remain in place.

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
