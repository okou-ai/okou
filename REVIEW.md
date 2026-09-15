# PR Review Instructions

Review the requested PR against current repository practices and post findings
anchored to the inspected HEAD. When the caller explicitly requests pr-auto
marker-comment mode, use the full normal PR comment described below instead.

## Identify the Revision

1. Resolve `$ARGUMENTS` from a PR URL or number; if empty, look up the PR for the
   current branch. Use the resolved PR number literally in subsequent commands.
2. Read the title, body, author, URL, `headRefName`, and full `headRefOid`:

   ```bash
   gh pr view <PR_NUMBER> --repo vm0-ai/vm0 --json title,body,author,url,headRefName,headRefOid
   gh pr diff <PR_NUMBER> --repo vm0-ai/vm0
   ```

3. Read the complete diff and relevant callers, tests, and contracts. Distinguish
   introduced defects from unchanged code and unsupported possibilities.
4. Fetch practice documents from `main`, recording the practice revision. Start
   with [the documentation index](docs/docs.md) and read the matching documents
   below. Read-only documentation changes need their actual links and consumers,
   not every implementation guide.

## Select Practices by Behavior

A contents API read can fetch a guide at the recorded practice SHA:

```bash
gh api 'repos/vm0-ai/vm0/contents/docs/docs.md?ref=<PRACTICE_SHA>' --jq '.content' | base64 -d
```

| Changed behavior                                                              | Guidance                                                                                                           |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Production logic                                                              | [Code quality](docs/bad-smell.md) and [testing](docs/testing.md)                                                   |
| Tests or coverage decisions                                                   | [Testing](docs/testing.md), then the matching surface guide                                                        |
| Fallbacks, defaults, removed paths, or rollout switches                       | [Fallbacks](docs/fallback.md)                                                                                      |
| Persistent/optimistic events and reconciliation                               | [Event sourcing](docs/event-sourcing.md)                                                                           |
| React, signals, caches, refs, or async ownership                              | [ccstate router](.claude/skills/ccstate/SKILL.md), [effects](docs/effect.md), [cache](docs/cache.md) as applicable |
| API signals or HTTP client handling                                           | Relevant ccstate reactive, command, lifecycle, or HTTP references; React/DOM only if affected                      |
| Requests, protocols, queue payloads, schema, persisted state, service workers | [Deployment compatibility](docs/deployment-compatibility.md)                                                       |
| Database schema, raw results, SQL rewrites                                    | [Database development](.claude/skills/database-development/SKILL.md)                                               |
| New user-facing behavior and containment                                      | [Feature switches](.claude/skills/feature-switch/SKILL.md)                                                         |
| External identifiers and reference resolution                                 | [Externally managed references](docs/externally-managed-references.md)                                             |
| App styling                                                                   | [Styles](docs/styles.md)                                                                                           |
| Chat-card recognition, registration, or rendering                             | [Chat cards](docs/chat-cards.md)                                                                                   |
| Runner build, release, deploy, architecture selection, or rollback            | [Runner architectures](docs/runner-multi-architecture.md)                                                          |
| React performance claims or subscription equality                             | [React measurements](docs/react-commit.md)                                                                         |

For changed tests, follow the surface routes in [Testing](docs/testing.md).
API and Platform tests must also follow [external behavior](docs/testing/testing-external-behavior.md).
Reading an index or skill router does not replace reading the selected reference.
Do not load unrelated references merely because they share a parent directory.

## Review Gates

### Correctness, Security, and Coverage

- Trace changed behavior through its real entry point and consumers. Check
  races, cancellation, ordering, auth, permissions, serialization, and failure
  outcomes where relevant.
- Require meaningful coverage for new behavior and regression fixes; confirm
  existing coverage still protects refactors. Identify the missing scenario,
  rather than requiring a new test solely from a commit prefix or filename.
- Tests should verify externally observable state or HTTP responses a production
  caller can obtain. Internal state and mock calls are not substitutes. Use the
  surface guide for external mocks, real infrastructure, and centralized cleanup.
- API tests that assert log output require `Changes Requested`, outside the
  logger's own suite and one redaction check; other surfaces may assert a log
  record that is their own documented contract. A PR that answers a log-noise
  issue by adding another outcome classifier must justify why the record is
  needed at all.
