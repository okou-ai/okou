# workflow-execution-distribution

## workflow-execution-distribution-001

- Vitest: "pins complete claude-code Workflow bundles at dispatch, including Workflows added while queued"
- Mode: run
- Given: A signed-in workspace admin with Pro entitlement and a personal subscription model uses the `claude-code` runtime, has saved personal Instructions, and owns a Workflow with a `reference.md` attachment; a Runner group is configured. A chat input is queued behind an executing Run, and while it waits the member updates the Workflow (new body, new `reference.md`, added `资料/说明.md`) and creates a second Workflow.
- When: The blocking Run finishes so the queued input launches, the Runner heartbeats and receives the execution; afterwards the member edits the Workflow again via `PATCH /api/workflows/:workflowId`, the sandbox completes the Run via `POST /api/webhooks/run/complete`, and the member sends a new Thread run via `POST /api/chat/events`.
- Then: The execution uses agent type `claude-code` and launching publishes no new `bundles/v1/` storage object. The Workflow mounts at `/home/user/.claude/skills/<name>` with a reference holding exactly `archiveBytes`, `downloadUrl`, `mountPath` and `sha256`; its bundle has the updated body, `reference.md` = "new attachment" and `资料/说明.md` = "附件内容", the Instructions bundle has the dispatch-time Instructions, and the second Workflow is mounted with its body. The later edit leaves the pinned bundle unchanged, while the next Run gets a different SHA-256 bundle with "later body", "later attachment" and no `资料/说明.md`.

## workflow-execution-distribution-002

- Vitest: "pins complete codex Workflow bundles at dispatch, including Workflows added while queued"
- Mode: run
- Given: A signed-in workspace admin with Pro entitlement uses the `codex` runtime (subscription Pi model configured and Codex execution switch on), has saved personal Instructions, and owns a Workflow with a `reference.md` attachment; a Runner group is configured. A chat input is queued behind an executing Run, and while it waits the member updates the Workflow (new body, new `reference.md`, added `资料/说明.md`) and creates a second Workflow.
- When: The blocking Run finishes so the queued input launches, the Runner heartbeats and receives the execution; afterwards the member edits the Workflow again via `PATCH /api/workflows/:workflowId`, the sandbox completes the Run via `POST /api/webhooks/run/complete`, and the member sends a new Thread run via `POST /api/chat/events`.
- Then: The execution uses agent type `codex` and launching publishes no new `bundles/v1/` storage object. The Workflow mounts at `/home/user/.codex/skills/<name>` with a reference holding exactly `archiveBytes`, `downloadUrl`, `mountPath` and `sha256`; its bundle has the updated body, `reference.md` = "new attachment" and `资料/说明.md` = "附件内容", the Instructions bundle has the dispatch-time Instructions, and the second Workflow is mounted with its body. The later edit leaves the pinned bundle unchanged, while the next Run gets a different SHA-256 bundle with "later body", "later attachment" and no `资料/说明.md`.

## workflow-execution-distribution-003

- Vitest: "pins complete pi Workflow bundles at dispatch, including Workflows added while queued"
- Mode: run
- Given: A signed-in workspace admin with Pro entitlement uses the `pi` runtime (subscription Pi model configured and Codex execution switch off), has saved personal Instructions, and owns a Workflow with a `reference.md` attachment; a Runner group is configured. A chat input is queued behind an executing Run, and while it waits the member updates the Workflow (new body, new `reference.md`, added `资料/说明.md`) and creates a second Workflow.
- When: The blocking Run finishes so the queued input launches, the Runner heartbeats and receives the execution; afterwards the member edits the Workflow again via `PATCH /api/workflows/:workflowId`, the sandbox completes the Run via `POST /api/webhooks/run/complete`, and the member sends a new Thread run via `POST /api/chat/events`.
- Then: The execution uses agent type `pi` and launching publishes no new `bundles/v1/` storage object. The Workflow mounts at `/home/user/.pi/agent/skills/<name>` with a reference holding exactly `archiveBytes`, `downloadUrl`, `mountPath` and `sha256`; its bundle has the updated body, `reference.md` = "new attachment" and `资料/说明.md` = "附件内容", the Instructions bundle has the dispatch-time Instructions, and the second Workflow is mounted with its body. The later edit leaves the pinned bundle unchanged, while the next Run gets a different SHA-256 bundle with "later body", "later attachment" and no `资料/说明.md`.

