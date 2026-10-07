# Gemini auxiliary generation on Vertex AI

API-owned Gemini generation uses native Google `generateContent`, not OpenRouter
chat completions. This is independent of organization model-mode retirement,
execution-route cleanup, caller-owned subscriptions and Runner model selection.

## Scope

| Consumer                          | Model                 | Thinking | Output budget |
| --------------------------------- | --------------------- | -------- | ------------- |
| Chat and shared-thread titles     | Gemini 3.1 Flash-Lite | MINIMAL  | 2,048         |
| Notification and Run summaries    | Gemini 3.1 Flash-Lite | MINIMAL  | 2,048         |
| Activity summaries                | Gemini 3.1 Flash-Lite | MINIMAL  | 1,024         |
| Agent setup prompts               | Gemini 3.1 Flash-Lite | MINIMAL  | 2,048         |
| Home recommendation prose         | Gemini 3.1 Flash-Lite | MINIMAL  | 2,048         |
| Onboarding profile/recommendation | Gemini 3.1 Flash-Lite | MINIMAL  | 2,200         |
| Recommended follow-ups            | Gemini 3.8 Flash      | LOW      | 2,048         |
| Independent voice-draft polish    | Gemini 3.1 Flash-Lite | MINIMAL  | 65,536        |

Voice input already uses Flash-Lite on Vertex. Voice request lifetimes, schemas,
retry policy and maximum text lengths remain in the
[voice guide](./google-llm-voice.md). Maps Grounding retains its separate Gemini
2.5 Flash model, entitlement and billing contract; it is not auxiliary prose.

Jev Home scoring (`typesafe/jev-1.13`), memory and fixed Auto are not migrated
here. Home refresh therefore requires both Google configuration for prose and
the existing OpenRouter key for Jev.

The old Native Morning Brief generation entrypoint is already retired. Its
historical database receipts and content-retention cleanup are untouched; no
Vertex cost is invented or written into an OpenRouter-denominated receipt.

## Transport and output contracts

`signals/external/vertex-text.ts` is the text-only native boundary. Model
configuration is shared with voice in `vertex-models.ts`; audio request handling
and voice-specific errors remain separate. The US replica endpoint is
`aiplatform.us.rep.googleapis.com`, location `us`. US multi-region is not a
promise of Oregon processing.

The boundary uses the existing GCP workload-identity authentication:
`GCP_LLM_PROJECT_ID`, `GCP_LLM_WORKLOAD_IDENTITY_PROVIDER` and
`GCP_LLM_SERVICE_ACCOUNT_EMAIL`. No API key, service-account file, new IAM
policy or automatic provider fallback is introduced. Missing Google
configuration preserves each caller's existing unavailable/optional behavior.
An available OpenRouter key cannot substitute for missing or failed Google auth.

Text system messages become `systemInstruction`, assistant messages become native
`model` content, and user messages remain `user` content. Onboarding requests
`responseMimeType: application/json` with its JSON Schema; the existing strict
local Zod validator remains authoritative. Flash-Lite retains caller sampling
settings; 3.8 Flash omits unsupported sampling controls.

Successful bodies are limited to 256 KiB. Blocked, malformed, empty, unexpected
tool-call and non-STOP results are rejected. Thought parts never enter visible
text. Only notification and Run summaries opt into usable MAX_TOKENS text;
immutable titles, setup briefs, follow-up JSON, onboarding and activity output
continue rejecting truncated results. Candidate and thought token counts are
reported as bounded counts, never as a fabricated monetary cost.

All network/auth waits inherit the caller's final positional AbortSignal and
are bounded by a 30-second operation deadline, including long-lived background
owners and legacy optional-signal callers. Activity and onboarding retain their
shorter existing 10- and 20-second generation deadlines. Text transport adds no retries; feature
cooldowns, claim fencing and existing presentation defaults remain unchanged.

## Deployment and acceptance boundary

This is an API-internal provider change: no database migration, persisted queue
shape, App/CLI/Runner protocol or feature-switch override changes. Old and new
clients consume the same API responses and chat events. During API rolling
deployment each API revision uses its own provider; there is no dual-generation
or new-code fallback to an old transport. API rollback restores the earlier
routing without rewriting user data.

Existing Google configuration, workload identity and model entitlement must be
valid on the deployment before relying on auxiliary output. Source checks and
mocked HTTP route tests do not prove live Google model access, generation quality,
production serving or rollout acceptance. This PR neither changes cloud/provider
configuration nor approves or performs a production deployment.
