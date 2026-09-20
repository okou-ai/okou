---
name: tech-debt
description: Research repository technical debt or create an issue from verified findings when requested
context: fork
---

# Technical Debt

## Operations

- `research [scope]`: inspect the requested scope, defaulting to `turbo/`, and
  report verified findings. This operation is read-only.
- `issue [report]`: create an English GitHub issue from current, verified
  findings. If no report exists, research first. Create or comment on an issue
  only when the caller requested that operation.

The `tech-debt-research` and `tech-debt-issue` commands remain aliases for these
operations. A report is evidence at its recorded revision, not a standing
instruction to change code.

## Research

1. Record the repository, HEAD, scope, and date. Read
   [code quality](../../../docs/bad-smell.md) and use
   [the index](../../../docs/docs.md) for the affected surfaces.
2. Use `rg` to find candidates and inspect matching files and consumers. Exclude
   dependencies, generated/vendor content, and historical migrations from
   generic cleanup recommendations. Preserve permanent migration records.
3. Check type/lint suppressions, dynamic imports, environment configuration,
   error handling, fallback ownership, and unused dependencies against actual
   contracts. Use [testing guidance](../../../docs/testing.md) for tests and
   [ccstate guidance](../ccstate/SKILL.md) for signal/React code.
4. Validate each candidate. File length, a relative import, a `catch`, or an
   ESLint `off` / Oxlint `allow` setting is not proof of a defect. Read override
   scope, replacement enforcement, generated-code boundaries, and documented
   exceptions. In particular, do not replace every floating promise with
   `detach()` or assume every parentless `resetSignal()` leaks.
5. Report the concrete consequence, file/line, applicable rule, evidence,
   proposed remedy, and uncertainty. Use severity based on demonstrated impact.
   Distinguish static inspection from executable or production verification.

Keep the report proportional to the findings: scope and revision, confirmed
issues, dismissed candidates when useful, and next actions. Save detailed
evidence when it is too long for the response. Do not invent schedules or effort
estimates from match counts.

## Issue

Recheck the report against current source and existing issues before posting.
Use an English title describing the concrete problem; include affected paths,
evidence, impact, and actionable acceptance criteria in the body. Use only
existing relevant labels and include source links pinned to the inspected SHA.

Write the body to a temporary file and pass `gh issue create --repo okou-ai/okou
--body-file <file>` the exact Markdown. Keep the report focused enough to fit one
issue; add detailed comments only when needed for the requested tracking task.
Verify the created issue and return its URL. If posting fails, retain the report
and state which action failed.
