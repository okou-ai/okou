# Onboarding output formats

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [onboarding-output-formats.test.tsx](onboarding-output-formats.test.tsx).

## onboarding-output-formats-001

Original test `format choices leave the task unchanged and only the final choice reaches the first chat`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-output-formats.test.tsx#L60).

- **Given** A user is on the first-task page with its default task text.
- **When** They select Image, Website, Document, Research brief, People shortlist, and Presentation in turn, then select Presentation again and start the task.
- **Then** Each format selection leaves the task text unchanged and marks that format selected. The first chat receives the original task followed by exactly two newlines and the Presentation instructions, with no duplicate instruction.

## onboarding-output-formats-002

Original test `switching and clearing formats preserve task edits and clearing submits only the task`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-output-formats.test.tsx#L93).

- **Given** A user enters a task, selects Presentation, and edits the task to add a focus on the spring campaign.
- **When** They switch to Document, clear the format selection, and start the task.
- **Then** Switching and clearing preserve the edited task. Clearing unselects Document, and the first chat receives only the edited task.

## onboarding-output-formats-003

Original test `replacing the task preserves the selected format until submission`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-output-formats.test.tsx#L126).

- **Given** A user selects Presentation on the first-task page.
- **When** They replace the task with “Draft a customer update.” and start it.
- **Then** Presentation remains selected after the replacement, and the first chat receives the replacement task followed by exactly two newlines and the Presentation instructions.

## onboarding-output-formats-004

Original test `format choices respect the prompt length limit without truncating the task`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-output-formats.test.tsx#L149).

- **Given** A user is on the first-task page with an empty task.
- **When** They enter 1,000 characters, then clear the task and enter a shorter task.
- **Then** With 1,000 characters, Presentation is disabled, a status says “Shorten your task to choose another format.”, the task is not truncated, and starting the task remains enabled. After entering the shorter task, Presentation is enabled.

## onboarding-output-formats-005

Original test `the selected format reserves space within the saved prompt limit`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-output-formats.test.tsx#L176).

- **Given** A user selects Document on the first-task page.
- **When** They enter the maximum task length that leaves room for two newlines and the full Document instructions, then start the task.
- **Then** The saved task limit is 1,000 minus two characters and the Document instruction length. The first chat receives the full task followed by two newlines and the Document instructions, for a total prompt length of exactly 1,000 characters.

## onboarding-output-formats-006

Original test `a reload preserves the task and separate format selection without duplicating instructions`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-output-formats.test.tsx#L203).

- **Given** A user enters a task, selects Presentation, and reloads the first-task page.
- **When** They switch the restored selection to Document and start the task.
- **Then** The reload preserves the task and separate Presentation selection without adding instructions to the task text. Switching to Document preserves the task, and the first chat receives the task followed by exactly two newlines and the Document instructions.

## onboarding-output-formats-007

Original test `a saved report draft preserves custom instructions and requests a document artifact`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-output-formats.test.tsx#L239).

- **Given** A saved report draft contains the task plus custom instructions to present the findings as a structured report and include a risk register.
- **When** The user opens the first-task page and starts the task.
- **Then** The task field shows only the base task, Document is selected, and the first chat receives the custom instructions followed by exactly two newlines and the Document artifact instructions.
