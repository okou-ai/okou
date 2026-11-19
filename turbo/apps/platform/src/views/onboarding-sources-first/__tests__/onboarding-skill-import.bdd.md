# Onboarding skill import

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [onboarding-skill-import.test.tsx](onboarding-skill-import.test.tsx).

## onboarding-skill-import-001

Original test `Mobile import copies the session prompt and continues when a skill arrives`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-skill-import.test.tsx#L288).

- **Given** A user is on the mobile Codex skills-import step and an import session has opened.
- **When** They copy the import prompt, then a skill arrives and they continue.
- **Then** The copied prompt contains the session token, the step shows that skills have arrived, and Continue leads to the chat-app choice.

## onboarding-skill-import-002

Original test `The skills step requires a selected tool`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-skill-import.test.tsx#L313).

- **Given** A user opens the skills step directly without choosing a tool.
- **When** The step loads.
- **Then** They are returned to the tool-choice question at the onboarding experience route.

## onboarding-skill-import-003

Original test `Refreshing the skills step restores the chosen tool`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-skill-import.test.tsx#L333).

- **Given** A user refreshes the skills step with a saved draft for the same account that selected Claude Code.
- **When** The step loads from the saved draft.
- **Then** The skills step remains open and identifies Claude Code as the tool for running the prompt.

## onboarding-skill-import-004

Original test `A saved draft from another user cannot select the current user's tool`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-skill-import.test.tsx#L371).

- **Given** The browser contains a saved draft from another user that selected Claude Code.
- **When** The current user opens the tool-choice step.
- **Then** No tool is selected and Continue is disabled.

## onboarding-skill-import-005

Original test `The step hands over the prompt its session produced, and copies it whole`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-skill-import.test.tsx#L409).

- **Given** A user chooses Codex and reaches the skills step with an import session.
- **When** They view and copy the prompt.
- **Then** The prompt includes its opening instruction, session token, upload destination, and Codex skill locations, but not the Claude skill location. The guide explains how to run it in a new Codex chat, the clipboard receives the entire prompt, and onboarding telemetry does not include the token.

## onboarding-skill-import-006

Original test `The skills step names Claude Code when it was selected`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-skill-import.test.tsx#L464).

- **Given** A user chooses Claude Code and reaches the skills step with an import session.
- **When** They view the import instructions.
- **Then** The step identifies Claude Code, guides them to the Claude app's Code tab and a Local session, and the prompt refers to Claude skill locations rather than Codex locations.

## onboarding-skill-import-007

Original test `Finishing onboarding sends the industry after a full Codex flow`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-skill-import.test.tsx#L490).

- **Given** A user begins onboarding, chooses Marketing & content, connects a work tool, and skips skills, Slack, and the optional additional-ways step.
- **When** They start their first task to finish onboarding.
- **Then** The onboarding completion request includes the industry value marketing.

## onboarding-skill-import-008

Original test `A resumed skills step without a work positioning continues to Slack`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-skill-import.test.tsx#L517).

- **Given** A user resumes onboarding at the skills step without a work-positioning answer.
- **When** They choose Not now.
- **Then** They continue to the Slack question at the Slack onboarding route.

## onboarding-skill-import-009

Original test `A skill the import writes appears without the step being asked again`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-skill-import.test.tsx#L529).

- **Given** A user reaches the skills step from the start of onboarding, where no skills have arrived yet.
- **When** An imported skill appears on the default agent along with a skill belonging to a different agent.
- **Then** The default-agent skill appears and the waiting message disappears; the other agent's skill is not shown. Continuing leads to the Slack question, and telemetry excludes both skill names.

## onboarding-skill-import-010

Original test `The step can be left with nothing imported`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-skill-import.test.tsx#L562).

- **Given** A user reaches the skills step and no imported skills are available.
- **When** They choose Not now.
- **Then** They continue to the Slack question at the Slack onboarding route, and onboarding records a skip for the skills step.

## onboarding-skill-import-011

Original test `Back releases the subscription and returning retains the prompt and server results`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-skill-import.test.tsx#L583).

- **Given** A user reaches the skills step, where the prompt is displayed, and a server-side import result arrives.
- **When** They go Back and then return to the skills step.
- **Then** The import-change subscription is released while they are away; on return, the server result and the original prompt are still displayed.

## onboarding-skill-import-012

Original test `A session that cannot be opened leaves the step passable`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-skill-import.test.tsx#L606).

- **Given** A user reaches the skills step, but no default agent exists to open an import session.
- **When** The session cannot be opened.
- **Then** An import-session error is shown, Not now remains enabled, and Continue is disabled.
