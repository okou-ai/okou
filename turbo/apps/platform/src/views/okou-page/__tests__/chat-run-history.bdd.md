# Chat run history

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [chat-run-history.test.tsx](chat-run-history.test.tsx).

## chat-run-history-001

Original test `Summarize completed work by conversation phase`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-run-history.test.tsx#L213).

- **Given** The conversation has two completed phases. Phase one has two user prompts and two intermediate work messages; phase two has one intermediate work message.
- **When** The conversation is displayed with its history collapsed.
- **Then** The two phase-one answers each show “Worked for 1 min,” and a “Worked for 2 min” summary is visible. Both phase-one answers and the phase-two answer are visible, while the intermediate work messages are hidden; three collapsed history controls are present.

## chat-run-history-002

Original test `Expand the first completed conversation phase`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-run-history.test.tsx#L231).

- **Given** The conversation has two completed phases, with intermediate work messages hidden by collapsed history.
- **When** The user expands the history for the first phase’s first answer.
- **Then** “Collected requirements” becomes visible in order between “Plan phase one” and “Phase one outline.” The later phase-one work message and phase-two work message remain hidden.

## chat-run-history-003

Original test `Project an active run with one output message`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-run-history.test.tsx#L266).

- **Given** An active run has one assistant output message and is still waiting for more output.
- **When** The conversation is displayed.
- **Then** The output is visible alongside the thinking indicator and one working-status label. No expandable work-history control is shown.

## chat-run-history-004

Original test `Project an active run with multiple output messages`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-run-history.test.tsx#L266).

- **Given** An active run has five assistant output messages and is still waiting for more output.
- **When** The conversation is displayed and the user expands its work history.
- **Then** The fifth output is the visible main result, with the thinking indicator and one working-status label. The earlier four outputs are initially hidden; after expansion they appear in order within the same assistant response.

## chat-run-history-005

Original test `Render the Worked for 30 sec work duration`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-run-history.test.tsx#L342).

- **Given** A completed run lasted 30 seconds and has two output messages.
- **When** The conversation is displayed.
- **Then** The work summary says “Worked for 30 sec” and “1 step.”

## chat-run-history-006

Original test `Render the Worked for 1 min work duration`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-run-history.test.tsx#L342).

- **Given** A completed run lasted 60 seconds and has two output messages.
- **When** The conversation is displayed.
- **Then** The work summary says “Worked for 1 min” and “1 step.”

## chat-run-history-007

Original test `Render the Worked for 1 hr work duration`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-run-history.test.tsx#L342).

- **Given** A completed run lasted one hour and has two output messages.
- **When** The conversation is displayed.
- **Then** The work summary says “Worked for 1 hr” and “1 step.”

## chat-run-history-008

Original test `Render the Worked for 1 hr 29 min work duration`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-run-history.test.tsx#L342).

- **Given** A completed run lasted 1 hour and 29 minutes and has two output messages.
- **When** The conversation is displayed.
- **Then** The work summary says “Worked for 1 hr 29 min” and “1 step.”

## chat-run-history-009

Original test `Render the Working for 1 hr 29 min work duration`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-run-history.test.tsx#L342).

- **Given** An active run has been in progress for 1 hour and 29 minutes and has two output messages.
- **When** The conversation is displayed.
- **Then** The work summary says “Working for 1 hr 29 min” and “1 step.”

## chat-run-history-010

Original test `Exclude initial queue wait from active and completed work for input.prompt`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-run-history.test.tsx#L400).

- **Given** A prompt is queued for 1 hour and 40 seconds before delivery. The active run has about 1 hour 12 minutes of work elapsed, and an earlier completed run lasted about 1 hour 24 minutes.
- **When** The queued prompt is delivered and the conversation is displayed, then the active run completes.
- **Then** The active run shows “Working for 1 hr 12 min,” excluding its initial queue wait, and the earlier run shows “Worked for 1 hr 24 min.” After completion, the active run shows “Worked for 1 hr 12 min”; the earlier duration remains unchanged.

## chat-run-history-011

Original test `Exclude initial queue wait from active and completed work for input.automation`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-run-history.test.tsx#L400).

- **Given** An automation input is queued for 1 hour and 40 seconds before delivery. The active run has about 1 hour 12 minutes of work elapsed, and an earlier completed run lasted about 1 hour 24 minutes.
- **When** The queued automation is delivered and the conversation is displayed, then the active run completes.
- **Then** The active run shows “Working for 1 hr 12 min,” excluding its initial queue wait, and the earlier run shows “Worked for 1 hr 24 min.” After completion, the active run shows “Worked for 1 hr 12 min”; the earlier duration remains unchanged.

## chat-run-history-012

Original test `Do not create history before the first output.message`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-run-history.test.tsx#L508).

- **Given** An active run has a user prompt but no assistant output yet.
- **When** The conversation is displayed while the run is waiting for output.
- **Then** The thinking indicator is visible, but there is no working-status label or work-history control.

