# Browser transport acceptance

The WSS baseline runs from `tests/03-runner/run-t25-run-wss.bats` in the normal
Runner E2E pipeline. It consumes the captured checkout, prepared mock-Codex
profile and actual API/App preview origins; it has no local deployed setup.

The runner shard installs the matching Playwright Chromium only when it contains
that BATS file. Its browser signs into the prepared Clerk TEST account and runs
the production core transport. Owner bootstrap uses the Web session; public
agent/chat/Run setup and cleanup use the same account's existing device-flow
credential so cleanup survives browser loss. No private fixture route or new
model credential is created.

Finite native work supplies the normal-completion window; a separate owned Run
is cancelled through the public API. The probe checks ordered opaque binary
echoes, still-valid ticket replay and access loss after termination. It uses
normal certificate validation and reports only fixed verdicts, public identities,
statuses and frame sizes. Cleanup closes sockets/browser and cancels/deletes
owned Run/thread/agent resources. Failure diagnostics exclude credentials,
headers, raw provider errors and frame contents.

## Controlled helper checks

From `e2e`, after the locked dependency/browser install:

```bash
pnpm check-types
pnpm exec tsx --test playwright/lib/run-wss-probe.test.ts
```

An explicitly installed local browser can be selected with
`WSS_TEST_CHROMIUM_PATH=/path/to/chromium`. CI uses the default browser installed
by the pinned Playwright dependency. Controlled self-signed peers test probe
honesty, lifecycle and cleanup; they do not establish public certificate or
real Guest acceptance. The deployed baseline does not qualify renewal,
HTTP/2/3, load capacity or normal chat adoption.
