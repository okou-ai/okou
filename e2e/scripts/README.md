# Runner WSS protocol acceptance

`tests/03-runner/run-t25-run-wss.bats` calls `scripts/runner-wss.ts` in the normal
captured-source Runner E2E lane. The case uses the existing prepared mock-Codex
CLI credential, API origin and model. It launches no browser and requires no
App origin, Web login or additional Clerk credential.

The Node client verifies the public Run/Runner target, normal TLS certificate
and hostname validation, first-frame ticket admission, schema/category hello,
bounded echo, nested reverse echo, one-way notices and consumed-ticket rejection
before expiry. A public output checkpoint
establishes that the owned Guest is live before ticket admission. After rejected replay it
checks that the admitted stream still serves diagnostics. Public APIs create one uniquely
owned live Run and cancel/delete only its Run/thread/agent resources. Every
socket and deadline is owned; output excludes credentials, payloads and raw
request errors.

From `e2e`:

```bash
pnpm install --frozen-lockfile
pnpm check-types
pnpm exec tsx --test scripts/runner-wss.test.ts
```

Controlled peers cover protocol failures and cleanup. The deployed case supplies
public certificate and actual Guest evidence. Browser/CORS/Web adapter behavior,
completion/revocation, renewal, HTTP/2/3 and load/latency remain separate coverage.
The probe imports the canonical Zod operation/envelope contracts through the
declared `@okouai/api-contracts` package dependency and its public exports.
The E2E lockfile owns the captured local packages and their runtime dependencies.
This script directory uses ESM to consume the contracts' public imports.
Echo inputs span zero through 16 KiB of decoded bytes; 64 KiB opaque transport framing remains
covered by the transport owner tests, independently of application JSON.

The owned fixture also supplies a 70,003-byte binary file and an empty file.
The unified fs v3 probe checks directory listing and reads arbitrary
offsets through a bounded window, validates exact bytes and SHA-256, checks the
64 KiB prefix boundary and independent complete selection, and verifies explicit
finish/close rejection of released handles. One reader is deliberately abandoned
to connection teardown. Mismatched fs versions reject both listing and reads.
Both sides must advertise fs v3; a stale client must refresh, without a legacy fallback.
Actual pinned-kernel containment, sparse offsets beyond 4 GiB, mutation and
park/reuse retirement also run in the native amd64/ARM64 Guest suite.