## chat-run-history-013

Original test `Count one output.message once when Markdown renders multiple child blocks`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-run-history.test.tsx#L533).

- **Given** An active run has one assistant output containing text, an image, a PDF link, and a plan-upgrade card.
- **When** The conversation is displayed.
- **Then** All output content is visible, but the single output does not create an expandable history control. One working-status label and one agent-profile link are present.

## chat-run-history-014

Original test `With Agent name on replies, a reply opens with its agent's name, linked to the agent's profile`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-run-history.test.tsx#L576).

- **Given** A completed reply is displayed with the agent-name-on-replies feature enabled.
- **When** The conversation is displayed.
- **Then** The reply opens with the linked agent name “Run Agent,” linking to that agent’s profile. No separate agent-profile link is shown.

## chat-run-history-015

Original test `Project a completed run with multiple output messages`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-run-history.test.tsx#L621).

- **Given** A completed run has five assistant output messages.
- **When** The conversation is displayed with its history collapsed.
- **Then** The fifth output is visible, the thinking indicator is absent, and one completed-work status and one collapsed history control are shown. The earlier four outputs are hidden.

## chat-run-history-016

Original test `Use the last output.message as the main result when it renders an action card`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-run-history.test.tsx#L664).

- **Given** An active run has an earlier text output and a later output that renders a plan-comparison action card.
- **When** The conversation is displayed while the run is still in progress.
- **Then** The action card is the visible main result alongside the thinking indicator. The earlier output is hidden, with one agent-profile link and one expandable history control.

## chat-run-history-017

Original test `Keep result actions visible alongside running progress`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-run-history.test.tsx#L712).

- **Given** An active run has produced an assistant result but has not completed.
- **When** The conversation is displayed.
- **Then** The result and thinking indicator are visible together, as are the result actions.

## chat-run-history-018

Original test `Do not render result actions while waiting for assistant output`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-run-history.test.tsx#L744).

- **Given** An active run has a user prompt but no assistant output yet.
- **When** The conversation is displayed while the run is waiting for output.
- **Then** The thinking indicator is visible, but result actions are absent.

## chat-run-history-019

Original test `Render result actions after a run completes`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-run-history.test.tsx#L769).

- **Given** A run has a completed assistant result.
- **When** The conversation is displayed after completion.
- **Then** The thinking indicator is absent, and result actions appear after the result within the main result area.

## chat-run-history-020

Original test `Keep interleaved run updates with their own turns`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-run-history.test.tsx#L818).

- **Given** Two requests are interleaved: request A is followed by request B, then B’s answer and A’s later answer; both runs complete.
- **When** The conversation is displayed.
- **Then** Each answer remains with its own request: request A precedes “A late final answer,” followed by request B and “B final answer.”

## chat-run-history-021

Original test `Keep run-budget instructions out of the transcript`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-run-history.test.tsx#L862).

- **Given** A conversation includes a user request, a run-budget instruction saying “You have 12 minutes left in this run,” and a completed assistant answer.
- **When** The conversation is displayed.
- **Then** The user request and assistant answer are visible, but the budget instruction is absent.

## chat-run-history-022

Original test `Keep usage-only activity out of the conversation`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-run-history.test.tsx#L908).

- **Given** The conversation contains only a zero-credit usage event and no chat messages.
- **When** The conversation is displayed.
- **Then** No credit-usage content is shown, the Stop control is absent, and the Send control is visible.

## chat-run-history-023

Original test `Preserve user text that resembles HTML`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-run-history.test.tsx#L928).

- **Given** A user submits the literal text “<span> 123 </span>” and receives an assistant answer.
- **When** The conversation is displayed.
- **Then** The submitted text is visible literally, including its angle brackets and spaces.

## chat-run-history-024

Original test `Replace a stale assistant answer with its correction`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-run-history.test.tsx#L955).

- **Given** A conversation has an assistant answer that is later revoked by a corrected answer.
- **When** The conversation is displayed after the correction.
- **Then** “Revised launch plan” is visible and “Obsolete launch plan” is absent.

### Batch 41 disposition

The Router cases for 002, 003, 010, 012, 015, 018, 021, 022 and 023 are accepted. The frozen scenarios above remain available while the three profile-link clauses are open.

- **013.** The active rich output displayed its text, image, PDF and upgrade card with one work label and no history toggle. Its transcript had zero agent-profile links after those results appeared.
- **014.** With the reply-name switch enabled, the completed answer displayed “Okou” as unlinked workspace text. The frozen “Run Agent” profile link was unavailable. The updated workspace-name registration keeps its existing upstream owner.
- **016.** The running turn displayed its final upgrade card, thinking and a history toggle, with its earlier text hidden. Its transcript had zero agent-profile links.

The implementation and upstream dispositions are recorded in [batch 41 evidence](../../../../test-rebuild-rework-checkpoint.md#batch-41-evidence). The independently mapped upstream working-dots scenario keeps its original ID.
