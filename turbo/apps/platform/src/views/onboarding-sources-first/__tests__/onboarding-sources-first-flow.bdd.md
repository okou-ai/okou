# Onboarding sources first flow

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [onboarding-sources-first-flow.test.tsx](onboarding-sources-first-flow.test.tsx).

## onboarding-sources-first-flow-001

Original test `/onboarding opens the field question and continues to the sources step`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-sources-first-flow.test.tsx#L201).

- **Given** An owner needs onboarding and Gmail is not connected.
- **When** They open onboarding, choose Marketing & content, continue to the sources step, then go back.
- **Then** Continue starts disabled until an industry is chosen. The sources step appears without a loading screen, Continue stays disabled while Gmail is unconnected, and returning to the first step preserves the Marketing & content choice.

## onboarding-sources-first-flow-002

Original test `Waiting for the source catalog keeps onboarding in place and preserves its query`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-sources-first-flow.test.tsx#L258).

- **Given** An owner needs onboarding and the source catalog is still loading; the onboarding URL includes redeemCode=team-promo.
- **When** They choose Marketing & content and continue before the catalog is ready, then the catalog becomes available.
- **Then** The first question stays visible while loading, and onboarding proceeds to the sources step once the catalog is ready. The redeem code remains in the URL.

## onboarding-sources-first-flow-003

Original test `The first step introduces Okou and its compliance progress`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-sources-first-flow.test.tsx#L299).

- **Given** An owner opens the first onboarding step in English.
- **When** The step loads.
- **Then** It asks what kind of work they do, explains that Okou will suggest a fitting first task, displays the asserted SOC 2, CCPA/CPRA, GDPR, HIPAA, and ISO/IEC 27001 compliance statuses, and links to the English security compliance section.

## onboarding-sources-first-flow-004

Original test `The source step links to the security page in ja-JP`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-sources-first-flow.test.tsx#L347).

- **Given** An owner opens the sources step with the Japanese locale.
- **When** The step loads.
- **Then** The data-protection link points to https://www.okou.ai/ja/security.

## onboarding-sources-first-flow-005

Original test `The source step links to the security page in zh-Hant`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-sources-first-flow.test.tsx#L347).

- **Given** An owner opens the sources step with the Traditional Chinese locale.
- **When** The step loads.
- **Then** The data-protection link points to https://www.okou.ai/zh-Hant/security.

## onboarding-sources-first-flow-006

Original test `An owner can skip sources and return to connect later (mobile=false)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-sources-first-flow.test.tsx#L368).

- **Given** An owner on a desktop browser reaches the sources step with Gmail unconnected and redeemCode=LAUNCH50 in the URL.
- **When** They choose Skip, dismiss the confirmation by choosing Connect a tool, then choose Skip again and confirm Skip for now; they later go back.
- **Then** The confirmation first leaves them on the sources step, where Connect Gmail is enabled. Confirming the skip opens the experience step and preserves the redeem code; going back returns to the sources step with Connect Gmail and Skip enabled and Continue disabled.

## onboarding-sources-first-flow-007

Original test `An owner can skip sources and return to connect later (mobile=true)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-sources-first-flow.test.tsx#L368).

- **Given** An owner on a mobile browser reaches the sources step with Gmail unconnected and redeemCode=LAUNCH50 in the URL.
- **When** They choose Skip, dismiss the confirmation by choosing Connect a tool, then choose Skip again and confirm Skip for now; they later go back.
- **Then** The confirmation first leaves them on the sources step, where Connect Gmail is enabled. Confirming the skip opens the mobile experience step titled “Choose how to start” and preserves the redeem code; going back returns to the sources step with Connect Gmail and Skip enabled and Continue disabled.

## onboarding-sources-first-flow-008

Original test `A later step opens without a connected source`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-sources-first-flow.test.tsx#L422).

