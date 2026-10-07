# Run models API

`GET /api/run-models` lists the fixed platform Auto model and the requesting member's connected personal subscriptions. The response is `{ defaultModel, models }`.

Auto is `okou-1.0`, executed exclusively by `openrouter-codex` using `@preset/okou-1-0`. Its route and billing identity are code-owned constants. Platform routing does not select among catalog candidates; the only override is the operator-only `org_metadata.openrouter_preset` (NULL uses the default preset). The ordinary usage-pricing preflight, credit admission, immutable billing attribution and historical usage readers remain in place.

Personal ChatGPT/Codex and Claude subscriptions retain their account ownership, reconnect state, model catalog, efforts and service tiers. A reconnect-required subscription remains visible and is not silently converted into platform billing. Launch admission captures and validates the owner's concrete connected account. Claude subscriptions use the vendor harness; Codex subscriptions may use Pi where its supported dialect and tier allow it.

A stored selection that is neither Auto nor an available personal subscription model fails closed: it is rejected with an explicit error and never silently becomes Auto. Catalog resolution follows `replaced_by` chains and reports unknown models rather than substituting the system default. Valid personal subscription selections retain their `member` credential scope; Auto runs use `credentialScope: "org"`.

Personal provider APIs (`/api/me/model-providers`) manage subscriptions only. `GET /api/model-catalog` publishes Auto and personal subscription metadata, not a platform multi-model price directory. Image settings and image execution are independent.

Memory Stage 1 validates the exact source owner and subscription credential. Phase 2 selects current connected personal Codex credentials or the platform-owned maintenance route.
