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
