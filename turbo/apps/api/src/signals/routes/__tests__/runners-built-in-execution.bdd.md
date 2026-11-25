# runners-built-in-execution

## runners-built-in-execution-001

- Vitest: "Runner built-in and personal dispatch > dispatches managed Auto placeholders and resolves only the Run-owned credential"
- Mode: run
- Given: A signed-in member launches a managed Auto Run from Web while KMS is unavailable during startup.
- When: The assigned Runner reads execution, then callers try heartbeat and credential resolution with the issued credential types and incompatible model-account references. The owner reads the Run and cancels it.
- Then: Dispatch uses Pi with the managed OpenRouter preset, the Web integration, the OpenRouter Codex billing policy, a 100,001 token usage threshold and an OpenAI environment placeholder. Startup makes zero KMS calls and exposes no managed key. Heartbeat rejects the network-boundary credential. Resolution rejects execution and sandbox credentials with 401 and rejects incompatible references with HTTP 424. The correct boundary receives the managed bearer with secret name and expiry. The owner sees the running built-in Auto source without the boundary token. After cancellation the boundary returns HTTP 403.

## runners-built-in-execution-002

- Vitest: "Runner built-in and personal dispatch > keeps Auto on the managed Pi preset when Codex execution is enabled"
- Mode: run
- Given: A workspace owner enables the Codex execution flag and starts an Auto Run.
- When: The assigned Runner reads execution and the owner reads Run state.
- Then: The Runner still receives Pi with the managed OpenRouter preset. Readback reports a running built-in Auto Run.

## runners-built-in-execution-003

- Vitest: "Runner built-in and personal dispatch > dispatches a captured personal Pi subscription without built-in billing"
- Mode: run
- Given: A signed-in owner has connected a personal Codex subscription and starts a Luna Run.
- When: The Runner reads execution, the owner reads the Run, and the specialized boundary requests the captured personal credential and a managed OpenRouter credential separately.
- Then: Dispatch uses Pi with Luna, xhigh effort, no billable firewall and a zero long-context threshold. Readback stays running with the personal Codex OAuth source. The boundary returns HTTP 200 and the bound ChatGPT access credential, whereas the managed secret request returns HTTP 424 with `CONNECTOR_NOT_CONFIGURED`.
