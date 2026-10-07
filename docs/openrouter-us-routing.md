# Platform OpenRouter US routing

Platform OpenRouter routing selects `https://us.openrouter.ai` for all users,
but only for platform-owned keys and the product-approved non-DeepSeek
model/API pairs in `openrouter-routing.ts`. It does not change the built-in
provider, any DeepSeek endpoint, personal subscription endpoints, or model
defaults.

Auto (`okou-1.0`) runs only through the built-in `openrouter-codex` provider
with the upstream preset `@preset/okou-1-0`. That preset is not in the US
allowlist, so Auto keeps the global endpoint. The Pi memory DeepSeek binding
also uses OpenRouter and always uses the global endpoint.

The 2026-09-13 tests and official US catalog comparison in
[#33565](https://github.com/vm0-ai/vm0/issues/33565), plus the 2026-09-18
recheck, established US support for the allowlisted GPT Responses model/API
pairs. DeepSeek is intentionally excluded from US routing so its OpenRouter
route retains the global provider pool instead of narrowing to one regional
upstream. Voice input uses Google Cloud after
[#33769](https://github.com/vm0-ai/vm0/pull/33769) and is outside this OpenRouter
routing. No remaining platform Chat Completions model has verified US support.
Unsupported combinations retain their global endpoint, including the Auto
preset, all DeepSeek models, and the current internal text/image/translation
helpers. Catalog presence alone does not authorize another API or model; update
the allowlist only after verifying that combination.

## Selection and capture

Built-in selection resolves an available platform OpenRouter key before choosing
the endpoint. The route is unavailable when no key is available or the Auto
cooldown has not expired. Only an allowlisted platform-owned route uses the US
endpoint instead of the global endpoint.
The execution context captures the selected provider, environment, Codex/Pi
metadata, and exact firewall destinations together. US overrides use an existing
inline firewall entry so a later name lookup cannot restore the global endpoint.
Unverified API paths retain their current destination and auth binding.

Pi memory Stage 1 and Phase 2 use the same built-in OpenRouter binding for every
owner. Their built-in V4.1 Flash model uses OpenRouter with the pinned `low`
(Stage 1) and `high` (Phase 2) reasoning efforts. Provider capability checks
still apply after route selection, and unsupported work fails closed. Each
work owner's credentials, billing identity and other feature settings remain
owner-scoped.

The routing policy affects new OpenRouter endpoint captures. Queued/claimed
executions and requests already in progress keep their captured provider,
endpoint and credentials. There is no failure-triggered retry against another
OpenRouter host. Ordinary existing retry, error handling, billing and provider
selection remain in place.

## Deployment and rollback

The routing policy takes effect when a revision is deployed; it does not rewrite
already captured routes or require a database migration. During API rollout,
old instances still use their previous routing policy. Confirm the platform
keys' Business/Enterprise in-region entitlement and compatible API for the
allowlisted routes.

Claude Code/Codex consumers use existing environment, runtime configuration and
inline-firewall contracts; no new job fields or database migration are needed.
New readers continue accepting existing global contexts. Prefer reverting the
writer policy while keeping readers that understand captured US contexts.
Follow [deployment compatibility](deployment-compatibility.md) when planning
rollout or rollback.
