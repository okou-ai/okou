---
name: code-quality
description: Review changes or remove redundant error handling with evidence of preserved behavior
context: fork
---

# Code Quality

## Operations

- `review <pr-id|commit-range|description>`: review the identified change. For a
  PR, follow [REVIEW.md](../../../REVIEW.md); it owns practice routing, evidence,
  verdicts, and posting. For a commit range, apply the same relevant practices
  and report findings to the caller without inventing a PR destination.
- `cleanup [scope]`: implement removal of redundant error handling in the
  requested scope. The existing `defensive-code-cleanup` command routes here.

Read [code quality](../../../docs/bad-smell.md) and select additional guidance
from [the documentation index](../../../docs/docs.md). Searches identify
candidates; inspect actual behavior before reporting a violation.

## Error-Handling Cleanup

Search the requested source for catches that only log and rethrow, fabricate a
generic success/empty result, or duplicate a framework-owned error response.
For an unbounded cleanup request, select up to ten related, justified removals.

Before removing each catch, trace its caller and owning error boundary. Establish
what the caller observes after removal and why the existing handler is redundant.
Do not remove:

- meaningful rollback, resource cleanup, retry, or recovery;
- domain-error conversion to a contractual HTTP response;
- explicitly owned best-effort operations or per-item failure isolation;
- authentication, permission, or other fail-closed security handling;
- required cross-version behavior or expected external-reference misses.

Apply [fallback rules](../../../docs/fallback.md),
[deployment compatibility](../../../docs/deployment-compatibility.md), and
[reference authority](../../../docs/bad-smell.md#externally-managed-references) when those
boundaries are involved. A catch containing only a log is not automatically
redundant: verify whether it owns necessary diagnostics or rejection handling.

Remove unused imports and adjust callers only when the preserved contract
requires it. Keep async work attached to its owning cancellation signal;
`detach()` is not a replacement for error handling inside signals.

## Completion

Show each finding or removal with its file, behavior, and evidence. Do not assign
severity from a regex match or file length alone. Run checks for the changed
scope and relevant consumers under [project verification](../../../CLAUDE.md#development-and-verification).
Report remaining uncertainty explicitly. Create a PR when the caller requested
one; a research or review request alone does not authorize implementation.
