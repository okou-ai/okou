# run-lifecycle-runner-context.bdd

## run-lifecycle-runner-context.bdd-001

- Vitest: "RUN-01: agent runner context, queue promotion, and skills > injects agent identity, tool hints, and user info into the runner context"
- Mode: run
- Given: An onboarded Pro member on the native Runner route with timezone `America/Los_Angeles` has connected Slack with `chat:write` allowed, a manual custom HTTP connector with a secret, and a workflow `bdd-context-workflow`; the app URL is `https://app.example.test`.
- When: The member starts a chat Run and the Runner reads the execution input.
- Then: The system prompt has `# Identity` naming Okou, a 2-hour execution time limit, `# Agent Tools` with the full set of CLI, browser, hosting, connector, generation, Instructions/Memory, permission, workflow, chat-messaging, research-data and messaging hints in the expected order, no other-integration download hints, and `# Current User Info` with the user's name, email and timezone. The execution's timezone is `America/Los_Angeles`, disallowed tools are the standard set, platform variables (web integration) are kept out of the sandbox environment, Slack's firewall and policy allow `chat:write` and `conversations:read`, the custom connector has one firewall API, and the workflow is mounted under `.claude/skills`.

## run-lifecycle-runner-context.bdd-002

- Vitest: "RUN-01: agent runner context, queue promotion, and skills > advertises Outlook draft review to web chat runs"
- Mode: run
- Given: An entitled member.
- When: The member starts a chat Run asking to prepare an Outlook email and the Runner reads the execution input.
- Then: The system prompt includes the Gmail and Outlook web-chat email guidance: the `X-Okou-Connector-Intent: outlook-mail` header, `Prefer: IdType="ImmutableId"`, `okou mail link <outlook-message-id> --provider outlook`, never calling `sendMail`, and `PATCH /me/messages/<draft-id>`.

## run-lifecycle-runner-context.bdd-003

- Vitest: "RUN-01: agent runner context, queue promotion, and skills > appends the restricted explicit content policy last"
- Mode: run
- Given: An entitled member.
- When: The member starts a chat Run and the Runner reads the execution input.
- Then: The system prompt contains `# Restricted Explicit Content` listing pornography, sexualization of minors, graphic violence and self-harm instructions, applying to files, prompts, code, links or tool calls. The section appears after `# Current User Info` and the prompt ends with offering a safe, non-explicit or non-graphic alternative.

## run-lifecycle-runner-context.bdd-004

- Vitest: "RUN-01: agent runner context, queue promotion, and skills > omits all disabled managed tool guidance while retaining independent tools and content policy"
- Mode: run
- Given: An entitled member on the native Runner route has disabled every managed paid tool plus `scrape` and `social`.
- When: The member starts a chat Run and the Runner reads the execution input.
- Then: The system prompt omits web-search data tools, the built-in image model section and `--provider built-in`, but still includes managed research data, `okou generate <type>`, `okou connector search`, `okou data describe <tool>` and the restricted content policy. The framework web search flag is `true`.

## run-lifecycle-runner-context.bdd-005

- Vitest: "RUN-01: agent runner context, queue promotion, and skills > explains live tool discovery and schema-based calls to the agent"
- Mode: run
- Given: An entitled member on the native Runner route.
- When: The member starts a chat Run and the Runner reads the execution input.
- Then: The system prompt explains `okou data tools`, `okou data describe <tool>` and `okou data call <tool> --input`, notes the catalog may change independently of the CLI, and says it lists only the Data Router families and tools enabled for this Run.

## run-lifecycle-runner-context.bdd-006

- Vitest: "RUN-01: agent runner context, queue promotion, and skills > snapshots paid tool preferences for queued runs and applies later changes to new runs"
- Mode: run
- Given: An entitled member on the native Runner route disabled web search and image generation, queued a Run, then re-enabled both before it was dispatched.
- When: The Runner reads the queued Run's execution input; the member then starts a new Run, disables web search and video generation and starts another, and finally starts a Codex Run on `gpt-6-astra`.
- Then: The queued Run keeps the snapshot: no web-search data tools or built-in image model section, disabled paid tools `["image-generation","web-search"]`, framework web search `true`, no framework image flag, and none of these flags in the sandbox environment. The next Run has both sections and `[]` with no framework web search flag. The following Run has `["video-generation","web-search"]` and framework web search `true`. The Codex Run uses `codex` with framework web search `true`.

