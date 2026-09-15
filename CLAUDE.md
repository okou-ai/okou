# Project Guidelines

`AGENTS.md` links to this file. Keep shared instructions here and load detailed
guidance only for the surface being changed.

## Project Boundaries

- API endpoints belong in `turbo/apps/api` (Hono,
  `src/signals/routes/`). Browser clients call the canonical API service.
  Frontend apps must not add API handlers or thin proxy handlers. If a frontend
  origin must expose `/api/*` for webhooks or OAuth, route it in that frontend's
  deployment layer while keeping the handler in the API service.
- Frontend, API, Runner, and persisted data can span versions. Read
  [deployment compatibility](docs/deployment-compatibility.md) before changing
  their boundaries; cover the relevant old/new combinations.
- Reference authority follows the entity's owner, even when its ID is stored
  locally. Expected external misses mean unavailable; unresolved references
  must never grant access. Do not disguise dependency failures or broken local
  invariants as missing external entities. See
  [externally managed references](docs/externally-managed-references.md).
- Implement the requested behavior with the smallest necessary abstraction.
  Preserve meaningful error recovery, cleanup, permission checks, and active
  compatibility contracts when removing unused code.
- Keep TypeScript type safe: no `any` or lint/type suppression comments. Use
  static production imports and fix violations at their source. See
  [code quality](docs/bad-smell.md) for the project's specific boundaries.
- Write repository artifacts, comments, commits, issues, and PRs in English.
  Use the user's preferred language in direct conversation.

## Task Routing

Use [the documentation index](docs/docs.md) to select relevant guidance.

| Changed surface                            | Read                                                                                                        |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| Tests or test failures                     | [Testing](docs/testing.md), then the matching application guide                                             |
| React, signals, async ownership            | [ccstate](.claude/skills/ccstate/SKILL.md), [effects](docs/effect.md), [cache](docs/cache.md) as applicable |
| App or shared UI styling                   | [Styles and integrated visual verification](docs/styles.md)                                                 |
| Database schema or queries                 | [Database development](.claude/skills/database-development/SKILL.md)                                        |
| New user-facing features or switch changes | [Feature switches](.claude/skills/feature-switch/SKILL.md)                                                  |
| CLI commands                               | [CLI design](.claude/skills/cli-design/SKILL.md)                                                            |
| Fallbacks or compatibility removal         | [Fallbacks](docs/fallback.md)                                                                               |
| Persistent or optimistic events            | [Event sourcing](docs/event-sourcing.md)                                                                    |
| PR review                                  | [Review instructions](REVIEW.md)                                                                            |

Business UI uses Tailwind utilities and shared semantic tokens. First-party
selectors, CSS modules, runtime stylesheets, and CSS-in-JS are prohibited in
Platform and UI. Exact global/third-party exceptions belong in
`turbo/style-allowlist.json`; the legacy baseline only shrinks. Read the styles
guide before changing either boundary.

## Development and Verification

- Start from a current `main` and inspect the worktree before editing. Diagnose
  failures from logs and a relevant baseline; a branch name does not establish
  that its code or environment is healthy.
- Use [CONTRIBUTING.md](CONTRIBUTING.md) for environment setup and local URLs.
  `scripts/prepare.sh` installs dependencies, syncs environment, migrates, and
  seeds local data; run it when that setup is needed, not for every task.
- Select checks from changed files and their consumers. Use affected-workspace
  formatting, lint, types, Knip, and tests for TypeScript; affected-crate checks
  for Rust; the locked addon environment for Python. Documentation requires its
  formatter, links, and any actual consumers, not unrelated language suites.
- Expand verification for shared configuration, generated outputs, deployment
  tooling, or cross-language contracts. Commands and test boundaries are in
  [Testing](docs/testing.md) and its surface guides.
- Run heavy checks sequentially and await their results. Use one Vitest process
  at a time, prefer package scope, and cap an explicitly needed full run at four
  workers. Do not increase timeouts to hide local resource contention.
- After applicable checks pass, repeat or broaden them only for new changes,
  failures, or unresolved risks. `lefthook.yml` selects staged-file checks and
  does not replace behavior verification.
- Follow [commitlint.config.mjs](commitlint.config.mjs) for commit format; use
  [the commit skill](.claude/skills/commit/SKILL.md) for scope and release guidance.

## CI and Merge

- Required CI checks must pass before merging. Cancelled checks do not pass.
  Never skip tests, weaken checks, or bypass protection to obtain a green build.
- After three failures of the same CI job, stop blind reruns, inspect logs, and
  investigate the changed files and their consumers.
- GitHub Actions container steps default to `sh`. Set `shell: bash` (or job
  defaults) for Bash syntax and sourced Bash helpers; a sourced shebang does
  not select the caller's shell.
