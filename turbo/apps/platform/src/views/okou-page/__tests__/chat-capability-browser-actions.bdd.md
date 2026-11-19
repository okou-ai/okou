# Chat capability browser actions

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [chat-capability-browser-actions.test.tsx](chat-capability-browser-actions.test.tsx).

## chat-capability-browser-actions-001

Original test `Render a live managed browser card`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-capability-browser-actions.test.tsx#L375). · **intent review**

- **Given** A conversation has an active managed browser session with a live URL and an initial screenshot.
- **When** The user views the conversation’s browser card.
- **Then** The card is labeled Cloud browser and Live, opens as “Open Research browser,” and shows the initial screenshot thumbnail. The card has a 1px top border and transitions background color, border color, and transform; the Live status has a 16px line height.

## chat-capability-browser-actions-002

Original test `Browser cards show status and thumbnail changes on events and continuity gaps`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-capability-browser-actions.test.tsx#L395).

- **Given** A managed browser card is initially live with an initial screenshot; its browser-change subscription is delayed and the connection later has a continuity gap.
- **When** The browser becomes suspended with a different screenshot before subscription attaches, then a browser-change event arrives; after the connection suspends, the browser resumes with its initial screenshot and a new live URL as the connection reconnects.
- **Then** The card changes to Stopped and shows the suspended screenshot, then changes back to Live and shows the initial screenshot.

## chat-capability-browser-actions-003

Original test `A stopped browser keeps its card thumbnail and offers a start action with cloud browser panel=false`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-capability-browser-actions.test.tsx#L450).

- **Given** A conversation has a stopped managed browser with a signed screenshot URL, and the cloud-browser panel feature switch is off.
- **When** The user selects the browser card.
- **Then** The card retains a CDN-transformed screenshot thumbnail, and the panel reports that the browser is not live. An enabled Start browser action, close and new-page controls are shown, while remote browser input is disabled.

## chat-capability-browser-actions-004

Original test `A stopped browser keeps its card thumbnail and offers a start action with cloud browser panel=true`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-capability-browser-actions.test.tsx#L450).

- **Given** A conversation has a stopped managed browser with a signed screenshot URL, and the cloud-browser panel feature switch is on.
- **When** The user selects the browser card.
- **Then** The card retains a CDN-transformed screenshot thumbnail, and the panel reports that the browser is not live. An enabled Start browser action, close and new-page controls are shown, while remote browser input is disabled.

## chat-capability-browser-actions-005

Original test `Follow suspension and resumption in the live browser panel`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-capability-browser-actions.test.tsx#L513).

- **Given** A conversation has a live managed browser with an openable page at https://example.com.
- **When** The user opens the cloud-browser panel, then the browser is suspended and later resumes with a live URL.
- **Then** The panel initially shows the live page and initial screenshot. On suspension the card says Stopped, the panel says Browser not live, remote input is disabled, and Start browser is enabled; on resumption the card says Live and the page is enabled again.

## chat-capability-browser-actions-006

Original test `Keep foreign and untrusted browser URLs as ordinary links`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-capability-browser-actions.test.tsx#L569).

- **Given** An assistant message contains browser URLs for another conversation and for a lookalike untrusted host, alongside a trusted browser URL for the current conversation.
- **When** The conversation renders those links.
- **Then** The other-conversation and untrusted-host URLs remain ordinary links with their original destinations, and neither is rendered as a browser-session card.

## chat-capability-browser-actions-007

Original test `Recognize trusted assistant actions without trusting lookalikes`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-capability-browser-actions.test.tsx#L581).

- **Given** A user message contains plan, computer-authorization, and browser-input links; an assistant message contains valid plan and computer-authorization links, a malformed browser-input link, a forged lookalike-host action, and connector authorization links with wrong or missing context, plus an unavailable agent permission link.
- **When** The conversation renders these messages and the user selects Compare plans.
- **Then** Only the assistant’s trusted plan and computer actions become action cards, and Compare plans opens the Choose a plan dialog on app.okou.ai. User action-like links stay ordinary text, the forged action remains a visible link, and the five unavailable assistant actions are inert cards with no buttons or links.

## chat-capability-browser-actions-008

