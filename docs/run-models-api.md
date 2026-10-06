# Run models API

`GET /api/run-models` lists the fixed platform Auto model and the requesting member's connected personal subscriptions. The response is `{ defaultModel, models }`; it carries no organization policy identity, revision or write precondition.

Auto is `okou-1.0`, executed exclusively by `openrouter-codex` using `@preset/okou-1-0`. Its route and billing identity are code-owned constants. Platform routing does not select among organization policies or catalog candidates. The ordinary usage-pricing preflight, credit admission, immutable billing attribution and historical usage readers remain in place.

Personal ChatGPT/Codex and Claude subscriptions retain their account ownership, reconnect state, model catalog, efforts and service tiers. A reconnect-required subscription remains visible and is not silently converted into platform billing. Launch admission captures and validates the owner's concrete connected account. Claude subscriptions use the vendor harness; Codex subscriptions may use Pi where its supported dialect and tier allow it.

Stored unsupported Custom model choices normalize to Auto at selection. Valid personal subscription selections retain their member credential scope. No data backfill or mixed-client API compatibility is provided for this cutover.

The organization policy/mode, organization provider configuration and gateway configuration APIs are removed. Personal provider APIs only manage subscriptions. `GET /api/model-catalog` publishes Auto and personal subscription metadata, not a platform multi-model price directory. Image settings and image execution are unchanged.

Memory Stage 1 retains exact source-owner and subscription credential validation; organization API-key and custom-gateway extraction branches are removed. Phase 2 selects current connected personal Codex credentials or the platform-owned maintenance route, never a historical organization's API-key/gateway source.
