# Platform OpenRouter US routing

Platform OpenRouter routing selects `https://us.openrouter.ai` for all users,
but only for platform-owned keys and the product-approved non-DeepSeek
model/API pairs in `openrouter-routing.ts`. The former `openRouterUsRouting`
feature switch was fully rolled out and removed; there is no per-user or staff
override. It does not change built-in provider priority or any
DeepSeek endpoint. BYOK, connection presets, saved URLs, other direct providers
and model defaults are unchanged.

Platform-owned built-in DeepSeek models always skip the direct `deepseek`
candidate and evaluate the remaining candidates in their canonical order for
all users. OpenRouter is currently the only remaining candidate, but the policy
does not restrict future fallback providers to OpenRouter. DeepSeek OpenRouter
candidates always use the global endpoint.
BYOK DeepSeek credentials keep their direct endpoint.

The 2026-09-13 tests and official US catalog comparison in
[#33565](https://github.com/vm0-ai/vm0/issues/33565), plus the 2026-09-18
recheck, established US support for the current Claude Messages and GPT
Responses routes. DeepSeek is intentionally excluded from US routing so its
OpenRouter route retains the global provider pool instead of narrowing to one
regional upstream. Voice input uses Google Cloud after
[#33769](https://github.com/vm0-ai/vm0/pull/33769) and is outside this OpenRouter
routing. No remaining platform Chat Completions model has verified US support.
Unsupported combinations retain their global endpoint, including all DeepSeek
models, Claude Fable 5.1, and the current internal text/image/translation
helpers. Catalog presence
alone does not authorize another API or model; update the allowlist only after
verifying that combination.

## Selection and capture

Built-in primary/fallback selection resolves the first available platform key in
canonical provider order before choosing the endpoint. Direct DeepSeek is
ineligible for new built-in selections; the remaining candidates retain their
catalog order. The route is unavailable when none of those candidates has an
available key, complete usage pricing and an expired or absent cooldown; it does
not fall back to direct DeepSeek. DeepSeek OpenRouter candidates remain global;
only an eligible non-DeepSeek route uses the US endpoint instead of the global
endpoint.
The execution context captures the selected provider, environment, Codex/Pi
metadata, and exact firewall destinations together. US overrides use an existing
inline firewall entry so a later name lookup cannot restore the global endpoint.
Unverified API paths retain their current destination and auth binding.

Pi memory Stage 1 and Phase 2 apply the same built-in candidate policy to every
owner. Their built-in V4.1 Flash model uses OpenRouter with the pinned `low`
(Stage 1) and `high` (Phase 2) reasoning efforts. Provider capability checks
still apply after route selection, and unsupported work fails closed. Each
work owner's credentials, billing identity and other feature settings remain
owner-scoped.

The routing policy affects new provider selections and new OpenRouter endpoint
captures. Queued/claimed executions and requests
already in progress keep their captured provider, endpoint and credentials,
including direct DeepSeek routes selected by an older API. Existing DeepSeek work captured on the US
host remains readable, while new DeepSeek selections capture the global host.
There is no failure-triggered retry against direct DeepSeek or another
OpenRouter host. Ordinary existing retry, error handling, billing and provider
selection remain in place.

## Deployment and rollback

The all-user built-in DeepSeek policy takes effect when this revision is
deployed; it does not rewrite already captured routes or require a database
migration. During API rollout, old instances still use their previous routing
policy. Confirm the
platform keys' Business/Enterprise in-region entitlement and compatible API for
the retained Claude and GPT routes. The earlier live probes used the authorized
connector key; they do not establish entitlement for every platform key.

GA Claude Code/Codex consumers use existing environment, runtime configuration
and inline-firewall contracts; no new job fields or database migration are
needed. New readers continue accepting existing global contexts.

Pi native Messages has a strict endpoint reader in both TypeScript and Rust.
The new reader accepts US only for eligible builtin-owned Messages routes.
Readers continue to accept captured global contexts for eligible routes, so
work captured before US routing reached every user stays readable. Retain
supporting readers for captured US contexts; an older API/Runner rollback can
reject them. Prefer reverting the writer policy while keeping the readers that
understand captured US contexts. Eligible routes use Pi for all users. No
additional compatibility path is introduced.
Follow [deployment compatibility](deployment-compatibility.md) when planning
rollout or rollback. Changing the route policy does not itself deploy this
revision.