Original test `A Browser input card opens, reopens and completes (task context: true)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-capability-browser-actions.test.tsx#L690).

- **Given** A pending Browser input request has task context, with a companion request also present; its preflight response changes Notes from an input to a textarea and supplies a quantity field.
- **When** The user opens the request, edits Notes while preflight is pending, closes and reopens the dialog, then submits Notes as Ready.
- **Then** The dialog shows the task title and reason, preserves the Notes draft across the preflight field change, and does not navigate. A companion completion signal can show Information added without closing the dialog; reopening performs another preflight. Submission sends the callback prompt, shows Agent notified, and removes the completed request card.

## chat-capability-browser-actions-009

Original test `A Browser input card opens, reopens and completes (task context: false)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-capability-browser-actions.test.tsx#L690).

- **Given** A pending Browser input request has no task context, with a companion request also present; its preflight response changes Notes from an input to a textarea and supplies a quantity field.
- **When** The user opens the request, edits Notes while preflight is pending, closes and reopens the dialog, then submits Notes as Ready.
- **Then** The dialog is titled “Enter information in browser” and has no task description, while preserving the Notes draft across the preflight field change; it does not navigate. A companion completion signal can show Information added without closing the dialog; reopening performs another preflight. Submission sends the callback prompt, shows Agent notified, and removes the completed request card.

## chat-capability-browser-actions-010

Original test `Closing an inline form clears password and code drafts while preserving ordinary text`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-capability-browser-actions.test.tsx#L877).

- **Given** A pending inline form has email, password, and verification-code fields.
- **When** The user enters an email, password, and code, views the filling instructions, closes the dialog, and reopens it.
- **Then** The email is retained, but the password and verification code are cleared. The form uses autocomplete off for the form, email, and password, and one-time-code autocomplete for the code; the location remains unchanged.

## chat-capability-browser-actions-011

Original test `Shared inline forms retain sensitive drafts until their final owner closes`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-capability-browser-actions.test.tsx#L940).

- **Given** Two transcript cards refer to the same pending Browser input request.
- **When** The user opens both forms, enters an email, password, and verification code in the first, then closes the second and finally the first before reopening.
- **Then** The second form shares the sensitive drafts, and closing it leaves them in the first form. Closing the final form clears password and code drafts while retaining the email for reopening.

## chat-capability-browser-actions-012

Original test `An inline native datetime-local picker keeps a wall-clock string through callback`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-capability-browser-actions.test.tsx#L1027).

- **Given** A pending inline form contains a required datetime-local appointment field bounded from September 1 through September 30, 2026, with a 60-second step.
- **When** The user enters 2026-09-25T09:30 and submits the form.
- **Then** The exact wall-clock string is sent as the appointment value, the callback prompt is sent, and the chat reports Agent notified.

## chat-capability-browser-actions-013

Original test `An inline Browser input dialog confirms a required native checkbox`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-capability-browser-actions.test.tsx#L1099).

- **Given** A pending inline form contains a required consent checkbox that preflight reports as checked, although it is not site-required.
- **When** The user confirms the form without changing the checkbox.
- **Then** The checkbox is checked, submission is enabled, and the observed checked value is submitted as consent. The callback is sent, Agent notified appears, and the page URL does not change.

## chat-capability-browser-actions-014

Original test `An inline Browser slider confirms the observed website position without navigation`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-capability-browser-actions.test.tsx#L1171).

- **Given** A pending inline form contains a required Level slider whose website-observed value is 19, with minimum 10, maximum 20, and step any; the field is not site-required.
- **When** The user confirms the current value and submits.
- **Then** Submission is initially disabled and becomes enabled after confirmation. The observed value and range attributes are submitted with value 19, the callback is sent, Agent notified appears, and the page URL does not change.

## chat-capability-browser-actions-015

Original test `An inline Browser color picker confirms the observed website selection without navigation`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-capability-browser-actions.test.tsx#L1258).

- **Given** A pending inline form contains a required Swatch color picker with website-observed color #123abc; the field is not site-required.
- **When** The user confirms the current color and submits.
- **Then** Submission is initially disabled and becomes enabled after confirmation. The observed color and value #123abc are submitted, the callback is sent, Agent notified appears, and the page URL does not change.

## chat-capability-browser-actions-016

Original test `An inline Browser file picker binds local bytes only after confirmation`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-capability-browser-actions.test.tsx#L1336).

- **Given** A pending inline form contains a required Document file field accepting .txt files, with an observed empty file list and fingerprint.
- **When** The user selects a four-byte note.txt file and confirms by submitting.
- **Then** Selecting the file alone does not upload it. Submission prepares an upload for the four-byte file, uploads its bytes without credentials, and applies a replacement containing the observed fingerprint and file metadata; the callback is sent, Agent notified appears, and the page URL does not change.

