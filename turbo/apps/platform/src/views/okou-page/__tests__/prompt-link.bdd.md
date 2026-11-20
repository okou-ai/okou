# Prompt link

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [prompt-link.test.tsx](prompt-link.test.tsx).

## prompt-link-001

Original test `A prompt link prefills a specific agent's chat`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/prompt-link.test.tsx#L145).

- **Given** A visitor opens a specific agent's chat using a link containing “Draft a launch brief.”
- **When** The chat page loads.
- **Then** The prompt appears in the editable composer and can be extended with “ for Friday.” The agent chat remains selected, the URL query is cleared, and no chat is created or sent.

## prompt-link-002

Original test `A prompt link prefills a new chat from Home`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/prompt-link.test.tsx#L167).

- **Given** A visitor opens Home using a link containing “Outline the customer interview.”
- **When** The page loads and the visitor adds “ questions” to the prompt.
- **Then** The prompt remains editable with the added text, navigation proceeds to the default agent's chat, the query is cleared, and no chat is created or sent.

## prompt-link-003

Original test `My Okou prefills a prompt link on its chat page at Home`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/prompt-link.test.tsx#L187).

- **Given** A visitor with the single-agent experience enabled opens Home using a prompt link.
- **When** The page loads.
- **Then** The prompt appears on the Home chat page, the query is cleared, and no chat is created or sent.

## prompt-link-004

Original test `My Okou moves an agent chat prompt link to Home`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/prompt-link.test.tsx#L203).

- **Given** A visitor with the single-agent experience enabled opens a specific agent's chat using a prompt link.
- **When** The page loads.
- **Then** The prompt appears on Home, the query is cleared, and no chat is created or sent.

## prompt-link-005

Original test `A prompt route starts a chat with its selected personal subscription model`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/prompt-link.test.tsx#L223).

- **Given** A member with a connected personal model subscription has selected GPT 6 Astra, priority service, and low reasoning effort. The prompt route also specifies GPT 6 Astra and a GitHub connector.
- **When** The member opens the route with “Compare the launch options” and submits the prompt link.
- **Then** A chat starts with GPT 6 Astra, and the sent prompt includes the prompt text and selected-model information but not the GitHub connector. The URL query is cleared and no Codex service tier is sent.

## prompt-link-006

Original test `A prompt link uses the member default when its model is missing or invalid:`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/prompt-link.test.tsx#L271).

- **Given** A member with connected personal model subscriptions has GPT 6 Astra selected, priority service, and low reasoning effort. The prompt link has no model parameter.
- **When** The member opens the prompt link and it starts a chat.
- **Then** The chat uses GPT 6 Astra with low effort and priority service; the sent model information includes priority service, and the Codex tier is fast.

## prompt-link-007

Original test `A prompt link uses the member default when its model is missing or invalid: &model=unknown-model`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/prompt-link.test.tsx#L271).

- **Given** A member with connected personal model subscriptions has GPT 6 Astra selected, priority service, and low reasoning effort. The prompt link specifies an unknown model.
- **When** The member opens the prompt link and it starts a chat.
- **Then** The chat falls back to GPT 6 Astra with low effort and priority service; the sent model information includes priority service, and the Codex tier is fast.

## prompt-link-008

Original test `Completing a prompt link preserves a model chosen in a later composer`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/prompt-link.test.tsx#L304).

- **Given** A prompt-link launch for GPT 6 Astra is still pending while the visitor navigates to a new chat.
- **When** The visitor selects Claude Sonnet 5.5 in the composer, then the linked launch completes and the visitor sends “Send my next task with this model.”
- **Then** Claude Sonnet 5.5 remains selected after the linked launch completes, and the next chat is created with that model.

## prompt-link-009

Original test `A prompt link starts an illustration chat with its selected style`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/prompt-link.test.tsx#L368).

- **Given** A visitor opens a prompt link for an illustration using the Cozy Parlor style.
- **When** The prompt link starts a chat.
- **Then** The sent message includes an illustration template snapshot titled “Cozy Parlor” with the Cozy Parlor style selected.

## prompt-link-010

Original test `A prompt link starts a presentation chat with its selected template`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/prompt-link.test.tsx#L390).

