# welcome-chat-threads

## welcome-chat-threads-001

- Vitest: "POST /api/welcome-chat-threads > requires authentication"
- Mode: run
- Given: The caller sends no authentication.
- When: The caller posts a new `clientThreadId` to `POST /api/welcome-chat-threads`.
- Then: The response is HTTP 401.

## welcome-chat-threads-002

- Vitest: "POST /api/welcome-chat-threads > requires an active workspace"
- Mode: run
- Given: A signed-in user has no active workspace.
- When: The user posts a new `clientThreadId` to `POST /api/welcome-chat-threads`.
- Then: The response is HTTP 401.

## welcome-chat-threads-003

- Vitest: "POST /api/welcome-chat-threads > rejects an execution credential after the member leaves the organization"
- Mode: run
- Given: A workspace member holds an Okou execution credential from a Run, and the member is then removed from the organization.
- When: The removed member's credential posts a new `clientThreadId` to `POST /api/welcome-chat-threads`.
- Then: The response is HTTP 401, and the workspace admin's `GET /api/chat-threads/events` contains no created event for that thread ID.

## welcome-chat-threads-004

- Vitest: "POST /api/welcome-chat-threads > creates a runless personal welcome with the default model and connector state"
- Mode: run
- Given: A signed-in member's Pro entitlement period ended 90 days ago, the member has a personal subscription model, and realtime notifications fail to publish.
- When: The member creates a welcome thread via `POST /api/welcome-chat-threads`, creates a second one with another client ID, reads connector selections, pins the model via `POST /api/chat-threads/:id/model-selection`, and sends a prompt to the first thread.
- Then: Creation returns HTTP 201 and the metadata shows title "Welcome to Okou", `selectedModel: "claude-fable-5-1"`, `serviceTier: null` and `cloudBrowserEnabled: true`. The thread has one `output.message` row at sequence 1 with no Run, context or Run event, containing "# 👋 Hi, I'm Okou" and "**Your preferences belong in personal Instructions.**", and one created event. The second create returns a different thread with one row, connector selections are empty, the model pin returns HTTP 204, the prompt returns HTTP 201 for the thread, and the welcome row stays unchanged.

## welcome-chat-threads-005

- Vitest: "POST /api/welcome-chat-threads > falls back to the fixed default model and does not require generation credits"
- Mode: run
- Given: A signed-in member with an expired Pro entitlement and zero credits has deleted the `claude-code-oauth-token` model provider via `DELETE /api/me/model-providers/:type` (HTTP 204).
- When: The member creates a welcome thread via `POST /api/welcome-chat-threads`.
- Then: The thread metadata shows `selectedModel: "auto"`, the billing status still shows 0 credits, and the thread holds an `output.message` row with no Run.

## welcome-chat-threads-006

- Vitest: "POST /api/welcome-chat-threads > delivers the My Okou welcome by default in en-US without legacy media"
- Mode: run
- Given: Row `en-US`. A signed-in member has set their locale to `en-US`, and the app URL is `https://pr-33252-app.omby.ai`.
- When: The member creates a welcome thread via `POST /api/welcome-chat-threads`.
- Then: The thread has exactly one event whose content mentions Instructions and Workflow, links to `https://pr-33252-app.omby.ai/?settings=my-okou&focus=instructions)`, `https://pr-33252-app.omby.ai/?settings=people` and `https://pr-33252-www.omby.ai/en/workflow-automation-examples`, contains no `{{` placeholders, and includes the campaign visual, presentation artifact, website artifact, Slack scene, Telegram scene and all My Okou welcome asset URLs.

## welcome-chat-threads-007

- Vitest: "POST /api/welcome-chat-threads > delivers the My Okou welcome by default in pt-BR without legacy media"
- Mode: run
- Given: Row `pt-BR`. A signed-in member has set their locale to `pt-BR`, and the app URL is `https://pr-33252-app.omby.ai`.
- When: The member creates a welcome thread via `POST /api/welcome-chat-threads`.
- Then: The thread has exactly one event whose content mentions Instructions and Workflow, links to `https://pr-33252-app.omby.ai/?settings=my-okou&focus=instructions)`, `https://pr-33252-app.omby.ai/?settings=people` and `https://pr-33252-www.omby.ai/en/workflow-automation-examples`, contains no `{{` placeholders, and includes the campaign visual, presentation artifact, website artifact, Slack scene, Telegram scene and all My Okou welcome asset URLs.

## welcome-chat-threads-008

