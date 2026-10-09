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

The narrow exception is a next-line waiver disabling only
`api/no-db-transaction`: a registered legacy ID or a reviewed necessary
billing invariant and single-statement justification. The independent CI scan
must validate it under [database transaction lint](api/database.md#transaction-lint).
This does not permit unrelated suppressions or inventory expansion.

## 3. Error Handling

Catch errors only at a boundary that meaningfully handles them. Remove redundant
log-and-rethrow wrappers and fabricated defaults that hide a broken invariant.
Preserve resource cleanup, domain-error responses, legitimate retry/recovery,
best-effort operation ownership, per-item failure isolation, and security checks.

Do not add code whose only output is a log level. A fix for a noisy record first
considers deleting the record; a new outcome classifier is a smell.

### Externally Managed References

An externally managed reference is an identifier held by one component while
another authority owns the referenced entity's identity and lifecycle. The
consumer cannot guarantee that the entity still exists, remains visible, or is
usable when the reference is resolved.

The boundary is defined by authority, not transport or storage:

- A provider-issued account ID is externally managed even when it is persisted
  in our database; an application-generated ID for a locally owned account row
  is not.
- A built-in connector slug is externally managed by the accepted connector
  catalog even when a local row contains the slug.
- A request body is external input, but it is not necessarily an externally
  managed reference.
- A record owned by the current service is internal even if another service
  originally supplied some of its fields.

Storing or caching a reference does not transfer ownership of the referenced
entity to the consumer.

#### Classify the Boundary Before Handling Failure

"External data" is too broad to imply one failure behavior. Classify the value
or operation before deciding whether to reject, continue, or fail:

| Category                     | Example                                                    | Expected behavior                                                                                           |
| ---------------------------- | ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Untrusted input              | API body, webhook payload                                  | Validate against the input contract; reject or quarantine invalid input as that contract requires.          |
| Externally managed reference | Stored provider resource ID or connector catalog slug      | Resolve against the current authority; an entity that no longer resolves is unavailable.                    |
| Required remote operation    | Provider API call needed to complete a request             | Surface or retry its failure according to the operation contract; do not report every failure as not found. |
| Local invariant              | Locally owned row shape, foreign key, or internal protocol | Let violations fail so corruption and programming errors remain visible.                                    |

These categories can meet at one boundary. For example, an API may first
validate the syntax of a connector slug supplied by a caller and then resolve
that well-formed reference against the current connector catalog. Invalid
syntax and a missing catalog entry are different results.

#### Resolution Rule

Code that consumes an externally managed reference must represent an expected
resolution miss as a normal domain result such as `not_found`, `unavailable`,
or `undefined`. The absence of that one entity must not, by itself, turn an
otherwise valid list, read, or execution into an internal server error.

- A collection omits an entity that no longer resolves and continues with
  valid siblings.
- A direct lookup returns the domain's normal missing or unsupported result.
- An optional capability proceeds without that entity when the product
  contract permits it.
- A required capability may stop with its specific unavailable result; the
  reference rule does not make every dependency optional.

Do not silently reinterpret or substitute an identity. A missing reference is
not permission to select a similarly named entity or a different account.
Product-defined preference resolution, such as falling back from a deleted
preferred account to the current default, must be explicit and independently
authorized.

#### Representation Versus Existence

Validate representation and resolve existence separately:

1. Parse an untrusted or deliberately raw stored value into its identifier
   type.
2. Resolve the typed identifier against the authority that owns the entity.
3. Treat only the authority's expected missing, removed, hidden, revoked, or
   incompatible result as unavailable.

A parser such as `safeParse` proves only that a value has the right shape. It
does not prove that the referenced entity exists. Conversely, do not convert a
database failure or a violated local storage contract into an external
resolution miss. If the local schema promises that a persisted value is a
valid typed identifier, a malformed stored value is a local invariant failure,
not ordinary catalog churn.

#### Security Must Fail Closed

An unresolved external reference must grant nothing. Validate identity,
current existence, and authorization before granting capabilities,
credentials, targets, or ownership. Continuing without an unavailable entity
is safe only when the remaining behavior was already authorized.

For example, a removed connector catalog entry cannot be converted into a
custom connector or allowed to expand an agent's connector scope.

#### Error Boundaries and Observability

Handle only the authority's explicit resolution outcomes. Let unrelated
failures propagate, including:

- database connectivity and transaction failures;
- programmer errors and broken internal contracts;
- impossible states protected by local schema constraints;
- remote failures that prevent the authority from answering whether an entity
  exists, unless the product defines a specific cached or degraded mode.

Do not wrap an entire route or workflow in `try/catch` and call every exception
"unavailable." Record enough structured context to diagnose a stale or invalid
reference, without logging credentials, tokens, or sensitive provider data.

#### Testing

Test the behavior at a real API, CLI, or runtime entry point:

- use a well-formed reference to an entity that the authority no longer
  exposes;
- verify the normal unavailable result rather than a 500;
- verify valid siblings still work where the operation is a collection;
- verify the missing entity grants no capability or credential;
- separately test malformed caller input and local invariant failures according
  to their own contracts.

#### Relationship to Fallbacks

Returning an unavailable result for a missing externally managed entity is
normal reference resolution, not rolling-deployment compatibility. Any action
taken after that result, such as choosing a default account or using cached
data, is a separate fallback decision and must satisfy
[Fallbacks to avoid](./fallback.md).

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