## run-lifecycle-runner-context.bdd-007

- Vitest: "RUN-01: agent runner context, queue promotion, and skills > snapshots native Codex image preferences independently from Web Search"
- Mode: run
- Given: An entitled member on the native Runner route uses native subscription models, disabled image generation, queued a `gpt-6-astra` Run, then re-enabled images and disabled web search before dispatch.
- When: The Runner reads the queued Run; the member starts another `gpt-6-astra` Run, disables image generation again, and starts a third.
- Then: The queued Codex Run has no built-in image model section, keeps web-search data tools, sets the framework image flag to `true` (not in the sandbox environment) and no framework web search flag. The second Run has the built-in image model section, no web-search data tools, no framework image flag and framework web search `true`. The third has both framework image and web search flags `true`.

## run-lifecycle-runner-context.bdd-008

- Vitest: "RUN-01: agent runner context, queue promotion, and skills > uses the executing member's paid tool preferences for a shared agent"
- Mode: run
- Given: An entitled workspace owner on the native Runner route disabled web search; a colleague in the same workspace, onboarded with a personal subscription, disabled `scrape`.
- When: The colleague starts a chat Run and the Runner reads the execution input.
- Then: The disabled paid tools are exactly `["scrape"]` and the system prompt still includes `okou data tools --family web-search`.

## run-lifecycle-runner-context.bdd-009

- Vitest: "RUN-01: agent runner context, queue promotion, and skills > advertises banking tools only while the feature is enabled"
- Mode: run
- Given: An entitled member with the Banking feature switch off.
- When: The member starts a Run about banking activity, turns the Banking switch on, and starts another.
- Then: The first system prompt does not mention `okou banking access-request`. The second includes it with the account-scoped expiring grant, the rule to use `okou banking` (not market data tools) for balances, transactions and cash flow, no generic banking-app directions, preserving the original task in the callback prompt, and running `okou banking accounts` then `okou banking balances`.

## run-lifecycle-runner-context.bdd-010

- Vitest: "RUN-01: agent runner context, queue promotion, and skills > advertises SSH guidance and grants Run scopes for an ordinary organization"
- Mode: run
- Given: An entitled member in an ordinary organization.
- When: The member starts a chat Run and the Runner reads the execution input.
- Then: The system prompt lists `okou ssh host list --json`, `ssh exec`, `ssh session`, `ssh upload`, `ssh download`, `ssh --help`, the subcommand help rule, the SSH and VNC `diagnose` and `request-access` commands, and the Run token has `ssh:read` and `ssh:write` capabilities.

## run-lifecycle-runner-context.bdd-011

- Vitest: "RUN-01: agent runner context, queue promotion, and skills > advertises VNC instructions and Run capabilities"
- Mode: run
- Given: An entitled member.
- When: The member starts a chat Run and the Runner reads the execution input.
- Then: The Run is `running`. The Run token has `vnc:read` and `vnc:write`, and the system prompt covers SSH diagnosis as passive history where unavailable evidence does not establish a cause, `okou vnc host list --json`, `vnc session start` with explicit shared/exclusive mode, `vnc screenshot` geometry for coordinate input, never replaying uncertain input, `vnc session close`, `vnc --help` and `vnc diagnose`.

## run-lifecycle-runner-context.bdd-012