- Vitest: "POST /api/welcome-chat-threads > delivers the My Okou welcome by default in ja-JP without legacy media"
- Mode: run
- Given: Row `ja-JP`. A signed-in member has set their locale to `ja-JP`, and the app URL is `https://pr-33252-app.omby.ai`.
- When: The member creates a welcome thread via `POST /api/welcome-chat-threads`.
- Then: The thread has exactly one event whose content mentions Instructions and Workflow, links to `https://pr-33252-app.omby.ai/?settings=my-okou&focus=instructions)`, `https://pr-33252-app.omby.ai/?settings=people` and `https://pr-33252-www.omby.ai/en/workflow-automation-examples`, contains no `{{` placeholders, and includes the campaign visual, presentation artifact, website artifact, Slack scene, Telegram scene and all My Okou welcome asset URLs.

## welcome-chat-threads-009

- Vitest: "POST /api/welcome-chat-threads > delivers the My Okou welcome by default in ko-KR without legacy media"
- Mode: run
- Given: Row `ko-KR`. A signed-in member has set their locale to `ko-KR`, and the app URL is `https://pr-33252-app.omby.ai`.
- When: The member creates a welcome thread via `POST /api/welcome-chat-threads`.
- Then: The thread has exactly one event whose content mentions Instructions and Workflow, links to `https://pr-33252-app.omby.ai/?settings=my-okou&focus=instructions)`, `https://pr-33252-app.omby.ai/?settings=people` and `https://pr-33252-www.omby.ai/en/workflow-automation-examples`, contains no `{{` placeholders, and includes the campaign visual, presentation artifact, website artifact, Slack scene, Telegram scene and all My Okou welcome asset URLs.

## welcome-chat-threads-010

- Vitest: "POST /api/welcome-chat-threads > delivers the My Okou welcome by default in id-ID without legacy media"
- Mode: run
- Given: Row `id-ID`. A signed-in member has set their locale to `id-ID`, and the app URL is `https://pr-33252-app.omby.ai`.
- When: The member creates a welcome thread via `POST /api/welcome-chat-threads`.
- Then: The thread has exactly one event whose content mentions Instructions and Workflow, links to `https://pr-33252-app.omby.ai/?settings=my-okou&focus=instructions)`, `https://pr-33252-app.omby.ai/?settings=people` and `https://pr-33252-www.omby.ai/en/workflow-automation-examples`, contains no `{{` placeholders, and includes the campaign visual, presentation artifact, website artifact, Slack scene, Telegram scene and all My Okou welcome asset URLs.

## welcome-chat-threads-011

- Vitest: "POST /api/welcome-chat-threads > delivers the My Okou welcome by default in de-DE without legacy media"
- Mode: run
- Given: Row `de-DE`. A signed-in member has set their locale to `de-DE`, and the app URL is `https://pr-33252-app.omby.ai`.
- When: The member creates a welcome thread via `POST /api/welcome-chat-threads`.
- Then: The thread has exactly one event whose content mentions Instructions and Workflow, links to `https://pr-33252-app.omby.ai/?settings=my-okou&focus=instructions)`, `https://pr-33252-app.omby.ai/?settings=people` and `https://pr-33252-www.omby.ai/en/workflow-automation-examples`, contains no `{{` placeholders, and includes the campaign visual, presentation artifact, website artifact, Slack scene, Telegram scene and all My Okou welcome asset URLs.

## welcome-chat-threads-012

- Vitest: "POST /api/welcome-chat-threads > delivers the My Okou welcome by default in es-ES without legacy media"
- Mode: run
- Given: Row `es-ES`. A signed-in member has set their locale to `es-ES`, and the app URL is `https://pr-33252-app.omby.ai`.
- When: The member creates a welcome thread via `POST /api/welcome-chat-threads`.
- Then: The thread has exactly one event whose content mentions Instructions and Workflow, links to `https://pr-33252-app.omby.ai/?settings=my-okou&focus=instructions)`, `https://pr-33252-app.omby.ai/?settings=people` and `https://pr-33252-www.omby.ai/en/workflow-automation-examples`, contains no `{{` placeholders, and includes the campaign visual, presentation artifact, website artifact, Slack scene, Telegram scene and all My Okou welcome asset URLs.

## welcome-chat-threads-013