## workflow-execution-distribution-004

- Vitest: "shares a complete package hash across distinct Workflow owners"
- Mode: run
- Given: A workspace admin and a workspace member, both onboarded with a personal subscription model, each create a Workflow with the same name, instruction and `notes.md` attachment; a Runner group is available.
- When: Each member sends a Thread run via `POST /api/chat/events`, the Runner receives each execution, and each Run completes.
- Then: Each Run's Workflow bundle contains `notes.md` = "Identical attachment", and both bundle references have the same `sha256` and `archiveBytes`.

## workflow-execution-distribution-005

- Vitest: "re-evaluates private/public precedence without exposing another member's private Workflow"
- Mode: run
- Given: A signed-in workspace admin owns a public Workflow named X ("public body"), and another workspace member owns a private Workflow with a different name. The admin's chat input is queued behind an executing Run, and while it waits the admin creates a private Workflow also named X ("private body").
- When: The queued input launches and the Runner heartbeats and receives the execution.
- Then: The mounted skills are exactly the admin's private Workflow X followed by the built-in skills, so neither the public X nor the other member's private Workflow is mounted. The X bundle contains "private body".

## workflow-execution-distribution-006

- Vitest: "keeps the accepted Workflow after sharing withdrawal during startup"
- Mode: run
- Given: A signed-in workspace admin with a personal subscription model is ready to run, and another workspace member authors a public Workflow. Download-URL signing is held so the member's Run pauses during startup.
- When: The member sends a prompt via `POST /api/chat/events` (HTTP 201); during startup the author withdraws sharing via `POST /api/workflows/:workflowId/demote` (HTTP 200); signing is then released. After that Run completes, the member sends another prompt to the same Thread.
- Then: The admitted Run's execution still mounts the Workflow under its original name with its original content. The next Run on the Thread does not mount that Workflow.

## workflow-execution-distribution-007

- Vitest: "keeps the accepted Workflow after rename during startup"
- Mode: run
- Given: A signed-in workspace member has saved personal Instructions "Accepted personal Instructions", and another workspace member authors a public Workflow. Download-URL signing is held so the member's Run pauses during startup.
- When: The member sends a prompt via `POST /api/chat/events` (HTTP 201); during startup the author renames the Workflow with new instructions via `PATCH /api/workflows/:workflowId` (HTTP 200) and the member saves new Instructions via `PUT /api/instructions`; signing is then released. After that Run completes, the member sends another prompt to the same Thread.
- Then: The admitted Run mounts the Workflow under its original name with its original content and carries the "Accepted personal Instructions" bundle. The next Run does not mount the original name; it carries "Updated personal Instructions" and mounts the renamed Workflow containing "Updated Workflow instructions".

## workflow-execution-distribution-008

- Vitest: "keeps the accepted Workflow after deletion during startup"
- Mode: run
- Given: Row `deletion`. A signed-in Pro workspace admin with a personal subscription model is ready to run, and another member of the same workspace authors a public Workflow. Download-URL signing is held so the admin's Run pauses during startup.
- When: The admin sends a prompt via `POST /api/chat/events` (HTTP 201); during startup the author deletes the Workflow via `DELETE /api/workflows/:workflowId` (HTTP 204); signing is then released. After the Runner reports that Run finished, the admin sends another prompt to the same Thread.
- Then: The admitted Run's execution input still mounts the Workflow under its original name, and its `SKILL.md` contains the original content. The next Run's execution input on the Thread does not mount that Workflow.