- **Given** A visitor opens a prompt link for a presentation using the Playful Launch Presentation template.
- **When** The prompt link starts a chat.
- **Then** The sent message includes the “Sunburst playroom” presentation template with its selected template, color system, and preview. The created chat has no selected model and the message contains no model part.

## prompt-link-011

Original test `A retired video template link keeps its brief as an editable draft`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/prompt-link.test.tsx#L419).

- **Given** A visitor opens a prompt link for the retired Epic Grandeur video template.
- **When** The page loads and the visitor adds “ for launch” to the prompt.
- **Then** The prompt remains an editable draft with the added text; the visitor is taken to the default agent's chat, the query is cleared, no inline template is shown, and no chat is created or sent.

## prompt-link-012

Original test `A prompt link starts a website chat with its selected template`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/prompt-link.test.tsx#L440).

- **Given** A visitor opens a prompt link for a website using the Black Slabs template.
- **When** The prompt link starts a chat.
- **Then** The sent message includes a website template snapshot titled “Black Slabs” with that template selected.

## prompt-link-013

Original test `An unavailable model leaves a prompt link recoverable`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/prompt-link.test.tsx#L462).

- **Given** No run models are available, and a saved unrelated draft exists. A prompt link requests the unavailable model GPT 5.6 Sol.
- **When** The visitor opens the prompt link.
- **Then** The selected-model-unavailable message appears; the visitor remains on the prompt route with the prompt and requested model still in the URL. No chat is created or sent, and the saved draft is not updated.

## prompt-link-014

Original test `An onboarded visitor starts the received task using a 12-character hash`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/prompt-link.test.tsx#L501).

- **Given** An onboarded visitor opens onboarding with a 12-character handoff hash that resolves to “Summarize the customer feedback.” The URL also contains untrusted prompt text and a retired template.
- **When** The handoff is resolved and the task starts.
- **Then** The received task is sent instead of the URL prompt, and the URL query is cleared.

## prompt-link-015

Original test `An onboarded visitor starts the received task using a 64-character hash`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/prompt-link.test.tsx#L501).

- **Given** An onboarded visitor opens onboarding with a 64-character handoff hash that resolves to “Summarize the customer feedback.” The URL also contains untrusted prompt text and a retired template.
- **When** The handoff is resolved and the task starts.
- **Then** The received task is sent instead of the URL prompt, and the URL query is cleared.

## prompt-link-016

Original test `A received task can be edited during onboarding without putting its text back in a URL (admin: true)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/prompt-link.test.tsx#L527).

- **Given** An admin who needs onboarding opens a 64-character handoff resolving to “Review the customer feedback.”
- **When** The admin edits the task to “Review the feedback and suggest three improvements.” and selects Next.
- **Then** The edited task is saved and sent, and the URL query is cleared.

## prompt-link-017

Original test `A received task can be edited during onboarding without putting its text back in a URL (admin: false)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/prompt-link.test.tsx#L527).

- **Given** A non-admin whose onboarding is already complete but who still needs onboarding opens a 64-character handoff resolving to “Review the customer feedback.”
- **When** The visitor edits the task to “Review the feedback and suggest three improvements.” and selects Next.
- **Then** The edited task is saved and sent, and the URL query is cleared.

## prompt-link-018

Original test `A file-only hash handoff sends its imported private attachment`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/prompt-link.test.tsx#L582).

- **Given** A visitor opens a prompt route using a handoff hash that resolves to a file-only manifest and imports a private attachment named notes.txt.
- **When** The handoff starts a chat.
- **Then** The sent message includes the imported private attachment with its file ID and filename snapshot, and the URL query is cleared.

## prompt-link-019

Original test `An edited hash is retained while onboarding completion is still pending`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/prompt-link.test.tsx#L623).

- **Given** A visitor who still needs onboarding opens a handoff with “Review the feedback”; onboarding completion will remain pending.
- **When** The visitor edits the prompt and selects Next.
- **Then** The URL retains the newly created 12-character handoff hash while onboarding remains pending, and the editable prompt retains “Preserve this edited request if completion is interrupted.”