- For features that change, replace, remove, or reroute an existing flow, require
  regression coverage for the affected path and appropriate feature/capability/
  permission containment. A rewritten expectation alone does not prove an
  intentional, correctly scoped replacement.
- Apply ccstate ownership rules to both API and Platform where used. Preserve
  callback-ref cleanup, await/signal ownership, and real page initialization.
- Report concrete practice violations with the rule and source location. Do not
  infer a bug from function length, a search match, or a generic preference.

### Persisted Data and Compatibility

- Review schema, API contracts, response validation, and `jsonb(...).$type<...>()`
  together. For JSONB shape changes that old rows could violate, require a
  migration/backfill, a valid read boundary, or a supported no-migration rationale.
- Missing coverage for response-validated persisted changes requires
  `Changes Requested`. Check both old code after migration and new code before
  migration using the compatibility guide.
- Use the documented exposure window for the affected surface. Do not size a
  compatibility window from nominal pipeline duration or assume all components
  deploy together.

### Fallbacks and Optimistic Events

[Fallbacks](docs/fallback.md) owns the full criteria and severity rules:

- Reject defaults for states prevented by the owning type/schema or writer,
  fabricated values for corrupt rows, and readers for retired producers.
- A non-GA feature switch has no external users. Do not require compatibility,
  dual reads/writes, or rollback handling solely for its cutover.
- Every new fallback must be declared in a `Fallbacks` PR-body section. Missing
  declarations are P1 findings and require `Changes Requested`.
- A rollout fallback must name its surface, observed exposure window, removal
  condition, and follow-up issue or PR. Check those details against
  [deployment compatibility](docs/deployment-compatibility.md).
- Removing a fallback requires evidence such as a type/schema guarantee, writer
  ownership, production data, or a closed rollback window. Remove its branch,
  contract entry, and tests together; removal needs no fallback declaration.
- Flag negative tests that only pin retired behavior as still absent. Preserve
  rejection tests when fail-closed security is the actual product behavior.
- Persistent events reconcile optimistic events by shared ID. Do not require
  failure rollback, timeout removal, or other cleanup of optimistic projections
  contrary to [event sourcing](docs/event-sourcing.md).

## Findings and Verdict

Start the review body with `LGTM` or `Changes Requested`. Include:

- **Summary:** what the change does, in one to three sentences.
- **Findings:** concrete defects with priority, file/line, trigger, consequence,
  and supporting practice or evidence. Omit empty priority sections.
- **Testing:** coverage, conventions, verification observed, and material gaps.

When the diff introduces fallbacks, add **Fallbacks** before Testing. List every
new fallback with its surface, window, removal condition, declaration status,
and justified/not-justified verdict. Omit this section when none is introduced.

Use `Changes Requested` for P0/P1 blockers, missing required behavior coverage,
or undeclared new fallbacks. Use `LGTM` when no blockers remain. Separate
non-blocking observations and unverified concerns from demonstrated defects.

## Post Against the Inspected HEAD

Write the exact Markdown to a temporary body file. Before posting, re-read
`headRefOid`; if it changed, inspect the delta and update the review before
publishing. Never label a review of an old revision as covering the new one.

For a normal review, send a structured Reviews API request containing the
inspected `commit_id`, `body`, and `event` (`APPROVE` or `REQUEST_CHANGES`). Use
`COMMENT` when GitHub prohibits approving or requesting changes on one's own
PR, retaining the verdict and findings in the body. This keeps the review
anchored to the inspected commit even if another push races the final read.

For caller-requested pr-auto marker-comment mode:

- Post the complete review with `gh pr comment <PR_NUMBER> --repo vm0-ai/vm0
--body-file <REVIEW_BODY_FILE>`.
- Keep the verdict on the first line and the caller-provided marker lines near
  the top of the same comment; retain all findings and conditional fallbacks.
- Include the inspected HEAD in the body. A normal comment has no review-commit
  binding, so its stated revision is required evidence.

Return the PR URL, inspected SHA, verdict, and posted review/comment URL. Review
completion is not CI success, merge, deployment, or authorization to bypass
repository protection.