- **Given** An owner opens a later onboarding step without a connected source.
- **When** They open the ready step directly.
- **Then** The ready step appears and its Start my first task action is enabled.

## onboarding-sources-first-flow-009

Original test `Connected account context replaces the static starting prompt`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-sources-first-flow.test.tsx#L441).

- **Given** An invited member needs their own onboarding, cannot add Slack, and has Gmail connected.
- **When** They choose Marketing & content, continue through the sources and experience steps, pass the Slack step with Not now, and wait for the shared recommendation result.
- **Then** The ready step initially has no generated request. When the result arrives, it shows “Clear the replies that matter” and the generated Gmail request. The recommendation starts with the marketing industry and English locale; no full connector-status read occurs.

## onboarding-sources-first-flow-010

Original test `The ready step shows the generated request once the shared context result arrives`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-sources-first-flow.test.tsx#L526).

- **Given** An invited member needs their own onboarding, has Gmail connected, and the generated recommendation result is delayed.
- **When** They complete the earlier onboarding steps and reach the ready step, then the result arrives.
- **Then** The generated request is absent while the result is pending and appears after it arrives.

## onboarding-sources-first-flow-011

Original test `A failed recommendation leaves the preset request on the ready step`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-sources-first-flow.test.tsx#L582).

- **Given** An invited member needs their own onboarding, has Gmail connected, and the recommendation job fails.
- **When** They complete the earlier onboarding steps and reach the ready step.
- **Then** The preset Gmail request remains on the ready step, and Start my first task is enabled.

## onboarding-sources-first-flow-012

Original test `The ready step completes onboarding once, before it runs the first request`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-sources-first-flow.test.tsx#L620).

- **Given** An owner opens the ready step with Gmail connected and a chat service available.
- **When** They start their first task.
- **Then** Onboarding completes exactly once from the ready step before the first request runs.

## onboarding-sources-first-flow-013

Original test `A refreshed ready step keeps the industry and edited request`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-sources-first-flow.test.tsx#L662).

- **Given** An owner reopens the ready step with a saved marketing industry and the edited request “Draft my launch plan.”
- **When** They start their first task.
- **Then** The first request runs with the saved edited text, and onboarding completion submits the marketing industry.

## onboarding-sources-first-flow-014

Original test `The ready step keeps the request on screen until the first chat opens`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-sources-first-flow.test.tsx#L723).

- **Given** An owner opens the ready step with the saved request “Draft my launch plan,” and completion succeeds while the status handoff to chat is held.
- **When** They start their first task and wait for the handoff to be released.
- **Then** The edited request remains visible while the handoff is pending. After release, the first request runs with that text and the app opens a chat.

## onboarding-sources-first-flow-015

Original test `A member skips sources, completes their own onboarding and enters chat`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-sources-first-flow.test.tsx#L771).

- **Given** An invited member needs their own onboarding, cannot add Slack, and has no connected Gmail source.
- **When** They choose Marketing & content, skip sources, choose to start with Okou, pass Slack with Not now, edit the ready-step request to “Draft my meeting agenda,” and start the task.
- **Then** The ready step initially shows the asserted competitor-research preset. The first request runs with the edited text, completion is sent once from the ready step, and the member leaves onboarding for chat.

## onboarding-sources-first-flow-016

Original test `A step keeps the redeem code it arrived with`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-sources-first-flow.test.tsx#L837).

- **Given** An owner opens onboarding with redeemCode=LAUNCH50.
- **When** They choose Marketing & content and continue to the sources step.
- **Then** The redeem code remains in the URL on the next step.

## onboarding-sources-first-flow-017

Original test `A new user who brings a prompt tries it on the source-first flow's single step`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-sources-first-flow.test.tsx#L864).

- **Given** A new user who needs onboarding opens the source-first flow with the prompt “Draft the launch plan.”
- **When** The onboarding page loads.
- **Then** The single-step prompt page shows that prompt, its task-guidance introduction and compliance region, and an enabled Next action. The normal industry question is not shown.

