# Run models API

`GET /api/run-models` lists the fixed platform Auto model and the requesting member's connected personal subscriptions. The response is `{ models }`; the Auto entry has `model: "auto"` and is the default.

Auto selections persist as the nonempty `auto` identity. Public null intent selects Auto; omission on PATCH/send preserves the existing selection, while creation resolves member defaults. Admission captures the exact OpenRouter preset, managed key, dialect, transport and capabilities independently of selected metadata. The operator-only `org_metadata.openrouter_preset` controls new admissions, never a previously captured execution. `okou-1.0` remains retained execution history, not a current selectable model. See [release-three migration and readiness](model-identity-pr3.md) for historical data and snapshot boundaries.

Personal ChatGPT/Codex and Claude subscriptions retain their account ownership, reconnect state, model catalog, efforts and service tiers. A reconnect-required subscription remains visible and is not silently converted into platform billing. Launch admission captures and validates the owner's concrete connected account. Claude subscriptions use the vendor harness; Codex subscriptions may use Pi where its supported dialect and tier allow it.

A stored selection that is neither Auto nor an available personal subscription model fails closed: it is rejected with an explicit error and never silently becomes Auto. Catalog resolution follows `replaced_by` chains and reports unknown models rather than substituting the system default. Valid personal subscription selections retain their `member` credential scope; Auto runs use `credentialScope: "org"`.

Personal provider APIs (`/api/me/model-providers`) manage subscriptions only. `GET /api/model-catalog` publishes Auto and personal subscription metadata, not a platform multi-model price directory. Image settings and image execution are independent.

Memory Stage 1 validates the exact source owner and subscription credential. Phase 2 selects current connected personal Codex credentials or the platform-owned maintenance route.