- Vitest: "RUN-01: agent runner context, queue promotion, and skills > new HTML over a PPTX default: startup and active-input guidance"
- Mode: run
- Given: An entitled member in a staff organization has the presentation output-format switch on and the presentation conversion switch on (row: new HTML over a PPTX default). The message attaches the Schoolhouse presentation template with a saved `PPTX` output preference and asks for a new deck in HTML this time.
- When: The member sends the message, the Runner reads the execution input, the member sends the same message again while the Run is active, and the Runner fetches it via `GET /api/runners/runs/:runId/steerable-inputs/next`.
- Then: The execution prompt contains the request and the preference. Both the startup inline template section and the active input contain `Output format: PPTX`, `okou resource pull template:pptx-schoolhouse-runbook`, the `okou generate presentation --format <html|pptx> --template template:html-ppt-schoolhouse` command, `The replacement packet supersedes all remaining instructions here.`, and `For a new deck with resolved PPTX output, author an editable native PPTX`. The active input carries the new event ID. The Agent Tools section contains the `- Presentation output:` policy exactly once. The Run token has `presentation-convert:write` and the tools section includes `For an existing HTML deck, convert that file without regenerating it` and `okou presentation convert --input <deck.html> --out <deck.pptx> --verify`.

## run-lifecycle-runner-context.bdd-013

- Vitest: "RUN-01: agent runner context, queue promotion, and skills > new PPTX without conversion capability: startup and active-input guidance"
- Mode: run
- Given: An entitled member in a staff organization has the presentation output-format switch on and the presentation conversion switch off (row: new PPTX without conversion capability). The message attaches the Schoolhouse presentation template with a saved `HTML` output preference and asks for a new deck in PPTX this time.
- When: The member sends the message, the Runner reads the execution input, the member sends the same message again while the Run is active, and the Runner fetches it via `GET /api/runners/runs/:runId/steerable-inputs/next`.
- Then: The execution prompt contains the request and the preference. Both the startup inline template section and the active input contain `Output format: HTML`, `okou resource pull template:html-ppt-schoolhouse-runbook`, the `okou generate presentation --format <html|pptx> --template template:html-ppt-schoolhouse` command, `The replacement packet supersedes all remaining instructions here.`, and `For PPTX delivery from an HTML-only template`. The active input carries the new event ID. The Agent Tools section contains the `- Presentation output:` policy exactly once. The Run token lacks `presentation-convert:write`, and neither the system prompt nor the active input mentions `okou presentation convert`.

## run-lifecycle-runner-context.bdd-014

- Vitest: "RUN-01: agent runner context, queue promotion, and skills > legacy native package: startup and active-input guidance"
- Mode: run
- Given: An entitled member in a staff organization has the presentation output-format switch off and the presentation conversion switch on (row: legacy native package). The message attaches the Schoolhouse presentation template with a saved `PPTX` output preference and asks for a new deck in HTML this time.
- When: The member sends the message, the Runner reads the execution input, the member sends the same message again while the Run is active, and the Runner fetches it via `GET /api/runners/runs/:runId/steerable-inputs/next`.
- Then: The execution prompt contains the request and the preference. Both the startup inline template section and the active input contain `Output format: PPTX`, `okou resource pull template:pptx-schoolhouse-runbook`, the `okou generate presentation --format <html|pptx> --template template:html-ppt-schoolhouse` command, `The message wins over the selected format preference.`, and `Author an editable native PPTX directly with the selected package`. The active input carries the new event ID. The Agent Tools section has no `- Presentation output:` policy and says to deliver HTML by default and convert only on an explicit PowerPoint/PPTX request without inferring it from preferences. The Run token has `presentation-convert:write` and the tools section includes the legacy explicit-conversion line and `okou presentation convert --input <deck.html> --out <deck.pptx> --verify`.

## run-lifecycle-runner-context.bdd-015

- Vitest: "RUN-01: agent runner context, queue promotion, and skills > legacy HTML package: startup and active-input guidance"
- Mode: run
- Given: An entitled member in a staff organization has the presentation output-format switch off and the presentation conversion switch on (row: legacy HTML package). The message attaches the Schoolhouse presentation template with a saved `HTML` output preference and asks for a new deck in PPTX this time.
- When: The member sends the message, the Runner reads the execution input, the member sends the same message again while the Run is active, and the Runner fetches it via `GET /api/runners/runs/:runId/steerable-inputs/next`.
- Then: The execution prompt contains the request and the preference. Both the startup inline template section and the active input contain `Output format: HTML`, `okou resource pull template:html-ppt-schoolhouse-runbook`, the `okou generate presentation --format <html|pptx> --template template:html-ppt-schoolhouse` command, `The message wins over the selected format preference.`, and `For an explicit PowerPoint/PPTX request, follow the platform's conversion instructions`. The active input carries the new event ID. The Agent Tools section has no `- Presentation output:` policy and says to deliver HTML by default and convert only on an explicit PowerPoint/PPTX request without inferring it from preferences. The Run token has `presentation-convert:write` and the tools section includes the legacy explicit-conversion line and `okou presentation convert --input <deck.html> --out <deck.pptx> --verify`.