## onboarding-sources-first-flow-018

Original test `A prompt link prioritizes its connectors without duplicating recommendations`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-sources-first-flow.test.tsx#L895).

- **Given** A new user who needs onboarding opens with a Google Ads prompt link requesting connectors google-ads,gmail,gmail.
- **When** The prompt page loads.
- **Then** Google Ads is prioritized as the first connection, Gmail is recommended only once despite its duplicate query entry, and Notion remains available as a recommendation.

## onboarding-sources-first-flow-019

Original test `The sheet's connector card connects the tool the prompt link names`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-sources-first-flow.test.tsx#L923).

- **Given** A user opens onboarding with a prompt link naming Ahrefs, and the Ahrefs connection sheet is available.
- **When** They open Connect Ahrefs, enter an API token, and save it.
- **Then** The Ahrefs connection is reported as connected, and the onboarding prompt remains “Track keyword rankings.”

## onboarding-sources-first-flow-020

Original test `A prompt with a showcase carries the showcase into the chat`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-sources-first-flow.test.tsx#L975).

- **Given** A new user who needs onboarding opens with the prompt “Draft the launch plan” and a showcase URL.
- **When** They choose Next.
- **Then** The first chat request uses the prompt with the complete-document and artifact-link instructions appended, and the showcase URL remains in the chat URL.

## onboarding-sources-first-flow-021

Original test `The prompt step completes onboarding, then runs the prompt as edited`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-sources-first-flow.test.tsx#L1004).

- **Given** A new user who needs onboarding opens with the prompt “Draft the launch plan.”
- **When** They edit it to “Draft the launch plan for the EU market” and choose Next.
- **Then** Onboarding completes once from the onboarding page before the first chat request runs, and the request uses the edited text with the document and artifact-link instructions appended.

## onboarding-sources-first-flow-022

Original test `The prompt step keeps the edited prompt on screen until the first chat opens`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-sources-first-flow.test.tsx#L1049).

- **Given** A new user who needs onboarding opens with the prompt “Draft the launch plan,” and completion succeeds while the chat handoff is held.
- **When** They edit the prompt to “Draft the launch plan for the EU market,” choose Next, and wait for the handoff to be released.
- **Then** The edited prompt remains visible while the handoff is pending. After release, the first chat request uses the edited text with the document and artifact-link instructions appended, and a chat opens.

## onboarding-sources-first-flow-023

Original test `A prompt link's template carries into the first request`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-sources-first-flow.test.tsx#L1083).

- **Given** A new user who needs onboarding opens with a prompt link and a website template identifier.
- **When** They choose Next to start the first request.
- **Then** The first chat request carries the linked website template and opens a chat.

## onboarding-sources-first-flow-024

Original test `A prompt link attempts redemption before completion (eligible: true)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-sources-first-flow.test.tsx#L1121).

- **Given** A new user who needs onboarding opens with a prompt and a whitespace-padded redeem code; redemption is eligible.
- **When** They choose Next.
- **Then** The code is trimmed to LAUNCH50 and redemption is attempted before onboarding completion. The first request runs with the prompt and appended document instructions, and the redeem-code query parameter is removed.

## onboarding-sources-first-flow-025

Original test `A prompt link attempts redemption before completion (eligible: false)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-sources-first-flow.test.tsx#L1121).

- **Given** A new user who needs onboarding opens with a prompt and a whitespace-padded redeem code; redemption is ineligible.
- **When** They choose Next.
- **Then** The code is trimmed to LAUNCH50 and redemption is attempted before onboarding completion. The first request still runs with the prompt and appended document instructions, and the redeem-code query parameter is removed.

## onboarding-sources-first-flow-026

Original test `A later source-first step opened with a prompt goes back to the prompt page`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-sources-first-flow.test.tsx#L1168).