## workflow-execution-distribution-009

- Vitest: "invokes the caller's Private Workflow when Public and foreign Private Workflows share its slug"
- Mode: run
- Given: A signed-in workspace admin owns a public Workflow named X ("public body") and a private Workflow named X ("private body"), and another workspace member owns a private Workflow also named X ("foreign private body").
- When: The admin sends a Thread run with prompt `/X summarize today` via `POST /api/chat/events` and the Runner receives the execution.
- Then: The mounted X bundle's `SKILL.md` contains "private body".

## workflow-execution-distribution-010

- Vitest: "an ordinary Automation invokes the name of its bound Workflow package"
- Mode: run
- Given: Another workspace member authors a public Workflow S ("Shared Automation workflow"), and the signed-in member owns a private Workflow with the same name. The member creates an Automation for S with a 3600-second loop schedule via `POST /api/workflows/:workflowId/automations` (HTTP 201).
- When: The member triggers `POST /api/workflow-automations/:id/run`, renames their private Workflow and triggers again, then triggers a third time while the author renames S with new instructions and the running Run completes.
- Then: The first trigger's Thread records `input.rejected` with error `conflict` and `output.error` "The Automation's Workflow package is unavailable". After the private rename, triggers return the same Thread and the Run mounts `/home/user/.claude/skills/<S>` with the shared content. The queued third Run is a different Run whose prompt starts with `/<renamed>` and which mounts `/home/user/.claude/skills/<renamed>` containing "Renamed Automation Workflow".

## workflow-execution-distribution-011

- Vitest: "runs a queued explicit invocation without its deleted Workflow"
- Mode: run
- Given: A signed-in workspace admin owns a Workflow, and a chat input invoking `/<name>` is queued behind an executing Run.
- When: While the input is queued the admin deletes the Workflow via `DELETE /api/workflows/:workflowId` (HTTP 204); then the queued input launches and the Runner receives the execution.
- Then: The Run starts and its mounted skills are exactly the built-in skills.

## workflow-execution-distribution-012

- Vitest: "mounts the current winner for a queued invocation whose slug is reused"
- Mode: run
- Given: A signed-in workspace admin owns Workflow W, and a chat input invoking `/W` is queued behind an executing Run.
- When: While queued, the admin renames W to `W-renamed` via `PATCH /api/workflows/:workflowId` and creates a new Workflow named W ("different invocation target"); then the queued input launches and the Runner receives the execution.
- Then: The mount ending in `/W` contains "different invocation target", and the skills also include a mount ending in `/W-renamed`.

## workflow-execution-distribution-013

- Vitest: "keeps a large non-ASCII Workflow in its complete package without truncation"
- Mode: run
- Given: A signed-in workspace admin owns a Workflow whose instruction is "指令\n" repeated 800,000 times.
- When: The admin sends a Thread run via `POST /api/chat/events` and the Runner receives the execution.
- Then: The Workflow's mount reference serializes to under 2,048 bytes, and its bundled `SKILL.md` ends with the full trimmed instruction plus a newline and exceeds 4.5 MiB.

## workflow-execution-distribution-014

- Vitest: "preserves a running Agent after rejected completion and accepts cancellation acknowledgement"
- Mode: run
- Given: A signed-in workspace admin owns a Workflow with a `keep.md` attachment, and a Thread Run is executing on a Runner. The admin then removes all Workflow files via `PATCH /api/workflows/:workflowId`.
- When: The sandbox posts a successful completion to `POST /api/webhooks/run/complete` that reports an unclaimed storage output `/unclaimed-output`; the member then cancels via `POST /api/runs/:id/cancel`, and the sandbox posts a failed completion.
- Then: The successful completion is rejected with HTTP 400 and the Run still reads as `running`. Cancellation returns HTTP 200, the failed completion returns HTTP 200, and the Run then reads as `cancelled`.
