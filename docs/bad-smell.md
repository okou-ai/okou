# Bad Code Smells

Project-specific production-code rules. For tests, use
[Testing](testing.md); for a PR review, use [REVIEW.md](../REVIEW.md).

## 1. TypeScript `any` Type

Do not use `any`. Preserve inference where available and use `unknown` with
validation or narrowing at an untrusted boundary. Assertions must not replace
runtime validation or database decoding.

## 2. Lint/Type Suppressions

Do not add suppression comments (`eslint-disable`, `oxlint-disable`,
`@ts-ignore`, `@ts-nocheck`, `@ts-expect-error`, or `prettier-ignore`) or
`eslint-plugin-only-warn`. Fix the underlying violation. Do not weaken rules to
make a change pass. Assess existing configuration overrides in their actual
scope and with their documented replacement enforcement.

## 3. Error Handling

Catch errors only at a boundary that meaningfully handles them. Remove redundant
log-and-rethrow wrappers and fabricated defaults that hide a broken invariant.
Preserve resource cleanup, domain-error responses, legitimate retry/recovery,
best-effort operation ownership, per-item failure isolation, and security checks.

Do not add code whose only output is a log level. A fix for a noisy record first
considers deleting the record; a new outcome classifier is a smell.

Reference ownership follows the referenced entity's authority. An expected
external miss is different from invalid input, a failed required operation, or
a violated local invariant. Follow [externally managed references](externally-managed-references.md)
and never let an unresolved reference grant capabilities or credentials.

## 4. Interface Changes

Document changed public contracts and assess their consumers. Independent
frontend, API, Runner, and database deployments require the old/new combinations
in [deployment compatibility](deployment-compatibility.md). A TypeScript type
change alone does not migrate stored data or already-running clients.

## 5. Dynamic Imports

Use static imports in production code. Optional development dependencies and
framework-owned route splitting need an actual justified boundary; a generic
claim about performance does not justify a new dynamic import. Prefer static
imports in test utilities as well.

## 6. Hardcoded URLs and Configuration

Use centralized `env()` configuration for environment-specific values and
service origins. Do not invent fallback URLs or credentials. Server code should
not read `NEXT_PUBLIC_` variables as its configuration contract.

## 7. Fallback Patterns

The default is no fallback for a state that the owning contract already rules
out. [Fallbacks](fallback.md) defines when removal is justified and when an
explicitly bounded rollout fallback is required. Follow that document for PR
fallback declarations, removal evidence, and tests for retired paths.

These rules do not authorize removing meaningful recovery, fail-closed security,
or expected external-reference handling described above. Determine the owner,
failure class, and observable consequence before deleting a branch.