- **Given** A user opens the sources route with the prompt “Draft the launch plan.”
- **When** The source-first onboarding route resolves.
- **Then** They are taken to the prompt page, which retains the linked prompt.

## onboarding-sources-first-flow-027

Original test `An invited member who brings a prompt still runs the source-first flow`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-sources-first-flow.test.tsx#L1187).

- **Given** An invited member who needs their own onboarding opens with the prompt “Draft the launch plan.”
- **When** The onboarding page loads.
- **Then** The member enters the source-first flow and sees the industry question rather than the prompt page.

## onboarding-sources-first-flow-028

Original test `A blank prompt still opens the source-first flow`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-sources-first-flow.test.tsx#L1202).

- **Given** A user who needs onboarding opens with a prompt query containing only spaces.
- **When** The onboarding page loads.
- **Then** The source-first flow opens at the industry question.

## onboarding-sources-first-flow-029

Original test `An already-onboarded visitor is forwarded with the prompt they brought`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-sources-first-flow.test.tsx#L1217).

- **Given** An already-onboarded visitor opens the sources route with the prompt “Draft the launch plan.”
- **When** The onboarding route resolves.
- **Then** The visitor is forwarded and the first chat request runs with the linked prompt.

## onboarding-sources-first-flow-030

Original test `An onboarded visitor redeems before running a linked prompt (eligible: true)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-sources-first-flow.test.tsx#L1242).

- **Given** An already-onboarded visitor opens with a prompt link and redeem code PRO-CAMPAIGN; redemption is eligible.
- **When** The linked prompt is started.
- **Then** The code is redeemed before the first request runs, the request uses “Draft the launch plan,” and the redeem-code query parameter is removed.

## onboarding-sources-first-flow-031

Original test `An onboarded visitor redeems before running a linked prompt (eligible: false)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-sources-first-flow.test.tsx#L1242).

- **Given** An already-onboarded visitor opens with a prompt link and redeem code PRO-CAMPAIGN; redemption is ineligible.
- **When** The linked prompt is started.
- **Then** The code is redeemed before the first request runs, the request uses “Draft the launch plan,” and the redeem-code query parameter is removed.

## onboarding-sources-first-flow-032

Original test `An onboarded visitor redeems before running a linked handoff (eligible: true)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-sources-first-flow.test.tsx#L1242).

- **Given** An already-onboarded visitor opens with a marketing handoff link and redeem code PRO-CAMPAIGN; redemption is eligible.
- **When** The linked handoff is resolved and started.
- **Then** The code is redeemed before the first request runs, the request uses “Draft the launch plan,” and the redeem-code query parameter is removed.

## onboarding-sources-first-flow-033

Original test `An onboarded visitor redeems before running a linked handoff (eligible: false)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-sources-first-flow.test.tsx#L1242).

- **Given** An already-onboarded visitor opens with a marketing handoff link and redeem code PRO-CAMPAIGN; redemption is ineligible.
- **When** The linked handoff is resolved and started.
- **Then** The code is redeemed before the first request runs, the request uses “Draft the launch plan,” and the redeem-code query parameter is removed.

## onboarding-sources-first-flow-034

Original test `An onboarded visitor can redeem without bringing a prompt`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-sources-first-flow.test.tsx#L1290).

- **Given** An already-onboarded visitor opens with redeem code PRO-CAMPAIGN and no prompt.
- **When** The onboarding route resolves.
- **Then** The code is redeemed, its query parameter is removed, and the visitor is sent to the default agent chat.
- **Upstream change** `4e5707de` (#49556) makes My Okou permanent, so the default chat is Home (`/`) rather than an `/agents/<id>/chat` route; the upstream test is now `An onboarded visitor can redeem without bringing a prompt` ([Registration](https://github.com/okou-ai/okou/blob/4e5707de3e/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-sources-first-flow.test.tsx#L1290)). Rebuild this scenario expecting the visitor to land on `/` after redemption.