## chat-capability-browser-actions-017

Original test `An inline Browser dialog confirms an existing radio choice and preserves the chat callback`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-capability-browser-actions.test.tsx#L1463).

- **Given** A pending inline form contains a required Delivery radio group whose website-observed Standard option is already selected and whose field is not site-required.
- **When** The user submits without changing the radio choice.
- **Then** Submission preserves member index 0, the observed selected index 0, and the group fingerprint. The callback is sent, Agent notified appears, and the page URL does not change.

## chat-capability-browser-actions-018

Original test `A pending transcript card becomes consumed when the standalone form completes`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-capability-browser-actions.test.tsx#L1553).

- **Given** A transcript card represents a pending Browser input request and subscribes to request changes.
- **When** The request changes to succeeded with callback delivery accepted.
- **Then** The chat reports Agent notified and removes the Enter information card.

## chat-capability-browser-actions-019

Original test `An inline dialog reconciles a lost apply response from a thread change signal`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-capability-browser-actions.test.tsx#L1582).

- **Given** An inline Browser input dialog is open with entered account details, and the apply request fails after the server-side request becomes succeeded.
- **When** A thread-change signal arrives after the failed apply response.
- **Then** The dialog closes, the chat reports Information added, and the Enter information card is removed.

## chat-capability-browser-actions-020

Original test `An inline dialog reconciles a lost cancel response from a thread change signal`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-capability-browser-actions.test.tsx#L1582).

- **Given** An inline Browser input dialog is open with entered account details, and the cancel request fails after the server-side request becomes cancelled.
- **When** A thread-change signal arrives after the failed cancel response.
- **Then** The dialog closes, the chat reports Request cancelled, and the Enter information card is removed.

## chat-capability-browser-actions-021

Original test `Duplicate initially applying cards recover after a thread change signal`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-capability-browser-actions.test.tsx#L1642).

- **Given** Two transcript cards refer to the same Browser input request, initially in the applying state.
- **When** A thread-change signal arrives after the request becomes uncertain.
- **Then** Both cards change from Checking browser status to Check the browser.

## chat-capability-browser-actions-022

Original test `Leaving an open dialog clears the Password draft`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-capability-browser-actions.test.tsx#L1672).

- **Given** The user has opened a Browser input dialog from the capability conversation and entered a password draft.
- **When** The user navigates back to the connectors page, then returns to the conversation and reopens the dialog.
- **Then** The dialog closes on leaving the conversation and the password is absent from the page; reopening shows an empty password field.

## chat-capability-browser-actions-023

Original test `Leaving an open dialog clears the Verification code draft`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-capability-browser-actions.test.tsx#L1672).

- **Given** The user has opened a Browser input dialog from the capability conversation and entered a verification-code draft.
- **When** The user navigates back to the connectors page, then returns to the conversation and reopens the dialog.
- **Then** The dialog closes on leaving the conversation and the verification code is absent from the page; reopening shows an empty password and verification-code field.

## chat-capability-browser-actions-024

Original test `A freshly mounted transcript card reads accepted Browser callback delivery`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-capability-browser-actions.test.tsx#L1734).

- **Given** A freshly mounted transcript card reports a succeeded Browser input request with callback delivery accepted.
- **When** The conversation loads.
- **Then** The chat reports Agent notified and does not show an Enter information card.

## chat-capability-browser-actions-025

Original test `Absolute and relative Browser input URLs both render dialog cards`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-capability-browser-actions.test.tsx#L1757).

- **Given** A conversation contains pending Browser input links using both absolute and relative URLs for the current request.
- **When** The conversation renders and the user opens one card.
- **Then** Both URLs render as Enter information buttons rather than links, and opening a card shows the dialog with the account email field.

## chat-capability-browser-actions-026

Original test `Keep unavailable and foreign Browser actions inert without hiding the ordinary Browser card`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-capability-browser-actions.test.tsx#L1799).

- **Given** A conversation contains an unavailable Browser input action, a Browser input action for another conversation, and a stopped managed browser card for the current conversation.
- **When** The conversation loads and the user opens the ordinary browser card.
- **Then** The unavailable and foreign actions are inert, showing Request unavailable and Action unavailable without an Enter information link. The ordinary Research browser card remains available and opens the cloud-browser panel.