## run-lifecycle-runner-context.bdd-016

- Vitest: "RUN-01: agent runner context, queue promotion, and skills > existing HTML conversion with a native …: startup and active-input guidance"
- Mode: run
- Given: An entitled member in a staff organization has the presentation output-format switch on and the presentation conversion switch on (row: existing HTML conversion with a native template attached). The message attaches the Schoolhouse presentation template with a saved `PPTX` output preference and asks to convert an inline existing HTML deck to PPTX without regenerating it.
- When: The member sends the message, the Runner reads the execution input, the member sends the same message again while the Run is active, and the Runner fetches it via `GET /api/runners/runs/:runId/steerable-inputs/next`.
- Then: The execution prompt contains the request and the preference. Both the startup inline template section and the active input contain `Output format: PPTX`, `okou resource pull template:pptx-schoolhouse-runbook`, the `okou generate presentation --format <html|pptx> --template template:html-ppt-schoolhouse` command, `The replacement packet supersedes all remaining instructions here.`, and `For a new deck with resolved PPTX output, author an editable native PPTX`. The active input carries the new event ID. The Agent Tools section contains the `- Presentation output:` policy exactly once. The Run token has `presentation-convert:write` and the tools section includes `For an existing HTML deck, convert that file without regenerating it` and `okou presentation convert --input <deck.html> --out <deck.pptx> --verify`.

## run-lifecycle-runner-context.bdd-017

- Vitest: "RUN-01: agent runner context, queue promotion, and skills > includes batch permission approval guidance for the run"
- Mode: run
- Given: An entitled member.
- When: The member starts a chat Run and the Runner reads the execution input.
- Then: The system prompt includes `okou connector permission-request --batch-file <path>`, says a single batch approval may carry one `--callback-prompt <prompt>`, and says not to use callbacks when additional connector connections are needed.

## run-lifecycle-runner-context.bdd-018

- Vitest: "RUN-01: agent runner context, queue promotion, and skills > mounts the caller's private workflow over same-slug visible workflows"
- Mode: run
- Given: An entitled member on the native Runner route in a provisioned workspace has a public workflow and a private workflow with the same name; a colleague has a private workflow with that name too.
- When: The member starts a chat Run and the Runner reads the execution input.
- Then: Exactly one skill is mounted at `/home/user/.claude/skills/<name>`, and its `SKILL.md` contains the member's private workflow instruction.

## run-lifecycle-runner-context.bdd-019

- Vitest: "RUN-01: agent runner context, queue promotion, and skills > keeps the standard disallowed tools with callback guidance"
- Mode: run
- Given: An entitled member.
- When: The member starts a chat Run and the Runner reads the execution input.
- Then: The disallowed tools are exactly the standard set, and the system prompt mentions checking `okou data tools` for a page extraction tool, `okou data tools --family web-search`, and `--callback-prompt`. The Run becomes `cancelled` after cancellation.

## run-lifecycle-runner-context.bdd-020

- Vitest: "RUN-01: agent runner context, queue promotion, and skills > mounts workflows for Claude Code agents"
- Mode: run
- Given: An entitled member on the native Runner route in a provisioned workspace has created workflow `bdd-claude-kit`.
- When: The member starts a chat Run and the Runner reads the execution input.
- Then: The Run uses the `claude-code` agent and mounts the workflow at `/home/user/.claude/skills/bdd-claude-kit`. The Run becomes `cancelled` after cancellation.
