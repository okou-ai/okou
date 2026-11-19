# Agents management

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [agents-management.test.tsx](agents-management.test.tsx).

## agents-management-001

Original test `Pressing Enter defaults to a private agent from Private with 1 public agents`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/agents-page/__tests__/agents-management.test.tsx#L309).

- **Given** The agent list has one public agent, and the Private list is selected.
- **When** I open agent creation, enter a responsibility and a name with surrounding spaces, then press Enter.
- **Then** A single private agent named “Private Analyst” is created. The dialog closes, the Private list shows the new agent, and switching to Public does not show it.

## agents-management-002

Original test `Pressing Enter defaults to a private agent from Public with 1 public agents`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/agents-page/__tests__/agents-management.test.tsx#L309).

- **Given** The agent list has one public agent, and the Public list is selected.
- **When** I open agent creation, enter a responsibility and a name with surrounding spaces, then press Enter.
- **Then** A single private agent named “Private Analyst” is created. The dialog closes, the Private list is selected, and switching to Public does not show the new agent.

## agents-management-003

Original test `Pressing Enter defaults to a private agent from Public with 7 public agents`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/agents-page/__tests__/agents-management.test.tsx#L309).

- **Given** The agent list has seven public agents, and the Public list is selected.
- **When** I open agent creation, enter a responsibility and a name with surrounding spaces, then press Enter.
- **Then** A single private agent named “Private Analyst” is created. The dialog closes, the Private list is selected, and switching to Public does not show the new agent.

## agents-management-004

Original test `Confirming an IME candidate (composing) keeps agent creation open`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/agents-page/__tests__/agents-management.test.tsx#L358).

- **Given** Agent creation is open with a responsibility entered, and I am composing a Chinese name with an input method editor.
- **When** I confirm the candidate by pressing Enter while composition is active.
- **Then** The candidate remains in the focused name field and the creation dialog stays open. Pressing Enter again after composition ends creates one agent with that name and closes the dialog.

## agents-management-005

Original test `Confirming an IME candidate (Safari final Enter) keeps agent creation open`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/agents-page/__tests__/agents-management.test.tsx#L358).

- **Given** Agent creation is open with a responsibility entered, and I am composing a Japanese name with an input method editor in Safari.
- **When** Safari ends composition before dispatching the candidate-confirming Enter event.
- **Then** The candidate remains in the focused name field and the creation dialog stays open. Pressing Enter again creates one agent with that name and closes the dialog.

## agents-management-006

Original test `Blank Enter and cancelling a named draft do not create an agent`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/agents-page/__tests__/agents-management.test.tsx#L405).

- **Given** Agent creation is open with a responsibility entered.
- **When** I press Enter with a whitespace-only name, then enter a draft name, change visibility to Public, cancel, and reopen creation for Private.
- **Then** The blank name cannot be submitted. Cancelling creates no agent, and the reopened form has blank name and responsibility fields with Private visibility selected.

## agents-management-007

Original test `A pending create disables submission and adds only one agent card`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/agents-page/__tests__/agents-management.test.tsx#L441).

- **Given** Agent creation is open with a valid name and responsibility, and the create request is pending.
- **When** I try to submit again and click the pending submission control before the request completes.
- **Then** The name and responsibility fields, Cancel control, and submission control are disabled while pending. After completion, exactly one agent card named “Pending analyst” is present.

## agents-management-008

Original test `Create a public agent with a customized avatar`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/agents-page/__tests__/agents-management.test.tsx#L476).

- **Given** Agent creation is open and a public agent can be created.
- **When** I enter the name “Marketing Bot” and a responsibility, choose Public visibility, customize the avatar through its steps, select Blue, and create the agent.
- **Then** One public agent card named “Marketing Bot” appears with a visible avatar, and its saved avatar uses a composed avatar URL.

## agents-management-009

Original test `Creating an agent requires a multi-line responsibility`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/agents-page/__tests__/agents-management.test.tsx#L526).

- **Given** Agent creation is open and the name is filled in.
- **When** I try to submit with no responsibility, then with whitespace-only responsibility, then enter a two-line responsibility.
- **Then** The responsibility field is required and submission remains disabled for empty or whitespace-only content. Submission becomes enabled after entering both lines, and the dialog remains open.

## agents-management-010

Original test `Creating an agent pins it and sends its setup prompt in a new thread`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/agents-page/__tests__/agents-management.test.tsx#L558).

- **Given** The agent list is open and agent setup can start a new chat thread.
- **When** I create a private “Pipeline Analyst” with a responsibility containing leading, trailing, and line-break whitespace.
- **Then** The created agent is pinned as the current agent in a new chat thread. The setup request and sent prompt use the trimmed name and responsibility, preserving the line break, and a success message appears.

## agents-management-011

Original test `A failed setup request after creation leaves the Agent visible without a retryable dialog`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/agents-page/__tests__/agents-management.test.tsx#L619).

- **Given** The agent list is open, and the setup-prompt service returns a forbidden error after agent creation.
- **When** I create “Pipeline Analyst” with a responsibility.
- **Then** The agent remains visible in the list and the setup error is shown. The creation dialog closes, no success message or retryable dialog appears, and the page remains at /agents.

## agents-management-012

Original test `Open an agent's management page from its card`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/agents-page/__tests__/agents-management.test.tsx#L653).

- **Given** The agent list contains a public agent named “Marketing Bot.”
- **When** I open its card.
- **Then** Its management page displays the “Marketing Bot” heading, and the document title is “Marketing Bot | Okou”.

## agents-management-013

Original test `Review an agent's profile and instructions`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/agents-page/__tests__/agents-management.test.tsx#L670).

- **Given** The management page is open for a Research Agent with a description and saved instructions.
- **When** I view its Profile tab and then its Instructions tab.
- **Then** The profile shows the name “Research Agent” and description “Collects and verifies evidence.” The instructions display “Verify every source before writing conclusions,” and the chat link points to that agent’s chat page.

## agents-management-014

Original test `Switch between public and private agent lists`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/agents-page/__tests__/agents-management.test.tsx#L696).

- **Given** The Public list contains Research Agent, while a private agent has no display name and a confidential-operations description.
- **When** I switch from Public to Private.
- **Then** The Public list initially shows Research Agent and its market-research description, not the private agent. The Private list shows the private agent under its ID with the confidential-operations description, not Research Agent; the New agent control remains enabled.