- Vitest: "POST /api/welcome-chat-threads > delivers the My Okou welcome by default in it-IT without legacy media"
- Mode: run
- Given: Row `it-IT`. A signed-in member has set their locale to `it-IT`, and the app URL is `https://pr-33252-app.omby.ai`.
- When: The member creates a welcome thread via `POST /api/welcome-chat-threads`.
- Then: The thread has exactly one event whose content mentions Instructions and Workflow, links to `https://pr-33252-app.omby.ai/?settings=my-okou&focus=instructions)`, `https://pr-33252-app.omby.ai/?settings=people` and `https://pr-33252-www.omby.ai/en/workflow-automation-examples`, contains no `{{` placeholders, and includes the campaign visual, presentation artifact, website artifact, Slack scene, Telegram scene and all My Okou welcome asset URLs.

## welcome-chat-threads-014

- Vitest: "POST /api/welcome-chat-threads > delivers the My Okou welcome by default in fr-FR without legacy media"
- Mode: run
- Given: Row `fr-FR`. A signed-in member has set their locale to `fr-FR`, and the app URL is `https://pr-33252-app.omby.ai`.
- When: The member creates a welcome thread via `POST /api/welcome-chat-threads`.
- Then: The thread has exactly one event whose content mentions Instructions and Workflow, links to `https://pr-33252-app.omby.ai/?settings=my-okou&focus=instructions)`, `https://pr-33252-app.omby.ai/?settings=people` and `https://pr-33252-www.omby.ai/en/workflow-automation-examples`, contains no `{{` placeholders, and includes the campaign visual, presentation artifact, website artifact, Slack scene, Telegram scene and all My Okou welcome asset URLs.

## welcome-chat-threads-015

- Vitest: "POST /api/welcome-chat-threads > delivers the My Okou welcome by default in hi-IN without legacy media"
- Mode: run
- Given: Row `hi-IN`. A signed-in member has set their locale to `hi-IN`, and the app URL is `https://pr-33252-app.omby.ai`.
- When: The member creates a welcome thread via `POST /api/welcome-chat-threads`.
- Then: The thread has exactly one event whose content mentions Instructions and Workflow, links to `https://pr-33252-app.omby.ai/?settings=my-okou&focus=instructions)`, `https://pr-33252-app.omby.ai/?settings=people` and `https://pr-33252-www.omby.ai/en/workflow-automation-examples`, contains no `{{` placeholders, and includes the campaign visual, presentation artifact, website artifact, Slack scene, Telegram scene and all My Okou welcome asset URLs.

## welcome-chat-threads-016

- Vitest: "POST /api/welcome-chat-threads > delivers the My Okou welcome by default in zh-Hans without legacy media"
- Mode: run
- Given: Row `zh-Hans`. A signed-in member has set their locale to `zh-Hans`, and the app URL is `https://pr-33252-app.omby.ai`.
- When: The member creates a welcome thread via `POST /api/welcome-chat-threads`.
- Then: The thread has exactly one event whose content mentions Instructions and Workflow, links to `https://pr-33252-app.omby.ai/?settings=my-okou&focus=instructions)`, `https://pr-33252-app.omby.ai/?settings=people` and `https://pr-33252-www.omby.ai/en/workflow-automation-examples`, contains no `{{` placeholders, and includes the campaign visual, presentation artifact, website artifact, Slack scene, Telegram scene and all My Okou welcome asset URLs.

## welcome-chat-threads-017

- Vitest: "POST /api/welcome-chat-threads > delivers the My Okou welcome by default in zh-Hant without legacy media"
- Mode: run
- Given: Row `zh-Hant`. A signed-in member has set their locale to `zh-Hant`, and the app URL is `https://pr-33252-app.omby.ai`.
- When: The member creates a welcome thread via `POST /api/welcome-chat-threads`.
- Then: The thread has exactly one event whose content mentions Instructions and Workflow, links to `https://pr-33252-app.omby.ai/?settings=my-okou&focus=instructions)`, `https://pr-33252-app.omby.ai/?settings=people` and `https://pr-33252-www.omby.ai/en/workflow-automation-examples`, contains no `{{` placeholders, and includes the campaign visual, presentation artifact, website artifact, Slack scene, Telegram scene and all My Okou welcome asset URLs.

## welcome-chat-threads-018

- Vitest: "POST /api/welcome-chat-threads > inherits the member's chat model at creation"
- Mode: run
- Given: A signed-in member with a personal subscription model sets their chat model preference to `claude-fable-5-1` via `PUT /api/user-model-preference` (HTTP 200).
- When: The member creates a welcome thread via `POST /api/welcome-chat-threads`.
- Then: The thread metadata shows `selectedModel: "claude-fable-5-1"`.
